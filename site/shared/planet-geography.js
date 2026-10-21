/* PlanetGeography — боевые поля планеты и C100-soft (Этап 4).
   =========================================================================
   Модуль замораживает первый боевой контракт географии поверх
   goldberg-gp-v1:

     noise_version      = planet-noise-simplex3d-v1
     geography_version  = c100-soft-v1
     preset_version     = planet-presets-v1 (значения задаёт профиль)

   Что считается здесь, а не в рендере:
     - непрерывные поля по направлению на сфере: высота, влажность,
       базовая температура, тектоническая близость, вулканизм и деталь;
     - на сетке: уровень моря по площадно-взвешенному процентилю, мягкие
       веса суша/шельф/океан, расстояние до берега в ячейках, плиты,
       континентальные идентичности C100 с топ-2 принадлежностью и
       энтропией, океанические бассейны и физические массивы суши.

   Гидрология, реки и биомные смеси сюда не входят — это Этап 5. Поля и
   идентичности Этапа 4 являются для него входом.

   SEED-КОНТРАКТ
     master_seed_hex — ровно 16 hex-цифр unsigned 64-bit. Он делится на
     hi/lo uint32 (первые/последние 8 цифр). Подseed домена:
       xxHash32( UTF8("planet-noise-simplex3d-v1") || 0x00 ||
                 UTF8(domain) || 0x00 || hiLE || loLE, seed=0 )
     Базовый шум — существующая детерминированная 3D simplex-реализация из
     PlanetNoise.makeNoise('simplex', subseed). Value noise спайка в боевой
     географии не используется.

   МАСШТАБЫ
     Плиты сэмплируются в планетарной частоте и почти не зависят от радиуса.
     Высота/берег/деталь/вулканизм — в физической частоте: при росте радиуса
     частота по единичному направлению растёт пропорционально R, поэтому
     характерный размер структур в км сохраняется. Климатические аномалии
     используют смешанный масштаб sqrt(R/Rearth).

   API
     PlanetGeography.createFieldSampler(profile)
       sampler.sampleFields(x, y, z, out6)
     PlanetGeography.generateGeography(grid, profile, options?)
     PlanetGeography.generateGeographyAsync(grid, profile, options?)
       options: { chunkCells, onProgress(stage, fraction), yieldControl }
     PlanetGeography.validateGeography(grid, geography)
     PlanetGeography.listTransferableBuffers(geography)
     PlanetGeography.packGeographyForTransfer(geography)

   Профиль принимает camelCase и snake_case имена колонок planet_generation.
   В браузере модуль вешает window.PlanetGeography и требует PlanetNoise
   перед собой; в Node сам подтягивает ./planet-noise.js. */
(function (root) {
  'use strict';
  /* global module, require */

  var PlanetNoise = root.PlanetNoise ||
    (typeof module !== 'undefined' && module.exports ? require('./planet-noise.js') : null);
  if (!PlanetNoise) throw new Error('PlanetGeography: PlanetNoise должен быть подключён раньше');

  var GRID_VERSION = 'goldberg-gp-v1';
  var NOISE_VERSION = 'planet-noise-simplex3d-v1';
  var GEOGRAPHY_VERSION = 'c100-soft-v1';
  var PRESET_VERSION = 'planet-presets-v1';
  var SURFACE_CLASSES = ['terrestrial', 'ocean', 'desert', 'ice', 'volcanic',
    'barren', 'gas_giant', 'no_surface'];
  var EARTH_RADIUS_KM = 6371;
  var EARTH_CANONICAL_V = 128;
  var PLATE_COUNT = 7;
  // Профильная continent_variation задаёт целевой разброс уже эффективных
  // масс. Барьеры и bias-балансировка частично регрессируют распределение
  // к среднему даже при desired-aware расстановке семян, поэтому внутренний
  // набор желаемых масс строится шире. Коэффициент выбран по ансамблям
  // v=128 так, чтобы earthlike_balanced при variation=0.8 давал фактическую
  // sigma эффективных масс около 0.8 без заметной доли пустых идентичностей.
  var CONTINENT_DESIRED_VARIATION_GAIN = 1.25;

  var FIELD_INDEX = {
    elevation: 0,
    moisture: 1,
    temperatureBase: 2,
    plateAffinity: 3,
    volcanism: 4,
    detail: 5
  };

  var ARRAY_FIELDS = [
    'elevation', 'moisture', 'temperature', 'plateAffinity', 'volcanism', 'detail',
    'muLand', 'muShelf', 'muOcean', 'signedCoastDistanceCells',
    'plateId', 'plateBoundary',
    'continentSupport', 'continentTop1Id', 'continentTop1Weight',
    'continentTop2Id', 'continentTop2Weight', 'continentEntropy',
    'oceanSupport', 'oceanBasinId', 'oceanBasinWeight', 'physicalLandmassId'
  ];

  var DEFAULT_PROFILE = {
    masterSeedHex: '0123456789abcdef',
    radiusKm: EARTH_RADIUS_KM,
    surfaceClass: 'terrestrial',
    presetId: 'earthlike_balanced',
    gridVersion: GRID_VERSION,
    noiseVersion: NOISE_VERSION,
    geographyVersion: GEOGRAPHY_VERSION,
    presetVersion: PRESET_VERSION,
    continentMeanCells: 400,
    continentVariation: 0.8,
    oceanBasinMeanCells: 6000,
    drainageMeanCells: 72,
    oceanPctl: 70,
    shelfBelowPctl: 67,
    shelfAbovePctl: 73,
    highlandLandPctl: 75,
    mountainLandPctl: 92,
    aridLandPctl: 25,
    wetLandPctl: 75,
    coldPctl: 20,
    hotPctl: 80,
    streamFlowPctl: 90,
    majorRiverFlowPctl: 99,
    coastSoftWidthCells: 3,
    continentSoftWidthCells: 4,
    biomeSoftWidthCells: 2,
    transitionEntropyPctl: 90
  };

  function clamp(x, lo, hi) {
    return x < lo ? lo : (x > hi ? hi : x);
  }
  function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }
  function smoothstep01(x) {
    var t = clamp01(x);
    return t * t * (3 - 2 * t);
  }
  function finiteOr(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
    var encoded = unescape(encodeURIComponent(text));
    var out = new Uint8Array(encoded.length);
    for (var i = 0; i < encoded.length; i++) out[i] = encoded.charCodeAt(i) & 0xff;
    return out;
  }

  function rotl32(x, r) {
    return ((x << r) | (x >>> (32 - r))) >>> 0;
  }

  var XX_P1 = 2654435761;
  var XX_P2 = 2246822519;
  var XX_P3 = 3266489917;
  var XX_P4 = 668265263;
  var XX_P5 = 374761393;

  function xxHash32(bytes, seed) {
    if (typeof bytes === 'string') bytes = utf8Bytes(bytes);
    seed = (seed || 0) >>> 0;
    var len = bytes.length;
    var p = 0;
    var h;
    function readU32(offset) {
      return (bytes[offset] | (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    }
    function round(acc, input) {
      acc = (acc + Math.imul(input, XX_P2)) >>> 0;
      acc = rotl32(acc, 13);
      return Math.imul(acc, XX_P1) >>> 0;
    }
    if (len >= 16) {
      var v1 = (seed + XX_P1 + XX_P2) >>> 0;
      var v2 = (seed + XX_P2) >>> 0;
      var v3 = seed >>> 0;
      var v4 = (seed - XX_P1) >>> 0;
      var limit = len - 16;
      while (p <= limit) {
        v1 = round(v1, readU32(p)); p += 4;
        v2 = round(v2, readU32(p)); p += 4;
        v3 = round(v3, readU32(p)); p += 4;
        v4 = round(v4, readU32(p)); p += 4;
      }
      h = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
    } else {
      h = (seed + XX_P5) >>> 0;
    }
    h = (h + len) >>> 0;
    while (p <= len - 4) {
      h = (h + Math.imul(readU32(p), XX_P3)) >>> 0;
      h = Math.imul(rotl32(h, 17), XX_P4) >>> 0;
      p += 4;
    }
    while (p < len) {
      h = (h + Math.imul(bytes[p], XX_P5)) >>> 0;
      h = Math.imul(rotl32(h, 11), XX_P1) >>> 0;
      p++;
    }
    h ^= h >>> 15;
    h = Math.imul(h, XX_P2) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, XX_P3) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  function hex32(value) {
    return ('00000000' + (value >>> 0).toString(16)).slice(-8);
  }

  function masterSeedHexFromText(text) {
    var value = String(text == null ? 'planet' : text);
    var hi = PlanetNoise.stringSeed(value);
    var lo = PlanetNoise.stringSeed(value + '\u0000' + GEOGRAPHY_VERSION);
    return hex32(hi) + hex32(lo);
  }

  function parseMasterSeedHex(masterSeedHex) {
    if (typeof masterSeedHex !== 'string' || !/^[0-9a-fA-F]{16}$/.test(masterSeedHex)) {
      throw new Error('PlanetGeography: masterSeedHex должен содержать ровно 16 hex-цифр');
    }
    return {
      hex: masterSeedHex.toLowerCase(),
      hi: parseInt(masterSeedHex.slice(0, 8), 16) >>> 0,
      lo: parseInt(masterSeedHex.slice(8, 16), 16) >>> 0
    };
  }

  function domainSeed(master, domain) {
    var prefix = utf8Bytes(NOISE_VERSION);
    var name = utf8Bytes(domain);
    var bytes = new Uint8Array(prefix.length + 1 + name.length + 1 + 8);
    bytes.set(prefix, 0);
    bytes[prefix.length] = 0;
    bytes.set(name, prefix.length + 1);
    var offset = prefix.length + 1 + name.length;
    bytes[offset] = 0;
    var view = new DataView(bytes.buffer);
    view.setUint32(offset + 1, master.hi, true);
    view.setUint32(offset + 5, master.lo, true);
    return xxHash32(bytes, 0);
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function profileValue(src, camel, snake, fallback) {
    if (src[camel] != null && src[camel] !== '') return src[camel];
    if (src[snake] != null && src[snake] !== '') return src[snake];
    return fallback;
  }

  function normalizeProfile(input) {
    var src = input || {};
    var masterSeedHex = profileValue(src, 'masterSeedHex', 'master_seed_hex', null);
    if (masterSeedHex == null) {
      masterSeedHex = src.seedText != null || src.seed_text != null
        ? masterSeedHexFromText(src.seedText != null ? src.seedText : src.seed_text)
        : DEFAULT_PROFILE.masterSeedHex;
    }
    var profile = {
      masterSeedHex: parseMasterSeedHex(String(masterSeedHex)).hex,
      radiusKm: finiteOr(profileValue(src, 'radiusKm', 'radius_km', DEFAULT_PROFILE.radiusKm), DEFAULT_PROFILE.radiusKm),
      surfaceClass: String(profileValue(src, 'surfaceClass', 'surface_class', DEFAULT_PROFILE.surfaceClass)),
      presetId: String(profileValue(src, 'presetId', 'preset_id', DEFAULT_PROFILE.presetId)),
      gridVersion: String(profileValue(src, 'gridVersion', 'grid_version', DEFAULT_PROFILE.gridVersion)),
      noiseVersion: String(profileValue(src, 'noiseVersion', 'noise_version', DEFAULT_PROFILE.noiseVersion)),
      geographyVersion: String(profileValue(src, 'geographyVersion', 'geography_version', DEFAULT_PROFILE.geographyVersion)),
      presetVersion: String(profileValue(src, 'presetVersion', 'preset_version', DEFAULT_PROFILE.presetVersion)),
      continentMeanCells: finiteOr(profileValue(src, 'continentMeanCells', 'continent_mean_cells', DEFAULT_PROFILE.continentMeanCells), DEFAULT_PROFILE.continentMeanCells),
      continentVariation: finiteOr(profileValue(src, 'continentVariation', 'continent_variation', DEFAULT_PROFILE.continentVariation), DEFAULT_PROFILE.continentVariation),
      oceanBasinMeanCells: finiteOr(profileValue(src, 'oceanBasinMeanCells', 'ocean_basin_mean_cells', DEFAULT_PROFILE.oceanBasinMeanCells), DEFAULT_PROFILE.oceanBasinMeanCells),
      drainageMeanCells: finiteOr(profileValue(src, 'drainageMeanCells', 'drainage_mean_cells', DEFAULT_PROFILE.drainageMeanCells), DEFAULT_PROFILE.drainageMeanCells),
      oceanPctl: finiteOr(profileValue(src, 'oceanPctl', 'ocean_pctl', DEFAULT_PROFILE.oceanPctl), DEFAULT_PROFILE.oceanPctl),
      shelfBelowPctl: finiteOr(profileValue(src, 'shelfBelowPctl', 'shelf_below_pctl', DEFAULT_PROFILE.shelfBelowPctl), DEFAULT_PROFILE.shelfBelowPctl),
      shelfAbovePctl: finiteOr(profileValue(src, 'shelfAbovePctl', 'shelf_above_pctl', DEFAULT_PROFILE.shelfAbovePctl), DEFAULT_PROFILE.shelfAbovePctl),
      highlandLandPctl: finiteOr(profileValue(src, 'highlandLandPctl', 'highland_land_pctl', DEFAULT_PROFILE.highlandLandPctl), DEFAULT_PROFILE.highlandLandPctl),
      mountainLandPctl: finiteOr(profileValue(src, 'mountainLandPctl', 'mountain_land_pctl', DEFAULT_PROFILE.mountainLandPctl), DEFAULT_PROFILE.mountainLandPctl),
      aridLandPctl: finiteOr(profileValue(src, 'aridLandPctl', 'arid_land_pctl', DEFAULT_PROFILE.aridLandPctl), DEFAULT_PROFILE.aridLandPctl),
      wetLandPctl: finiteOr(profileValue(src, 'wetLandPctl', 'wet_land_pctl', DEFAULT_PROFILE.wetLandPctl), DEFAULT_PROFILE.wetLandPctl),
      coldPctl: finiteOr(profileValue(src, 'coldPctl', 'cold_pctl', DEFAULT_PROFILE.coldPctl), DEFAULT_PROFILE.coldPctl),
      hotPctl: finiteOr(profileValue(src, 'hotPctl', 'hot_pctl', DEFAULT_PROFILE.hotPctl), DEFAULT_PROFILE.hotPctl),
      streamFlowPctl: finiteOr(profileValue(src, 'streamFlowPctl', 'stream_flow_pctl', DEFAULT_PROFILE.streamFlowPctl), DEFAULT_PROFILE.streamFlowPctl),
      majorRiverFlowPctl: finiteOr(profileValue(src, 'majorRiverFlowPctl', 'major_river_flow_pctl', DEFAULT_PROFILE.majorRiverFlowPctl), DEFAULT_PROFILE.majorRiverFlowPctl),
      coastSoftWidthCells: finiteOr(profileValue(src, 'coastSoftWidthCells', 'coast_soft_width_cells', DEFAULT_PROFILE.coastSoftWidthCells), DEFAULT_PROFILE.coastSoftWidthCells),
      continentSoftWidthCells: finiteOr(profileValue(src, 'continentSoftWidthCells', 'continent_soft_width_cells', DEFAULT_PROFILE.continentSoftWidthCells), DEFAULT_PROFILE.continentSoftWidthCells),
      biomeSoftWidthCells: finiteOr(profileValue(src, 'biomeSoftWidthCells', 'biome_soft_width_cells', DEFAULT_PROFILE.biomeSoftWidthCells), DEFAULT_PROFILE.biomeSoftWidthCells),
      transitionEntropyPctl: finiteOr(profileValue(src, 'transitionEntropyPctl', 'transition_entropy_pctl', DEFAULT_PROFILE.transitionEntropyPctl), DEFAULT_PROFILE.transitionEntropyPctl)
    };
    if (profile.noiseVersion !== NOISE_VERSION) {
      throw new Error('PlanetGeography: неподдерживаемая noiseVersion ' + profile.noiseVersion);
    }
    if (profile.geographyVersion !== GEOGRAPHY_VERSION) {
      throw new Error('PlanetGeography: неподдерживаемая geographyVersion ' + profile.geographyVersion);
    }
    if (profile.gridVersion !== GRID_VERSION) {
      throw new Error('PlanetGeography: неподдерживаемая gridVersion ' + profile.gridVersion);
    }
    if (SURFACE_CLASSES.indexOf(profile.surfaceClass) < 0) {
      throw new Error('PlanetGeography: неподдерживаемая surfaceClass ' + profile.surfaceClass);
    }
    if (!(profile.radiusKm > 0)) throw new Error('PlanetGeography: radiusKm должно быть > 0');
    if (!(profile.continentMeanCells > 0) || !(profile.oceanBasinMeanCells > 0) || !(profile.drainageMeanCells > 0)) {
      throw new Error('PlanetGeography: целевые размеры в ячейках должны быть > 0');
    }
    if (profile.continentVariation < 0) throw new Error('PlanetGeography: continentVariation не может быть отрицательной');
    var pctFields = ['oceanPctl', 'shelfBelowPctl', 'shelfAbovePctl', 'highlandLandPctl',
      'mountainLandPctl', 'aridLandPctl', 'wetLandPctl', 'coldPctl', 'hotPctl',
      'streamFlowPctl', 'majorRiverFlowPctl', 'transitionEntropyPctl'];
    for (var i = 0; i < pctFields.length; i++) {
      var value = profile[pctFields[i]];
      if (!(value >= 0 && value <= 100)) throw new Error('PlanetGeography: ' + pctFields[i] + ' вне диапазона 0..100');
    }
    if (!(profile.shelfBelowPctl <= profile.oceanPctl && profile.oceanPctl <= profile.shelfAbovePctl)) {
      throw new Error('PlanetGeography: требуется shelfBelowPctl <= oceanPctl <= shelfAbovePctl');
    }
    if (profile.coastSoftWidthCells < 0 || profile.continentSoftWidthCells < 0 || profile.biomeSoftWidthCells < 0) {
      throw new Error('PlanetGeography: ширины мягких переходов не могут быть отрицательными');
    }
    return profile;
  }

  function offsetVector(seed) {
    var rng = mulberry32(seed);
    return [(rng() * 2 - 1) * 256, (rng() * 2 - 1) * 256, (rng() * 2 - 1) * 256];
  }

  function createFieldSampler(input) {
    var profile = normalizeProfile(input);
    var master = parseMasterSeedHex(profile.masterSeedHex);
    var ratio = profile.radiusKm / EARTH_RADIUS_KM;
    var climateRatio = Math.sqrt(ratio);
    var elevNoise = PlanetNoise.makeNoise('simplex', domainSeed(master, 'elevation'));
    var moistNoise = PlanetNoise.makeNoise('simplex', domainSeed(master, 'moisture'));
    var tempNoise = PlanetNoise.makeNoise('simplex', domainSeed(master, 'temperature'));
    var plateNoise = PlanetNoise.makeNoise('simplex', domainSeed(master, 'plates'));
    var volcNoise = PlanetNoise.makeNoise('simplex', domainSeed(master, 'volcanism'));
    var detailNoise = PlanetNoise.makeNoise('simplex', domainSeed(master, 'detail'));
    var warpNoise = PlanetNoise.makeNoise('simplex', domainSeed(master, 'warp'));
    var offE = offsetVector(domainSeed(master, 'offset:elevation'));
    var offM = offsetVector(domainSeed(master, 'offset:moisture'));
    var offT = offsetVector(domainSeed(master, 'offset:temperature'));
    var offP = offsetVector(domainSeed(master, 'offset:plates'));
    var offV = offsetVector(domainSeed(master, 'offset:volcanism'));
    var offD = offsetVector(domainSeed(master, 'offset:detail'));
    var offW = offsetVector(domainSeed(master, 'offset:warp'));

    function sampleFields(x, y, z, out) {
      var len = Math.sqrt(x * x + y * y + z * z);
      if (!(len > 0) || !Number.isFinite(len)) throw new Error('PlanetGeography.sampleFields: направление должно быть ненулевым');
      var nx = x / len, ny = y / len, nz = z / len;
      out = out || new Float32Array(6);

      var warpFreq = 0.85 * ratio;
      var wx = warpNoise(nx * warpFreq + offW[0], ny * warpFreq + offW[1], nz * warpFreq + offW[2]);
      var wy = warpNoise(nx * warpFreq + offW[1], ny * warpFreq + offW[2], nz * warpFreq + offW[0]);
      var wz = warpNoise(nx * warpFreq + offW[2], ny * warpFreq + offW[0], nz * warpFreq + offW[1]);
      var along = wx * nx + wy * ny + wz * nz;
      var warpAmp = 0.14 / Math.max(0.25, ratio);
      var dx = nx + (wx - along * nx) * warpAmp;
      var dy = ny + (wy - along * ny) * warpAmp;
      var dz = nz + (wz - along * nz) * warpAmp;
      var dlen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= dlen; dy /= dlen; dz /= dlen;

      var plate = PlanetNoise.fbm(plateNoise,
        nx * 1.12 + offP[0], ny * 1.12 + offP[1], nz * 1.12 + offP[2], 3, 2.0, 0.52);
      var elevationFreq = 2.15 * ratio;
      var base = PlanetNoise.fbm(elevNoise,
        dx * elevationFreq + offE[0], dy * elevationFreq + offE[1], dz * elevationFreq + offE[2],
        5, 2.0, 0.5);
      var detailFreq = 9.0 * ratio;
      var detail = PlanetNoise.fbm(detailNoise,
        dx * detailFreq + offD[0], dy * detailFreq + offD[1], dz * detailFreq + offD[2],
        3, 2.0, 0.55);
      var elevation = clamp(0.74 * base + 0.30 * plate + 0.10 * detail, -1, 1);

      var moistureFreq = 2.9 * climateRatio;
      var moistureRaw = PlanetNoise.fbm(moistNoise,
        dx * moistureFreq + offM[0], dy * moistureFreq + offM[1], dz * moistureFreq + offM[2],
        4, 2.0, 0.5);
      var moisture = clamp01(0.5 + 0.5 * moistureRaw + 0.04 * plate);

      var tempFreq = 1.7 * climateRatio;
      var tempAnomaly = tempNoise(nx * tempFreq + offT[0], ny * tempFreq + offT[1], nz * tempFreq + offT[2]);
      var insolation = Math.sqrt(Math.max(0, 1 - ny * ny));
      var temperatureBase = clamp01(0.72 * insolation + 0.28 * (tempAnomaly * 0.5 + 0.5));

      var volcFreq = 3.6 * ratio;
      var volcRaw = PlanetNoise.fbm(volcNoise,
        nx * volcFreq + offV[0], ny * volcFreq + offV[1], nz * volcFreq + offV[2],
        3, 2.0, 0.55);
      var volcanism = Math.pow(clamp01(volcRaw * 0.5 + 0.5), 1.5);

      out[FIELD_INDEX.elevation] = elevation;
      out[FIELD_INDEX.moisture] = moisture;
      out[FIELD_INDEX.temperatureBase] = temperatureBase;
      out[FIELD_INDEX.plateAffinity] = clamp01(plate * 0.5 + 0.5);
      out[FIELD_INDEX.volcanism] = volcanism;
      out[FIELD_INDEX.detail] = clamp(detail, -1, 1);
      return out;
    }

    return {
      sampleFields: sampleFields,
      sampleDirection: function (direction, out) {
        return sampleFields(direction[0], direction[1], direction[2], out);
      },
      profile: profile,
      masterSeedHex: master.hex,
      masterSeedHi: master.hi,
      masterSeedLo: master.lo,
      noiseVersion: NOISE_VERSION,
      geographyVersion: GEOGRAPHY_VERSION
    };
  }

  function allocateGeographyArrays(cellCount) {
    return {
      elevation: new Float32Array(cellCount),
      moisture: new Float32Array(cellCount),
      temperature: new Float32Array(cellCount),
      plateAffinity: new Float32Array(cellCount),
      volcanism: new Float32Array(cellCount),
      detail: new Float32Array(cellCount),
      muLand: new Float32Array(cellCount),
      muShelf: new Float32Array(cellCount),
      muOcean: new Float32Array(cellCount),
      signedCoastDistanceCells: new Float32Array(cellCount),
      plateId: new Int32Array(cellCount).fill(-1),
      plateBoundary: new Float32Array(cellCount),
      continentSupport: new Float32Array(cellCount),
      continentTop1Id: new Int32Array(cellCount).fill(-1),
      continentTop1Weight: new Float32Array(cellCount),
      continentTop2Id: new Int32Array(cellCount).fill(-1),
      continentTop2Weight: new Float32Array(cellCount),
      continentEntropy: new Float32Array(cellCount),
      oceanSupport: new Float32Array(cellCount),
      oceanBasinId: new Int32Array(cellCount).fill(-1),
      oceanBasinWeight: new Float32Array(cellCount),
      physicalLandmassId: new Int32Array(cellCount).fill(-1)
    };
  }

  function sampleGridFields(grid, sampler, arrays, start, end, temperatureBase) {
    var out = new Float32Array(6);
    for (var c = start; c < end; c++) {
      sampler.sampleFields(grid.centers[c * 3], grid.centers[c * 3 + 1], grid.centers[c * 3 + 2], out);
      arrays.elevation[c] = out[0];
      arrays.moisture[c] = out[1];
      temperatureBase[c] = out[2];
      arrays.plateAffinity[c] = out[3];
      arrays.volcanism[c] = out[4];
      arrays.detail[c] = out[5];
    }
  }

  function makeWeightedQuantiles(values, weights) {
    var order = new Uint32Array(values.length);
    var i;
    for (i = 0; i < order.length; i++) order[i] = i;
    var orderArray = Array.from(order);
    orderArray.sort(function (a, b) { return values[a] - values[b]; });
    var cumulative = new Float64Array(orderArray.length);
    var total = 0;
    for (i = 0; i < orderArray.length; i++) {
      total += weights[orderArray[i]];
      cumulative[i] = total;
    }
    return function quantile(q) {
      if (!orderArray.length) return 0;
      if (q <= 0) return values[orderArray[0]];
      if (q >= 1) return values[orderArray[orderArray.length - 1]];
      var target = total * q;
      var lo = 0, hi = cumulative.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (cumulative[mid] >= target) hi = mid;
        else lo = mid + 1;
      }
      return values[orderArray[lo]];
    };
  }

  function computeCoastDistance(grid, elevation, seaLevel, profile) {
    var count = grid.cellCount;
    var hardLand = new Uint8Array(count);
    var c, n, nb;
    if (profile.oceanPctl <= 0) hardLand.fill(1);
    else if (profile.oceanPctl < 100) {
      for (c = 0; c < count; c++) hardLand[c] = elevation[c] > seaLevel ? 1 : 0;
    }
    var distance = new Float64Array(count).fill(Infinity);
    var heap = new MinHeap();
    var boundaryCount = 0;
    for (c = 0; c < count; c++) {
      var bestFraction = Infinity;
      for (n = 0; n < grid.neighborCount[c]; n++) {
        nb = grid.neighbors[c * 6 + n];
        if (hardLand[nb] === hardLand[c]) continue;
        var denom = Math.abs(elevation[c] - elevation[nb]);
        var fraction = denom > 1e-12
          ? Math.abs(elevation[c] - seaLevel) / denom
          : 0.5;
        if (fraction < bestFraction) bestFraction = fraction;
      }
      if (bestFraction < Infinity) {
        distance[c] = clamp(bestFraction, 0, 1);
        heap.push(distance[c], c, 0);
        boundaryCount++;
      }
    }
    var signed = new Float32Array(count);
    if (!boundaryCount) {
      signed.fill(hardLand[0] ? 30000 : -30000);
      return { hardLand: hardLand, signedDistance: signed };
    }
    while (heap.pop()) {
      c = heap.outCell;
      if (Math.abs(distance[c] - heap.outDist) > 1e-12) continue;
      for (n = 0; n < grid.neighborCount[c]; n++) {
        nb = grid.neighbors[c * 6 + n];
        var candidate = distance[c] + 1;
        if (candidate < distance[nb]) {
          distance[nb] = candidate;
          heap.push(candidate, nb, 0);
        }
      }
    }
    for (c = 0; c < count; c++) signed[c] = hardLand[c] ? distance[c] : -distance[c];
    return { hardLand: hardLand, signedDistance: signed };
  }

  function computeSoftMemberships(grid, arrays, profile, seaLevel, shelfBelowLevel, shelfAboveLevel, coast) {
    var width = Math.max(0, profile.coastSoftWidthCells);
    for (var c = 0; c < grid.cellCount; c++) {
      var dist = coast.signedDistance[c];
      var muLand;
      if (width <= 0) muLand = coast.hardLand[c] ? 1 : 0;
      else muLand = smoothstep01(0.5 + dist / (2 * width));
      var elev = arrays.elevation[c];
      var shelfPotential = 0;
      if (shelfAboveLevel > shelfBelowLevel) {
        if (elev <= seaLevel) {
          var depthSpan = Math.max(1e-12, seaLevel - shelfBelowLevel);
          shelfPotential = clamp01(1 - (seaLevel - elev) / depthSpan);
        } else {
          var landSpan = Math.max(1e-12, shelfAboveLevel - seaLevel);
          shelfPotential = clamp01(1 - (elev - seaLevel) / landSpan);
        }
        var coastProximity = Math.exp(-Math.abs(dist) / Math.max(1, width * 2));
        shelfPotential *= 0.35 + 0.65 * coastProximity;
      }
      var muShelf = (1 - muLand) * clamp01(shelfPotential);
      if (coast.hardLand[c]) {
        // Низкая суша в переходной зоне может иметь shelf-остаток, но не за
        // счёт уже вычисленной доли суши сверх её дополнения до единицы.
        muShelf = Math.max(muShelf, (1 - muLand) * clamp01(shelfPotential) * 0.5);
      }
      var muOcean = clamp01(1 - muLand - muShelf);
      var sum = muLand + muShelf + muOcean;
      if (sum > 0) {
        muLand /= sum; muShelf /= sum; muOcean /= sum;
      } else {
        muOcean = 1;
      }
      arrays.muLand[c] = muLand;
      arrays.muShelf[c] = muShelf;
      arrays.muOcean[c] = muOcean;
      arrays.signedCoastDistanceCells[c] = dist;
      arrays.continentSupport[c] = clamp01(muLand + 0.30 * muShelf);
      arrays.oceanSupport[c] = clamp01(muOcean + 0.55 * muShelf);
    }
  }

  function randomUnitVector(rng) {
    for (;;) {
      var x = rng() * 2 - 1, y = rng() * 2 - 1, z = rng() * 2 - 1;
      var len2 = x * x + y * y + z * z;
      if (len2 > 1e-12 && len2 <= 1) {
        var len = Math.sqrt(len2);
        return [x / len, y / len, z / len];
      }
    }
  }

  function computePlates(grid, arrays, master) {
    var rng = mulberry32(domainSeed(master, 'plate-seeds'));
    var candidates = [];
    var i, j;
    for (i = 0; i < 512; i++) candidates.push(randomUnitVector(rng));
    var seeds = [candidates[0]];
    var selectedCandidate = new Uint8Array(candidates.length);
    selectedCandidate[0] = 1;
    var maxDot = new Float64Array(candidates.length).fill(-1);
    while (seeds.length < PLATE_COUNT) {
      var last = seeds[seeds.length - 1];
      var best = -1, bestScore = Infinity;
      for (i = 0; i < candidates.length; i++) {
        var dot = candidates[i][0] * last[0] + candidates[i][1] * last[1] + candidates[i][2] * last[2];
        if (dot > maxDot[i]) maxDot[i] = dot;
        if (!selectedCandidate[i] && maxDot[i] < bestScore) {
          bestScore = maxDot[i];
          best = i;
        }
      }
      selectedCandidate[best] = 1;
      seeds.push(candidates[best]);
    }
    var records = seeds.map(function (seed, id) {
      return { id: id, seedDirection: seed, cellCount: 0, supportAreaKm2: 0 };
    });
    for (var c = 0; c < grid.cellCount; c++) {
      var bestId = 0, bestDot = -Infinity, secondDot = -Infinity;
      for (j = 0; j < seeds.length; j++) {
        var d = grid.centers[c * 3] * seeds[j][0] +
          grid.centers[c * 3 + 1] * seeds[j][1] +
          grid.centers[c * 3 + 2] * seeds[j][2];
        if (d > bestDot) {
          secondDot = bestDot;
          bestDot = d;
          bestId = j;
        } else if (d > secondDot) {
          secondDot = d;
        }
      }
      arrays.plateId[c] = bestId;
      var boundary = clamp01(1 - Math.max(0, bestDot - secondDot) / 0.08);
      arrays.plateBoundary[c] = boundary;
      arrays.volcanism[c] = clamp01(arrays.volcanism[c] * 0.72 + boundary * arrays.volcanism[c] * 0.38 + boundary * 0.08);
      records[bestId].cellCount++;
    }
    return records;
  }

  function MinHeap() {
    this.dist = new Float64Array(1024);
    this.cell = new Int32Array(1024);
    this.label = new Int32Array(1024);
    this.size = 0;
    this.outDist = 0;
    this.outCell = -1;
    this.outLabel = -1;
  }
  MinHeap.prototype.ensure = function (capacity) {
    if (capacity <= this.dist.length) return;
    var next = this.dist.length;
    while (next < capacity) next *= 2;
    var dist = new Float64Array(next);
    var cell = new Int32Array(next);
    var label = new Int32Array(next);
    dist.set(this.dist); cell.set(this.cell); label.set(this.label);
    this.dist = dist; this.cell = cell; this.label = label;
  };
  MinHeap.prototype.push = function (dist, cell, label) {
    this.ensure(this.size + 1);
    var d = this.dist, c = this.cell, l = this.label;
    var i = this.size++;
    d[i] = dist; c[i] = cell; l[i] = label;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (d[parent] <= d[i]) break;
      var td = d[parent]; d[parent] = d[i]; d[i] = td;
      var tc = c[parent]; c[parent] = c[i]; c[i] = tc;
      var tl = l[parent]; l[parent] = l[i]; l[i] = tl;
      i = parent;
    }
  };
  MinHeap.prototype.pop = function () {
    var d = this.dist, c = this.cell, l = this.label;
    if (!this.size) return false;
    this.outDist = d[0];
    this.outCell = c[0];
    this.outLabel = l[0];
    this.size--;
    if (this.size) {
      d[0] = d[this.size]; c[0] = c[this.size]; l[0] = l[this.size];
      var i = 0;
      for (;;) {
        var left = i * 2 + 1, right = left + 1, smallest = i;
        if (left < this.size && d[left] < d[smallest]) smallest = left;
        if (right < this.size && d[right] < d[smallest]) smallest = right;
        if (smallest === i) break;
        var td = d[smallest]; d[smallest] = d[i]; d[i] = td;
        var tc = c[smallest]; c[smallest] = c[i]; c[i] = tc;
        var tl = l[smallest]; l[smallest] = l[i]; l[i] = tl;
        i = smallest;
      }
    }
    return true;
  };

  function computeEdgeCost(grid, arrays, a, b, mode) {
    var elevCost = Math.min(1, Math.abs(arrays.elevation[a] - arrays.elevation[b]) * 8);
    var climateCost = 0.35 * Math.abs(arrays.temperature[a] - arrays.temperature[b]) +
      0.25 * Math.abs(arrays.moisture[a] - arrays.moisture[b]);
    var plateCost = arrays.plateId[a] !== arrays.plateId[b]
      ? (mode === 'continent' ? 0.75 : 0.25) + 0.35 * (arrays.plateBoundary[a] + arrays.plateBoundary[b])
      : 0.08 * (arrays.plateBoundary[a] + arrays.plateBoundary[b]);
    var barrier;
    if (mode === 'continent') {
      var support = Math.min(arrays.continentSupport[a], arrays.continentSupport[b]);
      barrier = 3.2 * Math.max(0, 0.65 - support);
    } else {
      var oceanSupport = Math.min(arrays.oceanSupport[a], arrays.oceanSupport[b]);
      barrier = 3.2 * Math.max(0, 0.65 - oceanSupport);
    }
    return 1 + elevCost + climateCost + plateCost + barrier;
  }

  function buildEdgeCosts(grid, arrays, mode) {
    var costs = new Float32Array(grid.cellCount * 6);
    for (var c = 0; c < grid.cellCount; c++) {
      for (var n = 0; n < grid.neighborCount[c]; n++) {
        var nb = grid.neighbors[c * 6 + n];
        costs[c * 6 + n] = computeEdgeCost(grid, arrays, c, nb, mode);
      }
    }
    return costs;
  }

  function runTopOne(grid, seeds, biases, edgeCosts) {
    var count = grid.cellCount;
    var label = new Int32Array(count).fill(-1);
    var dist = new Float64Array(count).fill(Infinity);
    var heap = new MinHeap();
    var s, n;
    for (s = 0; s < seeds.length; s++) {
      var seedCell = seeds[s];
      label[seedCell] = s;
      dist[seedCell] = -biases[s];
      heap.push(dist[seedCell], seedCell, s);
    }
    while (heap.pop()) {
      var cell = heap.outCell;
      var currentLabel = heap.outLabel;
      var currentDist = heap.outDist;
      if (label[cell] !== currentLabel || Math.abs(dist[cell] - currentDist) > 1e-12) continue;
      for (n = 0; n < grid.neighborCount[cell]; n++) {
        var nb = grid.neighbors[cell * 6 + n];
        var candidate = currentDist + edgeCosts[cell * 6 + n];
        if (candidate < dist[nb] - 1e-12) {
          dist[nb] = candidate;
          label[nb] = currentLabel;
          heap.push(candidate, nb, currentLabel);
        }
      }
    }
    return label;
  }

  function runTopTwo(grid, arrays, seeds, biases, mode, edgeCosts) {
    var count = grid.cellCount;
    var label1 = new Int32Array(count).fill(-1);
    var label2 = new Int32Array(count).fill(-1);
    var dist1 = new Float64Array(count).fill(Infinity);
    var dist2 = new Float64Array(count).fill(Infinity);
    var heap = new MinHeap();
    var s;
    for (s = 0; s < seeds.length; s++) {
      var seedCell = seeds[s];
      label1[seedCell] = s;
      dist1[seedCell] = -biases[s];
      heap.push(dist1[seedCell], seedCell, s);
    }
    function offer(cell, label, candidate) {
      if (label === label1[cell]) {
        if (candidate < dist1[cell] - 1e-12) {
          dist1[cell] = candidate;
          heap.push(candidate, cell, label);
        }
        return;
      }
      if (label === label2[cell]) {
        if (candidate < dist2[cell] - 1e-12) {
          dist2[cell] = candidate;
          heap.push(candidate, cell, label);
        }
        return;
      }
      if (candidate < dist1[cell]) {
        var oldLabel = label1[cell];
        var oldDist = dist1[cell];
        if (oldLabel >= 0 && oldDist < dist2[cell]) {
          label2[cell] = oldLabel;
          dist2[cell] = oldDist;
          heap.push(oldDist, cell, oldLabel);
        }
        label1[cell] = label;
        dist1[cell] = candidate;
        heap.push(candidate, cell, label);
      } else if (candidate < dist2[cell]) {
        label2[cell] = label;
        dist2[cell] = candidate;
        heap.push(candidate, cell, label);
      }
    }
    while (heap.pop()) {
      var cell = heap.outCell;
      var label = heap.outLabel;
      var dist = heap.outDist;
      var current = label === label1[cell] ? dist1[cell] : (label === label2[cell] ? dist2[cell] : null);
      if (current == null || Math.abs(current - dist) > 1e-9) continue;
      for (var n = 0; n < grid.neighborCount[cell]; n++) {
        var nb = grid.neighbors[cell * 6 + n];
        offer(nb, label, dist + edgeCosts[cell * 6 + n]);
      }
    }
    return { label1: label1, label2: label2, dist1: dist1, dist2: dist2 };
  }

  function normal01(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function desiredMasses(count, totalSupport, targetMean, variation, rng) {
    var masses = new Float64Array(count);
    if (!count) return masses;
    if (!(variation > 0)) {
      masses.fill(totalSupport / count);
      return masses;
    }
    var sum = 0;
    for (var i = 0; i < count; i++) {
      var weight = Math.exp(variation * normal01(rng) - 0.5 * variation * variation);
      weight = clamp(weight, 0.05, 8);
      masses[i] = weight;
      sum += weight;
    }
    var scale = totalSupport / Math.max(1e-12, sum);
    for (i = 0; i < count; i++) masses[i] *= scale;
    return masses;
  }

  function takeDesiredMasses(sortedDesc, count, totalSupport) {
    var masses = new Float64Array(count);
    var sum = 0;
    for (var i = 0; i < count; i++) {
      masses[i] = sortedDesc[Math.min(i, sortedDesc.length - 1)] || 0;
      sum += masses[i];
    }
    if (count && sum > 0) {
      var scale = totalSupport / sum;
      for (i = 0; i < count; i++) masses[i] *= scale;
    }
    return masses;
  }

  function chooseSeeds(grid, support, score, countWant, componentIds, componentSizes, minComponentCells, desiredMassesSortedDesc) {
    var candidates = [];
    var c, i;
    for (c = 0; c < grid.cellCount; c++) {
      if (support[c] < 0.45) continue;
      if (componentIds && componentSizes) {
        var component = componentIds[c];
        if (component < 0 || componentSizes[component] < minComponentCells) continue;
      }
      candidates.push(c);
    }
    if (!candidates.length || countWant <= 0) return [];
    candidates.sort(function (a, b) { return score[b] - score[a] || a - b; });
    var cap = Math.min(candidates.length, Math.max(10000, countWant * 120));
    candidates.length = cap;
    var maxScore = score[candidates[0]] || 1;
    var selected = [candidates[0]];
    var minChord2 = new Float64Array(candidates.length).fill(Infinity);
    var minResidual = new Float64Array(candidates.length).fill(Infinity);
    var desiredSorted = desiredMassesSortedDesc && desiredMassesSortedDesc.length
      ? desiredMassesSortedDesc : null;
    var meanSpacing = Math.sqrt(4 * Math.PI / grid.cellCount);
    function desiredRadius(selectedIndex) {
      if (!desiredSorted) return 0;
      var mass = desiredSorted[Math.min(selectedIndex, desiredSorted.length - 1)];
      return meanSpacing * Math.sqrt(Math.max(1, mass) / Math.PI);
    }
    function updateWith(cell, selectedIndex) {
      var x = grid.centers[cell * 3], y = grid.centers[cell * 3 + 1], z = grid.centers[cell * 3 + 2];
      var selectedRadius = desiredRadius(selectedIndex);
      for (var j = 0; j < candidates.length; j++) {
        var other = candidates[j];
        var dx = x - grid.centers[other * 3];
        var dy = y - grid.centers[other * 3 + 1];
        var dz = z - grid.centers[other * 3 + 2];
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < minChord2[j]) minChord2[j] = d2;
        if (desiredSorted) {
          var residual = Math.sqrt(d2) - selectedRadius;
          if (residual < minResidual[j]) minResidual[j] = residual;
        }
      }
    }
    updateWith(selected[0], 0);
    while (selected.length < Math.min(countWant, candidates.length)) {
      var best = -1, bestObjective = -Infinity;
      var nextRadius = desiredRadius(selected.length);
      for (i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        if (minChord2[i] === 0) continue;
        var scoreNorm = maxScore > 0 ? clamp01(score[candidate] / maxScore) : 0;
        var objective;
        if (desiredSorted) {
          // Крупные желаемые домены идут первыми и требуют большей
          // свободной окружности; мелкие могут заполнять оставшиеся
          // географические карманы ближе к соседям.
          var clearance = minResidual[i] - nextRadius;
          objective = clearance + meanSpacing * 0.35 * scoreNorm;
        } else {
          objective = Math.sqrt(minChord2[i]) * (0.65 + 0.35 * scoreNorm);
        }
        if (objective > bestObjective) {
          bestObjective = objective;
          best = candidate;
        }
      }
      if (best < 0) break;
      selected.push(best);
      updateWith(best, selected.length - 1);
    }
    return selected;
  }

  function assignRegions(grid, arrays, seeds, desired, support, mode, softWidthCells, targetMean) {
    var count = grid.cellCount;
    var result = {
      top1Id: new Int32Array(count).fill(-1),
      top1Weight: new Float32Array(count),
      top2Id: new Int32Array(count).fill(-1),
      top2Weight: new Float32Array(count),
      entropy: new Float32Array(count),
      desiredMass: new Float64Array(seeds.length),
      effectiveMass: new Float64Array(seeds.length),
      effectiveAreaKm2: new Float64Array(seeds.length),
      hardCellCount: new Uint32Array(seeds.length)
    };
    if (!seeds.length) return result;
    var radiusScale = Math.sqrt(Math.max(1, targetMean) / Math.PI);
    var biases = new Float64Array(seeds.length);
    var i, c;
    var edgeCosts = buildEdgeCosts(grid, arrays, mode);
    result.desiredMass.set(desired);
    for (i = 0; i < seeds.length; i++) {
      biases[i] = clamp(0.5 * radiusScale * Math.log(Math.max(1e-9, result.desiredMass[i] / Math.max(1, targetMean))),
        -1.5 * radiusScale, 1.5 * radiusScale);
    }
    var top = null;
    var iterations = seeds.length > 1 ? 3 : 1;
    for (var iteration = 0; iteration < iterations; iteration++) {
      if (iteration === iterations - 1) {
        top = runTopTwo(grid, arrays, seeds, biases, mode, edgeCosts);
        break;
      }
      var topOne = runTopOne(grid, seeds, biases, edgeCosts);
      var actual = new Float64Array(seeds.length);
      for (c = 0; c < count; c++) {
        var label = topOne[c];
        if (label >= 0) actual[label] += support[c];
      }
      for (i = 0; i < seeds.length; i++) {
        var ratio = (result.desiredMass[i] + 0.5) / (actual[i] + 0.5);
        biases[i] = clamp(biases[i] + 0.25 * radiusScale * Math.log(ratio),
          -1.75 * radiusScale, 1.75 * radiusScale);
      }
    }
    var temperature = Math.max(0.35, softWidthCells || 0);
    for (c = 0; c < count; c++) {
      var id1 = top.label1[c];
      var id2 = top.label2[c];
      result.top1Id[c] = id1;
      result.top2Id[c] = id2;
      if (id1 < 0) continue;
      result.hardCellCount[id1]++;
      var w1 = 1;
      if (id2 >= 0 && Number.isFinite(top.dist2[c])) {
        var delta = Math.max(0, top.dist2[c] - top.dist1[c]);
        w1 = 1 / (1 + Math.exp(-delta / temperature));
      }
      var w2 = id2 >= 0 ? 1 - w1 : 0;
      result.top1Weight[c] = w1;
      result.top2Weight[c] = w2;
      var entropy = 0;
      if (w1 > 0) entropy -= w1 * Math.log(w1);
      if (w2 > 0) entropy -= w2 * Math.log(w2);
      result.entropy[c] = entropy / Math.LN2;
      var cellArea = grid.areas[c];
      result.effectiveMass[id1] += support[c] * w1;
      result.effectiveAreaKm2[id1] += support[c] * w1 * cellArea;
      if (id2 >= 0) {
        result.effectiveMass[id2] += support[c] * w2;
        result.effectiveAreaKm2[id2] += support[c] * w2 * cellArea;
      }
    }
    return result;
  }

  function pruneEmptyRegions(grid, assigned, support) {
    var oldCount = assigned.hardCellCount.length;
    var remap = new Int32Array(oldCount).fill(-1);
    var keptOldIds = [];
    var i, c;
    for (i = 0; i < oldCount; i++) {
      if (assigned.hardCellCount[i] > 0) {
        remap[i] = keptOldIds.length;
        keptOldIds.push(i);
      }
    }
    if (keptOldIds.length === oldCount) {
      return { assigned: assigned, keptOldIds: keptOldIds };
    }
    var pruned = {
      top1Id: assigned.top1Id,
      top1Weight: assigned.top1Weight,
      top2Id: assigned.top2Id,
      top2Weight: assigned.top2Weight,
      entropy: assigned.entropy,
      desiredMass: new Float64Array(keptOldIds.length),
      effectiveMass: new Float64Array(keptOldIds.length),
      effectiveAreaKm2: new Float64Array(keptOldIds.length),
      hardCellCount: new Uint32Array(keptOldIds.length)
    };
    for (i = 0; i < keptOldIds.length; i++) {
      pruned.desiredMass[i] = assigned.desiredMass[keptOldIds[i]];
    }
    for (c = 0; c < grid.cellCount; c++) {
      var old1 = assigned.top1Id[c];
      var old2 = assigned.top2Id[c];
      if (old1 < 0) continue;
      var new1 = remap[old1];
      var new2 = old2 >= 0 ? remap[old2] : -1;
      var w1 = assigned.top1Weight[c];
      var w2 = assigned.top2Weight[c];
      // Пустая идентичность не может быть top1 ни в одной ячейке по
      // построению фильтра. Если она была top2, её переходная масса
      // возвращается фактическому top1, а ячейка становится однозначной.
      if (old2 >= 0 && new2 < 0) {
        w1 = 1;
        w2 = 0;
        pruned.entropy[c] = 0;
      }
      pruned.top1Id[c] = new1;
      pruned.top2Id[c] = new2;
      pruned.top1Weight[c] = w1;
      pruned.top2Weight[c] = w2;
      if (new1 >= 0) {
        pruned.hardCellCount[new1]++;
        pruned.effectiveMass[new1] += support[c] * w1;
        pruned.effectiveAreaKm2[new1] += support[c] * w1 * grid.areas[c];
      }
      if (new2 >= 0) {
        pruned.effectiveMass[new2] += support[c] * w2;
        pruned.effectiveAreaKm2[new2] += support[c] * w2 * grid.areas[c];
      }
    }
    return { assigned: pruned, keptOldIds: keptOldIds };
  }

  function buildContinents(grid, arrays, profile, coast, radiusKm, rng) {
    var support = arrays.continentSupport;
    var totalSupport = 0;
    var c;
    for (c = 0; c < grid.cellCount; c++) totalSupport += support[c];
    var countWant = Math.max(0, Math.round(totalSupport / profile.continentMeanCells));
    var score = new Float32Array(grid.cellCount);
    var maxElev = -Infinity, minElev = Infinity;
    for (c = 0; c < grid.cellCount; c++) {
      if (arrays.elevation[c] > maxElev) maxElev = arrays.elevation[c];
      if (arrays.elevation[c] < minElev) minElev = arrays.elevation[c];
    }
    // Глубина берега и нормированная высота дают семенам внутренние,
    // а не береговые точки.
    for (c = 0; c < grid.cellCount; c++) {
      var elevNorm = maxElev > minElev ? (arrays.elevation[c] - minElev) / (maxElev - minElev) : 0;
      score[c] = Math.min(25, Math.max(0, coast.signedDistance[c])) + elevNorm * 8 + arrays.plateAffinity[c] * 2;
    }
    var supportMask = new Uint8Array(grid.cellCount);
    for (c = 0; c < grid.cellCount; c++) supportMask[c] = support[c] >= 0.45 ? 1 : 0;
    var supportComponents = componentSizes(grid, supportMask);
    var desiredAll = desiredMasses(countWant, totalSupport, profile.continentMeanCells,
      profile.continentVariation * CONTINENT_DESIRED_VARIATION_GAIN, rng);
    var desiredSortedDesc = Array.from(desiredAll).sort(function (a, b) { return b - a; });
    var seeds = chooseSeeds(grid, support, score, countWant, supportComponents.ids,
      supportComponents.sizes, Math.max(5, Math.round(profile.continentMeanCells * 0.01)), desiredSortedDesc);
    var desired = takeDesiredMasses(desiredSortedDesc, seeds.length, totalSupport);
    var assigned = assignRegions(grid, arrays, seeds, desired, support, 'continent',
      profile.continentSoftWidthCells, profile.continentMeanCells);
    var pruned = pruneEmptyRegions(grid, assigned, support);
    assigned = pruned.assigned;
    seeds = pruned.keptOldIds.map(function (oldId) { return seeds[oldId]; });
    arrays.continentTop1Id.set(assigned.top1Id);
    arrays.continentTop1Weight.set(assigned.top1Weight);
    arrays.continentTop2Id.set(assigned.top2Id);
    arrays.continentTop2Weight.set(assigned.top2Weight);
    arrays.continentEntropy.set(assigned.entropy);
    var areaScale = radiusKm * radiusKm;
    var records = seeds.map(function (seedCell, id) {
      return {
        id: id,
        seedCell: seedCell,
        desiredMassCells: assigned.desiredMass[id],
        effectiveMassCells: assigned.effectiveMass[id],
        effectiveAreaKm2: assigned.effectiveAreaKm2[id] * areaScale,
        hardCellCount: assigned.hardCellCount[id]
      };
    });
    return { records: records, totalSupport: totalSupport, assigned: assigned };
  }

  function buildOceanBasins(grid, arrays, profile, coast, radiusKm, rng) {
    var support = arrays.oceanSupport;
    var totalSupport = 0;
    var c;
    for (c = 0; c < grid.cellCount; c++) totalSupport += support[c];
    var countWant = Math.max(0, Math.round(totalSupport / profile.oceanBasinMeanCells));
    var score = new Float32Array(grid.cellCount);
    var maxElev = -Infinity, minElev = Infinity;
    for (c = 0; c < grid.cellCount; c++) {
      if (arrays.elevation[c] > maxElev) maxElev = arrays.elevation[c];
      if (arrays.elevation[c] < minElev) minElev = arrays.elevation[c];
    }
    for (c = 0; c < grid.cellCount; c++) {
      var depthNorm = maxElev > minElev ? 1 - (arrays.elevation[c] - minElev) / (maxElev - minElev) : 0;
      score[c] = Math.min(25, Math.max(0, -coast.signedDistance[c])) + depthNorm * 8;
    }
    var supportMask = new Uint8Array(grid.cellCount);
    for (c = 0; c < grid.cellCount; c++) supportMask[c] = support[c] >= 0.45 ? 1 : 0;
    var supportComponents = componentSizes(grid, supportMask);
    var desiredAll = desiredMasses(countWant, totalSupport, profile.oceanBasinMeanCells, 0.45, rng);
    var desiredSortedDesc = Array.from(desiredAll).sort(function (a, b) { return b - a; });
    var seeds = chooseSeeds(grid, support, score, countWant, supportComponents.ids,
      supportComponents.sizes, Math.max(50, Math.round(profile.oceanBasinMeanCells * 0.03)), desiredSortedDesc);
    var desired = takeDesiredMasses(desiredSortedDesc, seeds.length, totalSupport);
    var assigned = assignRegions(grid, arrays, seeds, desired, support, 'ocean',
      Math.max(1, profile.continentSoftWidthCells), profile.oceanBasinMeanCells);
    var pruned = pruneEmptyRegions(grid, assigned, support);
    assigned = pruned.assigned;
    seeds = pruned.keptOldIds.map(function (oldId) { return seeds[oldId]; });
    arrays.oceanBasinId.set(assigned.top1Id);
    arrays.oceanBasinWeight.set(assigned.top1Weight);
    var areaScale = radiusKm * radiusKm;
    var records = seeds.map(function (seedCell, id) {
      return {
        id: id,
        seedCell: seedCell,
        desiredMassCells: assigned.desiredMass[id],
        effectiveMassCells: assigned.effectiveMass[id],
        effectiveAreaKm2: assigned.effectiveAreaKm2[id] * areaScale,
        hardCellCount: assigned.hardCellCount[id]
      };
    });
    return { records: records, totalSupport: totalSupport, assigned: assigned };
  }

  function componentSizes(grid, mask) {
    var visited = new Uint8Array(grid.cellCount);
    var sizes = [];
    var stack = [];
    var ids = new Int32Array(grid.cellCount).fill(-1);
    for (var c = 0; c < grid.cellCount; c++) {
      if (visited[c] || !mask[c]) continue;
      var id = sizes.length;
      var size = 0;
      stack.length = 0;
      stack.push(c);
      visited[c] = 1;
      ids[c] = id;
      while (stack.length) {
        var cell = stack.pop();
        size++;
        for (var n = 0; n < grid.neighborCount[cell]; n++) {
          var nb = grid.neighbors[cell * 6 + n];
          if (!visited[nb] && mask[nb]) {
            visited[nb] = 1;
            ids[nb] = id;
            stack.push(nb);
          }
        }
      }
      sizes.push(size);
    }
    return { sizes: sizes, ids: ids };
  }

  function quantileSorted(sorted, q) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  }

  function distributionStats(values) {
    var sorted = Array.from(values).sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < sorted.length; i++) sum += sorted[i];
    return {
      count: sorted.length,
      sum: sum,
      mean: sorted.length ? sum / sorted.length : 0,
      min: sorted.length ? sorted[0] : 0,
      p10: quantileSorted(sorted, 0.10),
      median: quantileSorted(sorted, 0.50),
      p90: quantileSorted(sorted, 0.90),
      p99: quantileSorted(sorted, 0.99),
      max: sorted.length ? sorted[sorted.length - 1] : 0
    };
  }

  function landmassStats(grid, arrays, threshold) {
    var mask = new Uint8Array(grid.cellCount);
    var landCells = 0;
    for (var c = 0; c < grid.cellCount; c++) {
      mask[c] = arrays.muLand[c] >= threshold ? 1 : 0;
      landCells += mask[c];
    }
    var components = componentSizes(grid, mask);
    var stats = distributionStats(components.sizes);
    var tiny = 0;
    for (var i = 0; i < components.sizes.length; i++) if (components.sizes[i] < 5) tiny++;
    return {
      threshold: threshold,
      landCells: landCells,
      count: components.sizes.length,
      medianCells: stats.median,
      p90Cells: stats.p90,
      maxCells: stats.max,
      largestShare: landCells ? stats.max / landCells : 0,
      tinyIslandsUnder5: tiny,
      ids: components.ids
    };
  }

  function computeStats(grid, arrays, profile, continents, oceanBasins, plates, coast) {
    var areaTotal = 0;
    var hardOceanArea = 0;
    var softLandArea = 0, softShelfArea = 0, softOceanArea = 0;
    var equatorTempSum = 0, equatorWeight = 0, polarTempSum = 0, polarWeight = 0;
    var tempSum = 0, qSum = 0, tempQSum = 0, temp2Sum = 0, q2Sum = 0;
    var c;
    for (c = 0; c < grid.cellCount; c++) {
      var area = grid.areas[c];
      areaTotal += area;
      if (!coast.hardLand[c]) hardOceanArea += area;
      softLandArea += arrays.muLand[c] * area;
      softShelfArea += arrays.muShelf[c] * area;
      softOceanArea += arrays.muOcean[c] * area;
      var y = grid.centers[c * 3 + 1];
      var q = Math.sqrt(Math.max(0, 1 - y * y));
      var temp = arrays.temperature[c];
      tempSum += temp * area; qSum += q * area; tempQSum += temp * q * area;
      temp2Sum += temp * temp * area; q2Sum += q * q * area;
      if (Math.abs(y) <= 0.35) { equatorTempSum += temp * area; equatorWeight += area; }
      if (Math.abs(y) >= 0.85) { polarTempSum += temp * area; polarWeight += area; }
    }
    var covariance = tempQSum / areaTotal - (tempSum / areaTotal) * (qSum / areaTotal);
    var varTemp = Math.max(0, temp2Sum / areaTotal - Math.pow(tempSum / areaTotal, 2));
    var varQ = Math.max(0, q2Sum / areaTotal - Math.pow(qSum / areaTotal, 2));
    var correlation = varTemp > 0 && varQ > 0 ? covariance / Math.sqrt(varTemp * varQ) : 0;

    var continentMasses = continents.records.map(function (r) { return r.effectiveMassCells; });
    var continentDist = distributionStats(continentMasses);
    var coreSupport = 0, transitionSupport = 0, entropyWeighted = 0;
    for (c = 0; c < grid.cellCount; c++) {
      var support = arrays.continentSupport[c];
      if (arrays.continentTop1Weight[c] >= 0.75) coreSupport += support;
      if (arrays.continentEntropy[c] >= 0.5) transitionSupport += support;
      entropyWeighted += support * arrays.continentEntropy[c];
    }
    var basinMasses = oceanBasins.records.map(function (r) { return r.effectiveMassCells; });
    var basinDist = distributionStats(basinMasses);
    var thresholds = [0.35, 0.5, 0.65].map(function (threshold) {
      var entry = landmassStats(grid, arrays, threshold);
      if (threshold === 0.5) arrays.physicalLandmassId.set(entry.ids);
      delete entry.ids;
      return entry;
    });
    var plateDist = distributionStats(plates.map(function (r) { return r.cellCount; }));
    return {
      oceanFractionHard: areaTotal ? hardOceanArea / areaTotal : 0,
      oceanFractionTarget: profile.oceanPctl / 100,
      softFractions: {
        land: areaTotal ? softLandArea / areaTotal : 0,
        shelf: areaTotal ? softShelfArea / areaTotal : 0,
        ocean: areaTotal ? softOceanArea / areaTotal : 0
      },
      continents: {
        distribution: continentDist,
        targetMeanCells: profile.continentMeanCells,
        coreSupportFraction: continents.totalSupport ? coreSupport / continents.totalSupport : 0,
        transitionSupportFraction: continents.totalSupport ? transitionSupport / continents.totalSupport : 0,
        meanEntropy: continents.totalSupport ? entropyWeighted / continents.totalSupport : 0
      },
      oceanBasins: {
        distribution: basinDist,
        targetMeanCells: profile.oceanBasinMeanCells
      },
      plates: { distribution: plateDist },
      landmasses: thresholds,
      climate: {
        equatorTemperature: equatorWeight ? equatorTempSum / equatorWeight : 0,
        polarTemperature: polarWeight ? polarTempSum / polarWeight : 0,
        temperatureInsolationCorrelation: correlation
      }
    };
  }

  function expectedFrequency(radiusKm) {
    var earthCells = 10 * EARTH_CANONICAL_V * EARTH_CANONICAL_V + 2;
    var ratio = radiusKm / EARTH_RADIUS_KM;
    return Math.max(1, Math.round(Math.sqrt(Math.max(0, earthCells * ratio * ratio - 2) / 10)));
  }

  function finishGeography(grid, profile, sampler, arrays, temperatureBase, options) {
    options = options || {};
    var onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    function progress(stage, fraction) {
      if (onProgress) onProgress(stage, fraction);
    }
    var result = {
      surfaceApplicable: true,
      gridVersion: grid.gridVersion || profile.gridVersion,
      noiseVersion: NOISE_VERSION,
      geographyVersion: GEOGRAPHY_VERSION,
      presetVersion: profile.presetVersion,
      profile: profile,
      v: grid.v,
      expectedFrequency: expectedFrequency(profile.radiusKm),
      frequencyMatchesProfile: grid.v === expectedFrequency(profile.radiusKm),
      cellCount: grid.cellCount,
      radiusKm: profile.radiusKm,
      seaLevel: 0,
      shelfBelowLevel: 0,
      shelfAboveLevel: 0,
      elevationMin: 0,
      elevationMax: 0,
      continents: [],
      oceanBasins: [],
      plates: [],
      stats: null
    };
    ARRAY_FIELDS.forEach(function (name) { result[name] = arrays[name]; });

    if (profile.surfaceClass === 'gas_giant' || profile.surfaceClass === 'no_surface') {
      result.surfaceApplicable = false;
      result.stats = {
        oceanFractionHard: 0,
        oceanFractionTarget: profile.oceanPctl / 100,
        softFractions: { land: 0, shelf: 0, ocean: 0 },
        continents: { distribution: distributionStats([]), targetMeanCells: profile.continentMeanCells },
        oceanBasins: { distribution: distributionStats([]), targetMeanCells: profile.oceanBasinMeanCells },
        plates: { distribution: distributionStats([]) },
        landmasses: [],
        climate: { equatorTemperature: 0, polarTemperature: 0, temperatureInsolationCorrelation: 0 }
      };
      progress('done', 1);
      return result;
    }

    progress('sea-level', 0.35);
    var quantile = makeWeightedQuantiles(arrays.elevation, grid.areas);
    result.seaLevel = quantile(profile.oceanPctl / 100);
    result.shelfBelowLevel = quantile(profile.shelfBelowPctl / 100);
    result.shelfAboveLevel = quantile(profile.shelfAbovePctl / 100);
    var minE = Infinity, maxE = -Infinity;
    var c;
    for (c = 0; c < grid.cellCount; c++) {
      if (arrays.elevation[c] < minE) minE = arrays.elevation[c];
      if (arrays.elevation[c] > maxE) maxE = arrays.elevation[c];
    }
    result.elevationMin = minE;
    result.elevationMax = maxE;
    for (c = 0; c < grid.cellCount; c++) {
      var heightNorm = arrays.elevation[c] > result.seaLevel && maxE > result.seaLevel
        ? (arrays.elevation[c] - result.seaLevel) / (maxE - result.seaLevel)
        : 0;
      arrays.temperature[c] = clamp01(temperatureBase[c] - 0.22 * heightNorm + 0.03 * arrays.volcanism[c]);
    }

    progress('coast', 0.45);
    var coast = computeCoastDistance(grid, arrays.elevation, result.seaLevel, profile);
    computeSoftMemberships(grid, arrays, profile, result.seaLevel,
      result.shelfBelowLevel, result.shelfAboveLevel, coast);

    progress('plates', 0.55);
    var master = parseMasterSeedHex(profile.masterSeedHex);
    result.plates = computePlates(grid, arrays, master);
    var plateAreaScale = profile.radiusKm * profile.radiusKm;
    for (c = 0; c < grid.cellCount; c++) {
      result.plates[arrays.plateId[c]].areaKm2 += grid.areas[c] * plateAreaScale;
    }

    progress('continents', 0.65);
    var continentRng = mulberry32(domainSeed(master, 'continent-masses'));
    var continents = buildContinents(grid, arrays, profile, coast, profile.radiusKm, continentRng);
    result.continents = continents.records;

    progress('ocean-basins', 0.85);
    var oceanRng = mulberry32(domainSeed(master, 'ocean-basin-masses'));
    var oceanBasins = buildOceanBasins(grid, arrays, profile, coast, profile.radiusKm, oceanRng);
    result.oceanBasins = oceanBasins.records;

    progress('stats', 0.95);
    result.stats = computeStats(grid, arrays, profile, continents, oceanBasins, result.plates, coast);
    progress('done', 1);
    return result;
  }

  function assertGrid(grid) {
    if (!grid || !grid.centers || !grid.areas || !grid.neighbors || !grid.neighborCount ||
        !Number.isInteger(grid.cellCount) || grid.cellCount <= 0) {
      throw new Error('PlanetGeography: нужна сетка GeodesicGrid с centers/areas/neighbors');
    }
    if (grid.gridVersion && grid.gridVersion !== GRID_VERSION) {
      throw new Error('PlanetGeography: сетка должна быть ' + GRID_VERSION + ', получена ' + grid.gridVersion);
    }
  }

  function generateGeography(grid, input, options) {
    assertGrid(grid);
    var sampler = createFieldSampler(input);
    var profile = sampler.profile;
    var arrays = allocateGeographyArrays(grid.cellCount);
    var temperatureBase = new Float32Array(grid.cellCount);
    if (profile.surfaceClass !== 'gas_giant' && profile.surfaceClass !== 'no_surface') {
      sampleGridFields(grid, sampler, arrays, 0, grid.cellCount, temperatureBase);
    }
    return finishGeography(grid, profile, sampler, arrays, temperatureBase, options || {});
  }

  function defaultYieldControl() {
    return new Promise(function (resolve) {
      if (typeof setTimeout !== 'undefined') setTimeout(resolve, 0);
      else resolve();
    });
  }

  async function generateGeographyAsync(grid, input, options) {
    assertGrid(grid);
    options = options || {};
    var sampler = createFieldSampler(input);
    var profile = sampler.profile;
    var arrays = allocateGeographyArrays(grid.cellCount);
    var temperatureBase = new Float32Array(grid.cellCount);
    var onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    if (profile.surfaceClass !== 'gas_giant' && profile.surfaceClass !== 'no_surface') {
      var chunkCells = Math.max(1024, Math.floor(options.chunkCells || 8192));
      var yieldControl = typeof options.yieldControl === 'function' ? options.yieldControl : defaultYieldControl;
      for (var start = 0; start < grid.cellCount; start += chunkCells) {
        var end = Math.min(grid.cellCount, start + chunkCells);
        sampleGridFields(grid, sampler, arrays, start, end, temperatureBase);
        if (onProgress) onProgress('fields', end / grid.cellCount);
        if (end < grid.cellCount) await yieldControl({ stage: 'fields', start: start, end: end });
      }
    }
    return finishGeography(grid, profile, sampler, arrays, temperatureBase, options);
  }

  function typedBytesOf(geography) {
    var total = 0;
    ARRAY_FIELDS.forEach(function (name) {
      if (geography && ArrayBuffer.isView(geography[name])) total += geography[name].byteLength;
    });
    return total;
  }

  function validateGeography(grid, geography) {
    var checks = {};
    if (!grid || !geography) return { ok: false, checks: { shape: false } };
    checks.shape = geography.cellCount === grid.cellCount && geography.v === grid.v;
    checks.versions = geography.noiseVersion === NOISE_VERSION && geography.geographyVersion === GEOGRAPHY_VERSION;
    var lengths = true;
    ARRAY_FIELDS.forEach(function (name) {
      if (!geography[name] || geography[name].length !== grid.cellCount) lengths = false;
    });
    checks.arrayLengths = lengths;
    if (!lengths) return { ok: false, checks: checks };
    var finite = true;
    var ranges = true;
    var softSum = true;
    var ids = true;
    var weights = true;
    var floatFields = ['elevation', 'moisture', 'temperature', 'plateAffinity', 'volcanism', 'detail',
      'muLand', 'muShelf', 'muOcean', 'plateBoundary', 'continentSupport',
      'continentTop1Weight', 'continentTop2Weight', 'continentEntropy', 'oceanSupport', 'oceanBasinWeight'];
    var unitFields = ['moisture', 'temperature', 'plateAffinity', 'volcanism', 'muLand', 'muShelf',
      'muOcean', 'plateBoundary', 'continentSupport', 'continentTop1Weight', 'continentTop2Weight',
      'continentEntropy', 'oceanSupport', 'oceanBasinWeight'];
    for (var c = 0; c < grid.cellCount; c++) {
      for (var i = 0; i < floatFields.length; i++) {
        if (!Number.isFinite(geography[floatFields[i]][c])) finite = false;
      }
      if (geography.elevation[c] < -1.00001 || geography.elevation[c] > 1.00001 ||
          geography.detail[c] < -1.00001 || geography.detail[c] > 1.00001) ranges = false;
      for (i = 0; i < unitFields.length; i++) {
        var v = geography[unitFields[i]][c];
        if (v < -1e-6 || v > 1.000001) ranges = false;
      }
      if (geography.surfaceApplicable) {
        var sum = geography.muLand[c] + geography.muShelf[c] + geography.muOcean[c];
        if (Math.abs(sum - 1) > 1e-4) softSum = false;
        var wSum = geography.continentTop1Weight[c] + geography.continentTop2Weight[c];
        if (geography.continentTop1Id[c] >= 0 && Math.abs(wSum - 1) > 1e-4) weights = false;
        if (geography.continentTop1Id[c] < -1 || geography.continentTop1Id[c] >= Math.max(1, geography.continents.length) ||
            geography.continentTop2Id[c] < -1 || geography.continentTop2Id[c] >= Math.max(1, geography.continents.length) ||
            geography.oceanBasinId[c] < -1 || geography.oceanBasinId[c] >= Math.max(1, geography.oceanBasins.length) ||
            geography.plateId[c] < 0 || geography.plateId[c] >= PLATE_COUNT) ids = false;
        if (geography.continentTop1Id[c] >= 0 && geography.continentTop1Id[c] === geography.continentTop2Id[c]) ids = false;
      }
    }
    checks.finite = finite;
    checks.ranges = ranges;
    checks.softMembershipSum = geography.surfaceApplicable ? softSum : true;
    checks.continentWeights = geography.surfaceApplicable ? weights : true;
    checks.ids = geography.surfaceApplicable ? ids : true;
    checks.stats = !!geography.stats;
    var ok = Object.keys(checks).every(function (key) { return checks[key]; });
    return { ok: ok, checks: checks, typedBytes: typedBytesOf(geography) };
  }

  function listTransferableBuffers(geography) {
    var seen = new Set();
    var buffers = [];
    ARRAY_FIELDS.forEach(function (name) {
      var value = geography && geography[name];
      if (ArrayBuffer.isView(value) && value.buffer && value.buffer.byteLength > 1024 && !seen.has(value.buffer)) {
        seen.add(value.buffer);
        buffers.push(value.buffer);
      }
    });
    return buffers;
  }

  function packGeographyForTransfer(geography) {
    return { message: geography, transfer: listTransferableBuffers(geography) };
  }

  var api = {
    GRID_VERSION: GRID_VERSION,
    NOISE_VERSION: NOISE_VERSION,
    GEOGRAPHY_VERSION: GEOGRAPHY_VERSION,
    PRESET_VERSION: PRESET_VERSION,
    EARTH_RADIUS_KM: EARTH_RADIUS_KM,
    EARTH_CANONICAL_V: EARTH_CANONICAL_V,
    PLATE_COUNT: PLATE_COUNT,
    SURFACE_CLASSES: SURFACE_CLASSES.slice(),
    FIELD_INDEX: FIELD_INDEX,
    ARRAY_FIELDS: ARRAY_FIELDS.slice(),
    DEFAULT_PROFILE: Object.assign({}, DEFAULT_PROFILE),
    xxHash32: xxHash32,
    parseMasterSeedHex: parseMasterSeedHex,
    masterSeedHexFromText: masterSeedHexFromText,
    domainSeed: function (masterSeedHex, domain) {
      return domainSeed(parseMasterSeedHex(masterSeedHex), domain);
    },
    normalizeProfile: normalizeProfile,
    createFieldSampler: createFieldSampler,
    expectedFrequency: expectedFrequency,
    generateGeography: generateGeography,
    generateGeographyAsync: generateGeographyAsync,
    validateGeography: validateGeography,
    typedBytesOf: typedBytesOf,
    listTransferableBuffers: listTransferableBuffers,
    packGeographyForTransfer: packGeographyForTransfer
  };
  /* global module */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlanetGeography = api;
})(typeof window !== 'undefined' ? window : globalThis);

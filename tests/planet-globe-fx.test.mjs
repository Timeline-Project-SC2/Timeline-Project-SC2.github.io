// Модульные тесты плагина FX боевого глобуса (Волна PR 6.1, Воркер 1):
//   1. раскладка осколков computeShardLayout во всех трёх режимах распределения
//      (equal / power / lognormal) на реальной сетке Голдберга;
//   2. монотонность «потерь» осколков (shardLoss) в текстуре uShardTex;
//   3. клеточный индекс осколка: все вершины одной ячейки получают ОДИН
//      индекс (иначе треугольники веера растягиваются через всю планету);
//   4. хуки контроллера FX (decorateSurfaceShaders / onGeometryReady /
//      onAfterSurfaceDraw / onDispose) и separationVisuals;
//   5. объём осколков: индексы в диапазоне и точный шов кромки стенки с
//      вершинами поверхности (с рельефом).
//
// Запуск: node --test tests/planet-globe-fx.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const PlanetGlobe = require('../site/shared/planet-globe.ts').default;
const PlanetFx = require('../src/planet/planet-globe-fx.ts');

const SMALL_V = 8;
const V = 16;
const SMALL_GRID = GeodesicGrid.build(SMALL_V);
const GRID = GeodesicGrid.build(V);

const SURFACE_INPUT = {
  masterSeedHex: '0123456789abcdef',
  radiusKm: 6371,
  surfaceClass: 'terrestrial',
  geographyVersion: 'c100-soft-v2',
  continentMeanCells: 7,
  oceanBasinMeanCells: 94,
  drainageMeanCells: 2,
  coastSoftWidthCells: 0.375,
  continentSoftWidthCells: 0.5,
  biomeSoftWidthCells: 0.25,
};
const SURFACE = PlanetSurface.generateSurface(GRID, SURFACE_INPUT);
const GEOMETRY = PlanetGlobe.buildGlobeGeometry(GRID, SURFACE, { colorMode: 'biome' });

/** Параметры осколков как у стенда: 10 осколков, разлёт 0.3, дефолты толщины. */
function shardParams(overrides = {}) {
  return {
    count: 10, dist: 'power', sep: 0.3, thick: 0.14, jag: 0.5, loss: 0, seedText: 'shakuras',
    ...overrides,
  };
}

/** Состояние FX как у planet-test: только обязательные поля контракта. */
function fxState(overrides = {}) {
  return {
    separation: 0.3,
    shardMode: true,
    shardCount: 12,
    seedText: 'shakuras',
    theme: { palette: 0, textureMode: 1, textureAmount: 0.45, textureScale: 24, hueShiftDeg: 0 },
    reliefScale: 1,
    ...overrides,
  };
}

/** Старый баг: fxShardIndex квантовал направление ОТДЕЛЬНОЙ вершины в GLSL. */
function legacyVertexShardIndex(x, y, z, count) {
  const len = Math.hypot(x, y, z) || 1;
  const scale = count * 0.5;
  const q = [
    Math.floor((x / len) * scale) + 0.5,
    Math.floor((y / len) * scale) + 0.5,
    Math.floor((z / len) * scale) + 0.5,
  ];
  const s = Math.sin(q[0] * 12.9898 + q[1] * 78.233 + q[2] * 37.719) * 43758.5453;
  const fract = s - Math.floor(s);
  return Math.floor(fract * count);
}

/** Индексы осколков вершин одной ячейки (центр + её углы) по vertexCellId. */
function cellVertexRanges(cellCount) {
  const starts = new Uint32Array(cellCount + 1);
  // Порядок вершин planet-globe-v1: F центров, затем слоты углов по ячейкам.
  let slot = cellCount;
  for (let c = 0; c < cellCount; c++) {
    starts[c] = slot;
    slot += GRID.cellCornerStart[c + 1] - GRID.cellCornerStart[c];
  }
  starts[cellCount] = slot;
  return starts;
}

// ---------------------------------------------------------------------------
// 1. Раскладка осколков: три режима распределения на реальной сетке
// ---------------------------------------------------------------------------
for (const dist of ['equal', 'power', 'lognormal']) {
  test(`computeShardLayout: режим ${dist} на сетке v=${SMALL_V}`, () => {
    const layout = PlanetFx.computeShardLayout(SMALL_GRID, shardParams({ dist }));
    assert.ok(layout, 'layout должен строиться для count > 1');
    assert.equal(layout.count, 10);
    assert.equal(layout.shardOf.length, SMALL_GRID.cellCount);

    let total = 0;
    let used = 0;
    for (let i = 0; i < layout.count; i++) {
      total += layout.counts[i];
      if (layout.counts[i] > 0) used++;
    }
    // Каждая ячейка принадлежит ровно одному осколку.
    assert.equal(total, SMALL_GRID.cellCount);
    assert.ok(used >= 2, `должно быть занято несколько осколков, занято ${used}`);
    assert.ok(layout.nonEmpty >= 2);
    for (let c = 0; c < SMALL_GRID.cellCount; c++) {
      const s = layout.shardOf[c];
      assert.ok(s >= 0 && s < layout.count, `индекс осколка ${s} вне [0, ${layout.count})`);
      assert.ok(layout.counts[s] > 0);
    }
    // Трансформы осколков конечны и единичны по pivot/axis.
    for (let i = 0; i < layout.count; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const p = layout.pivots[i * 3 + axis];
        const a = layout.axes[i * 3 + axis];
        const d = layout.driftVec[i * 3 + axis];
        assert.ok(Number.isFinite(p) && Number.isFinite(a) && Number.isFinite(d));
      }
      const pl = Math.hypot(layout.pivots[i * 3], layout.pivots[i * 3 + 1], layout.pivots[i * 3 + 2]);
      const al = Math.hypot(layout.axes[i * 3], layout.axes[i * 3 + 1], layout.axes[i * 3 + 2]);
      assert.ok(Math.abs(pl - 1) < 1e-4, `pivot осколка ${i} не единичный: ${pl}`);
      assert.ok(Math.abs(al - 1) < 1e-4, `axis осколка ${i} не единичный: ${al}`);
      assert.ok(layout.spin[i] >= -0.7 && layout.spin[i] <= 0.7);
    }
  });
}

test('computeShardLayout: детерминированность (тот же seed и параметры)', () => {
  const a = PlanetFx.computeShardLayout(SMALL_GRID, shardParams({ dist: 'power' }));
  const b = PlanetFx.computeShardLayout(SMALL_GRID, shardParams({ dist: 'power' }));
  assert.deepEqual(Array.from(a.shardOf), Array.from(b.shardOf));
  assert.deepEqual(Array.from(a.pivots), Array.from(b.pivots));
});

// ---------------------------------------------------------------------------
// 2. shardLoss: монотонность доли «потерянных» осколков
// ---------------------------------------------------------------------------
test('buildShardTextureData: монотонность shardLoss', () => {
  const layout = PlanetFx.computeShardLayout(SMALL_GRID, shardParams({ dist: 'power' }));
  const losses = [0, 0.2, 0.4, 0.6, 0.9];
  let prevLost = -1;
  let prevMaxB = -1;
  for (const loss of losses) {
    const built = PlanetFx.buildShardTextureData(layout, loss);
    assert.ok(built.data, 'текстура uShardTex обязана строиться');
    assert.equal(built.data.length, PlanetFx.MAX_SHARDS * 4 * 4);
    assert.ok(built.shardInfo, 'shardInfo обязателен при наличии layout');
    assert.ok(built.shardInfo.lost >= prevLost,
      `lost не убывает: loss=${loss} дал ${built.shardInfo.lost} после ${prevLost}`);
    assert.ok(built.shardMaxB >= prevMaxB);
    assert.ok(built.shardInfo.lost <= Math.max(0, built.shardInfo.nonEmpty - 1));
    if (loss === 0) {
      assert.equal(built.shardInfo.lost, 0);
      assert.equal(built.shardMaxB, 0);
    } else {
      // Есть потерянные осколки — терминальный разлёт b=0.75 виден в текстуре.
      assert.equal(built.shardMaxB, 0.75);
      let lostRows = 0;
      for (let i = 0; i < layout.count; i++) {
        const row = PlanetFx.MAX_SHARDS * 3 + i;
        const pa = built.data[row * 4 + 1];
        const pb = built.data[row * 4 + 2];
        if (pb > 0) {
          lostRows++;
          // Float32-текстура: сравнение с точностью до одного разряда.
          assert.ok(Math.abs(pa - 1.35) < 1e-5, `a потерянного осколка ${pa}`);
          assert.ok(Math.abs(pb - 0.75) < 1e-5, `b потерянного осколка ${pb}`);
        }
      }
      assert.equal(lostRows, built.shardInfo.lost);
    }
    prevLost = built.shardInfo.lost;
    prevMaxB = built.shardMaxB;
  }
  // Хвост параметров 2…MAX_SHARDS: count > MAX_SHARDS обрезается в шейдере,
  // а раскладка не строится для count <= 1.
  assert.equal(PlanetFx.computeShardLayout(SMALL_GRID, shardParams({ count: 1 })), null);
});

// ---------------------------------------------------------------------------
// 3. Клеточный индекс осколка: внутри ячейки индекс не меняется
// ---------------------------------------------------------------------------
test(`клеточный индекс осколка: веера ячеек (v=${V}) не растягиваются`, () => {
  const layout = PlanetFx.computeShardLayout(GRID, shardParams());
  const perVertex = PlanetFx.expandVertexShardIndices(layout, GEOMETRY.vertexCellId);
  assert.equal(perVertex.length, GEOMETRY.vertexCount);

  // Каждая вершина получает индекс осколка своей ячейки.
  for (let v = 0; v < GEOMETRY.vertexCount; v++) {
    assert.equal(perVertex[v], layout.shardOf[GEOMETRY.vertexCellId[v]]);
  }

  // Все вершины одной ячейки — строго один индекс осколка.
  const ranges = cellVertexRanges(GRID.cellCount);
  let splitCells = 0;
  for (let c = 0; c < GRID.cellCount; c++) {
    const first = perVertex[c];
    for (let v = ranges[c]; v < ranges[c + 1]; v++) {
      if (perVertex[v] !== first) {
        splitCells++;
        break;
      }
    }
  }
  assert.equal(splitCells, 0, `ячеек с разными осколками: ${splitCells}`);

  // И каждый треугольник целиком лежит в одном осколке.
  let splitTris = 0;
  for (let i = 0; i < GEOMETRY.indices.length; i += 3) {
    const a = perVertex[GEOMETRY.indices[i]];
    const b = perVertex[GEOMETRY.indices[i + 1]];
    const d = perVertex[GEOMETRY.indices[i + 2]];
    if (a !== b || b !== d) splitTris++;
  }
  assert.equal(splitTris, 0, `треугольников через границу осколков: ${splitTris}`);

  // Контроль: прежний путь (квантование направления каждой вершины в GLSL)
  // рвал веера — тест обязан это ловить.
  let legacySplit = 0;
  for (let c = 0; c < GRID.cellCount; c++) {
    const first = legacyVertexShardIndex(
      GEOMETRY.positions[c * 3], GEOMETRY.positions[c * 3 + 1], GEOMETRY.positions[c * 3 + 2], 12);
    for (let v = ranges[c]; v < ranges[c + 1]; v++) {
      const idx = legacyVertexShardIndex(
        GEOMETRY.positions[v * 3], GEOMETRY.positions[v * 3 + 1], GEOMETRY.positions[v * 3 + 2], 12);
      if (idx !== first) {
        legacySplit++;
        break;
      }
    }
  }
  assert.ok(legacySplit > GRID.cellCount * 0.1,
    `старый fxShardIndex должен ломать больше 10% ячеек, сломал ${legacySplit}`);
});

test('expandVertexShardIndices: без layout — нули, вне диапазона — 0', () => {
  const zeros = PlanetFx.expandVertexShardIndices(null, new Uint32Array([0, 1, 2]));
  assert.deepEqual(Array.from(zeros), [0, 0, 0]);
  const layout = { shardOf: new Uint16Array([1, 0]) };
  const out = PlanetFx.expandVertexShardIndices(layout, new Uint32Array([0, 1, 7]));
  assert.deepEqual(Array.from(out), [1, 0, 0]);
});

// ---------------------------------------------------------------------------
// 4. Хуки контроллера FX и separationVisuals
// ---------------------------------------------------------------------------
test('createFxHooks: полный набор хуков контроллера', () => {
  const hooks = PlanetFx.createFxHooks(fxState());
  for (const name of ['decorateSurfaceShaders', 'onSurfaceProgram', 'onSurfaceDraw',
    'onGeometryReady', 'onAfterSurfaceDraw', 'onDispose']) {
    assert.equal(typeof hooks[name], 'function', `нет хука ${name}`);
  }
  assert.equal(typeof PlanetFx.separationVisuals, 'function');
  assert.equal(PlanetFx.PLANET_GLOBE_FX_VERSION, 'planet-globe-fx-v1');
});

test('decorateSurfaceShaders: клеточный индекс вместо квантования нормали', () => {
  const source = readFileSync(new URL('../site/shared/planet-globe.ts', import.meta.url), 'utf8');
  // Маркеры, по которым плагин вставляет код, должны жить в боевом шейдере.
  for (const marker of ['void main() {', 'vec4 wp = uModel * vec4(aPos, 1.0);',
    'gl_Position = uMvp * vec4(aPos, 1.0);', 'vec3 col = vColor * light;']) {
    assert.ok(source.includes(marker), `боевой планетарный шейдер потерял маркер ${marker}`);
  }
  assert.ok(source.includes('layout(location=2) in vec4 aNormal;'),
    'клеточный резерв опирается на aNormal');

  const hooks = PlanetFx.createFxHooks(fxState());
  const vs = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'layout(location=2) in vec4 aNormal;',
    'uniform mat4 uMvp;',
    'uniform mat4 uModel;',
    'void main() {',
    '  vec4 wp = uModel * vec4(aPos, 1.0);',
    '  gl_Position = uMvp * vec4(aPos, 1.0);',
    '}',
  ].join('\n');
  const fs = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vColor;',
    'out vec4 fragColor;',
    'void main() {',
    '  vec3 col = vColor * light;',
    '  fragColor = vec4(col, 1.0);',
    '}',
  ].join('\n');
  const out = hooks.decorateSurfaceShaders({ vs, fs });
  assert.ok(out.vs.includes('usampler2D uShardIdTex'), 'нет текстуры клеточных индексов');
  assert.ok(out.vs.includes('gl_VertexID'), 'индекс осколка обязан читаться по gl_VertexID');
  assert.ok(out.vs.includes('fxShardIndexFallback'), 'нет резерва без сетки');
  assert.ok(out.vs.includes('fxShardPosition(aPos, aNormal.xyz)'));
  assert.ok(out.vs.includes('vec4 wp = uModel * vec4(fxPos, 1.0);'));
  assert.ok(out.fs.includes('paletteColor'));
  assert.ok(out.fs.includes('fxTexture'));
  // Ни одного обращения к стационарной (не клеточной) функции больше нет.
  assert.ok(!out.vs.includes('fxShardIndex(aPos)'));
});

test('separationVisuals: затухание атмосферы и видимость ядра', () => {
  assert.deepEqual(PlanetFx.separationVisuals(0, false, 0), { atmoFade: 1, coreVisible: false });
  const collapsed = PlanetFx.separationVisuals(0, true, 0);
  assert.equal(collapsed.coreVisible, false);
  assert.equal(collapsed.atmoFade, 1);
  const exploded = PlanetFx.separationVisuals(0.3, true, 0.75);
  assert.equal(exploded.coreVisible, true);
  assert.ok(exploded.atmoFade > 0 && exploded.atmoFade < 1);
  assert.equal(PlanetFx.separationVisuals(2.1, true, 0.75).atmoFade, 0);
});

test('shardParamsFromState: дефолты опциональных полей контракта', () => {
  const defaults = PlanetFx.shardParamsFromState(fxState());
  assert.equal(defaults.dist, 'power');
  assert.equal(defaults.thick, 0.14);
  assert.equal(defaults.jag, 0.5);
  assert.equal(defaults.loss, 0);
  assert.equal(defaults.count, 12);
  const filled = PlanetFx.shardParamsFromState(fxState({
    shardDist: 'lognormal', shardThick: 0.05, shardJag: 0.95, shardLoss: 0.4, shardCount: 999,
  }));
  assert.equal(filled.dist, 'lognormal');
  assert.equal(filled.thick, 0.05);
  assert.equal(filled.jag, 0.95);
  assert.equal(filled.loss, 0.4);
  assert.equal(filled.count, PlanetFx.MAX_SHARDS, 'count обрезается до MAX_SHARDS');
});

// ---------------------------------------------------------------------------
// 4.1. GPU-путь хуков на записывающем mock WebGL2 (браузера в тестах нет)
// ---------------------------------------------------------------------------
function makeFakeGl() {
  const calls = [];
  const GL = {
    MAX_TEXTURE_SIZE: 0x0D33, DEPTH_WRITEMASK: 0x0B72, COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82, VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
    TEXTURE_2D: 0x0DE1, RGBA32F: 0x8814, R32UI: 0x8236, RGBA: 0x1908,
    RED_INTEGER: 0x8D94, FLOAT: 0x1406, UNSIGNED_INT: 0x1405, UNSIGNED_BYTE: 0x1401,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88E4,
    TRIANGLES: 0x0004, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812F, UNPACK_ALIGNMENT: 0x0CF5, TEXTURE0: 0x84C0,
    TEXTURE2: 0x84C2, TEXTURE3: 0x84C3, CULL_FACE: 0x0B44, BLEND: 0x0BE2,
    DEPTH_TEST: 0x0B71, BACK: 0x0405,
  };
  let nextId = 1;
  const handle = () => ({ id: nextId++ });
  const record = (name) => (...args) => {
    calls.push({ name, args });
    if (name === 'createTexture' || name === 'createShader' || name === 'createProgram'
      || name === 'createBuffer' || name === 'createVertexArray') return handle();
    if (name === 'getUniformLocation') return handle();
    if (name === 'getShaderParameter' || name === 'getProgramParameter') return true;
    if (name === 'getShaderInfoLog' || name === 'getProgramInfoLog') return '';
    if (name === 'isEnabled') return false;
    if (name === 'getParameter') {
      return args[0] === GL.DEPTH_WRITEMASK ? true : 4096;
    }
    return undefined;
  };
  const names = ['createTexture', 'bindTexture', 'texImage2D', 'texParameteri', 'pixelStorei',
    'deleteTexture', 'createShader', 'shaderSource', 'compileShader', 'getShaderParameter',
    'getShaderInfoLog', 'deleteShader', 'createProgram', 'attachShader', 'linkProgram',
    'getProgramParameter', 'getProgramInfoLog', 'deleteProgram', 'getUniformLocation',
    'createVertexArray', 'bindVertexArray', 'deleteVertexArray', 'createBuffer', 'bindBuffer',
    'bufferData', 'deleteBuffer', 'enableVertexAttribArray', 'vertexAttribPointer', 'useProgram',
    'uniform1f', 'uniform1i', 'uniform3f', 'uniformMatrix4fv', 'drawElements', 'isEnabled',
    'enable', 'disable', 'depthMask', 'cullFace', 'activeTexture', 'getParameter'];
  const gl = { ...GL, calls };
  for (const name of names) gl[name] = record(name);
  return gl;
}

test('GPU-путь: индекс осколка, объём разломов, ядро и освобождение ресурсов', () => {
  const gl = makeFakeGl();
  const hooks = PlanetFx.createFxHooks(fxState({ separation: 0.6, coreScale: 0.5 }));
  const program = { id: 0 };
  hooks.onGeometryReady(gl, GRID, GEOMETRY);
  hooks.onSurfaceProgram(gl, program);
  hooks.onSurfaceDraw(gl, program);
  hooks.onAfterSurfaceDraw(gl, {
    mvp: new Float32Array(16), model: new Float32Array(16),
    normalMat: new Float32Array(9), lightDir: new Float32Array([0.5, 0.3, 0.8]),
    eyePos: new Float32Array([0, 0, 2.6]), timeSec: 1.5,
  });

  const byName = (name) => gl.calls.filter((c) => c.name === name);
  // Текстура клеточного индекса: R32UI, ширина 1024, строк — по числу вершин.
  const idUpload = byName('texImage2D').find((c) => c.args[2] === gl.R32UI);
  assert.ok(idUpload, 'нет заливки текстуры индексов осколков');
  assert.equal(idUpload.args[3], 1024);
  assert.equal(idUpload.args[4], Math.ceil(GEOMETRY.vertexCount / 1024));
  // texImage2D(target, level, internalformat, width, height, border, format, type, data)
  assert.equal(idUpload.args[6], gl.RED_INTEGER);
  assert.equal(idUpload.args[7], gl.UNSIGNED_INT);
  assert.equal(idUpload.args[8].length, 1024 * idUpload.args[4]);
  // Трансформы осколков: 64×4 RGBA32F.
  const shardUpload = byName('texImage2D').find((c) => c.args[2] === gl.RGBA32F);
  assert.ok(shardUpload, 'нет заливки текстуры трансформов осколков');
  assert.equal(shardUpload.args[3], PlanetFx.MAX_SHARDS);
  assert.equal(shardUpload.args[4], 4);

  const draws = byName('drawElements');
  assert.equal(draws.length, 2, 'ожидались две отрисовки: объём осколков и ядро');
  for (const draw of draws) assert.ok(draw.args[1] > 0);
  // Ядро — первичная триангуляция сетки.
  assert.equal(draws[1].args[1], GRID.triangles.length);
  const programs = byName('linkProgram').length;
  assert.equal(programs, 2, 'поверхность + две программы эффектов не должны дублироваться');

  hooks.onDispose(gl);
  assert.equal(byName('deleteProgram').length, 2);
  assert.equal(byName('deleteVertexArray').length, 2);
  assert.ok(byName('deleteTexture').length >= 2);
  assert.ok(byName('deleteBuffer').length >= 8);
});

// ---------------------------------------------------------------------------
// 5. Объём осколков: геометрия разломов и шов с поверхностью
// ---------------------------------------------------------------------------
test('buildVolumeArrays: индексы, виды вершин и точный шов кромки', () => {
  const F = GRID.cellCount;
  const params = shardParams({ loss: 0.25 });
  const layout = PlanetFx.computeShardLayout(GRID, params);
  const volume = PlanetFx.buildVolumeArrays(
    GRID, layout, params, GEOMETRY.positions, new Float32Array(F));
  assert.ok(volume, 'объём обязан строиться при наличии layout');

  const vertexCount = volume.positions.length / 3;
  assert.ok(vertexCount > F, `вершин объёма ${vertexCount} должно быть больше числа ячеек ${F}`);
  assert.equal(volume.indexCount % 3, 0);
  assert.equal(volume.indices.length, volume.indexCount);
  assert.equal(volume.colors.length, vertexCount * 3);
  assert.equal(volume.emissive.length, vertexCount);
  assert.equal(volume.shard.length, vertexCount);
  assert.equal(volume.kind.length, vertexCount);
  for (let i = 0; i < volume.indexCount; i++) {
    assert.ok(volume.indices[i] < vertexCount, `индекс ${volume.indices[i]} вне вершин`);
  }
  let walls = 0;
  let shells = 0;
  for (let i = 0; i < vertexCount; i++) {
    if (volume.kind[i] > 0.5) shells++; else walls++;
    assert.ok(volume.emissive[i] >= 0 && volume.emissive[i] <= 1, 'эмиссия вне [0, 1]');
    assert.ok(volume.shard[i] >= 0 && volume.shard[i] < layout.count);
  }
  assert.ok(walls > 0 && shells > 0, 'нужны и стенки разломов, и нижняя оболочка');

  // Нижняя оболочка закрыта: глубина 1 − thick, её вершины внутри сферы.
  const thickEff = params.thick * (1 - 0.45 * params.loss);
  let minRadius = Infinity;
  let maxRadius = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const r = Math.hypot(volume.positions[i * 3], volume.positions[i * 3 + 1], volume.positions[i * 3 + 2]);
    minRadius = Math.min(minRadius, r);
    maxRadius = Math.max(maxRadius, r);
  }
  assert.ok(minRadius >= 1 - thickEff * 1.3 - 1e-5, `низ слишком глубокий: ${minRadius}`);
  assert.ok(maxRadius <= 1.05, `кромка стенки выше поверхности: ${maxRadius}`);

  // Кромка стенки садится ровно на вершины поверхности (с рельефом):
  // иначе при разлёте между осколком и его стенкой появляется щель.
  const vertexKeys = new Set();
  for (let i = 0; i < vertexCount; i++) {
    vertexKeys.add(volume.positions[i * 3].toFixed(4) + '|' +
      volume.positions[i * 3 + 1].toFixed(4) + '|' + volume.positions[i * 3 + 2].toFixed(4));
  }
  function sideNeighbor(cell, t1, t2) {
    let other = -1;
    for (let i = 0; i < 3; i++) {
      const a = GRID.triangles[t1 * 3 + i];
      for (let j = 0; j < 3; j++) {
        if (a === GRID.triangles[t2 * 3 + j] && a !== cell) other = a;
      }
    }
    return other;
  }
  let seamCorners = 0;
  for (let c = 0; c < F; c++) {
    const start = GRID.cellCornerStart[c];
    const sides = GRID.cellCornerStart[c + 1] - start;
    for (let k = 0; k < sides; k++) {
      const t1 = GRID.cellCorners[start + k];
      const t2 = GRID.cellCorners[start + ((k + 1) % sides)];
      const nb = sideNeighbor(c, t1, t2);
      if (nb < 0 || layout.shardOf[nb] === layout.shardOf[c]) continue;
      const slot = F + start + k;
      const key = GEOMETRY.positions[slot * 3].toFixed(4) + '|' +
        GEOMETRY.positions[slot * 3 + 1].toFixed(4) + '|' + GEOMETRY.positions[slot * 3 + 2].toFixed(4);
      assert.ok(vertexKeys.has(key), `кромка стенки ячейки ${c} не совпала с поверхностью`);
      seamCorners++;
    }
  }
  assert.ok(seamCorners > 0, 'на v=16 должны быть границы осколков');
});

test('buildGeometry: поверхность и объём спайка согласованы', () => {
  const params = shardParams({ dist: 'equal' });
  const noise = require('../site/shared/planet-noise.ts').default;
  const F = SMALL_GRID.cellCount;
  const sampler = noise.createSampler({ seedText: 'korhal-iv', kind: 'simplex' });
  const elev = new Float32Array(F);
  const moist = new Float32Array(F);
  const temp = new Float32Array(F);
  const out = [0, 0, 0];
  let minE = Infinity;
  let maxE = -Infinity;
  for (let c = 0; c < F; c++) {
    sampler.sample(SMALL_GRID.centers[c * 3], SMALL_GRID.centers[c * 3 + 1], SMALL_GRID.centers[c * 3 + 2], out);
    elev[c] = out[0];
    moist[c] = out[1];
    temp[c] = out[2];
    minE = Math.min(minE, out[0]);
    maxE = Math.max(maxE, out[0]);
  }
  const built = PlanetFx.buildGeometry(SMALL_GRID,
    { elev, moist, temp, sea: 0, minE, maxE, masterSeed: sampler.masterSeed },
    params, noise, { includeVolume: true });
  const sides = SMALL_GRID.cellCorners.length;
  assert.equal(built.surface.vertexCount, F + sides);
  assert.equal(built.surface.indexCount, sides * 3);
  assert.equal(built.surface.cellIndexStart[F], built.surface.indexCount);
  assert.equal(built.shardMode, 1);
  assert.ok(built.volume && built.volume.indexCount > 0);
  assert.equal(built.cellData.colors.length, F * 3);
  assert.equal(built.cellData.fieldCells.length, F * 4);
  // Все вершины одной ячейки (центр и углы) помечены одним осколком и в
  // массивах поверхности спайка.
  for (let c = 0; c < F; c++) {
    const s = built.surface.shard[c];
    const start = SMALL_GRID.cellCornerStart[c];
    const count = SMALL_GRID.cellCornerStart[c + 1] - start;
    for (let k = 0; k < count; k++) {
      assert.equal(built.surface.shard[F + start + k], s);
    }
  }
});

test('GPU-путь /planet-test/: wireGeometry без vertexCellId + state.grid восстанавливает R32UI и объём', () => {
  const gl = makeFakeGl();
  const wireGeometry = { ...GEOMETRY };
  delete wireGeometry.vertexCellId;
  delete wireGeometry.cellIndexStart;

  const state = fxState({
    separation: 0.6,
    coreScale: 0.5,
    grid: GRID,
    geometry: wireGeometry,
  });
  const hooks = PlanetFx.createFxHooks(state);
  const program = { id: 0 };
  // Даже если рендерер передал не-сетку вторым аргументом, state.grid не затирается.
  hooks.onGeometryReady(gl, /** @type {any} */ (wireGeometry), wireGeometry);
  hooks.onSurfaceProgram(gl, program);
  hooks.onSurfaceDraw(gl, program);
  hooks.onAfterSurfaceDraw(gl, {
    mvp: new Float32Array(16), model: new Float32Array(16),
    normalMat: new Float32Array(9), lightDir: new Float32Array([0.5, 0.3, 0.8]),
    eyePos: new Float32Array([0, 0, 2.6]), timeSec: 1.5,
  });

  assert.ok(wireGeometry.vertexCellId instanceof Uint32Array, 'vertexCellId должен восстановиться из state.grid');
  assert.deepEqual(wireGeometry.vertexCellId, GEOMETRY.vertexCellId);

  const byName = (name) => gl.calls.filter((c) => c.name === name);
  const idUpload = byName('texImage2D').find((c) => c.args[2] === gl.R32UI);
  assert.ok(idUpload, 'текстура R32UI обязана заливаться и для wireGeometry');
  const draws = byName('drawElements');
  assert.equal(draws.length, 2, 'объём разломов и ядро обязаны отрисоваться на wireGeometry');
  hooks.onDispose(gl);
});


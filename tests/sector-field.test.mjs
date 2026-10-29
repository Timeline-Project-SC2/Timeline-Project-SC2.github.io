import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const fieldModule = require('../src/atlas/sector-field.ts');
const {
  FIELD_SEED_TEXT,
  FIELD_PALETTES,
  LOCAL_FADE_FROM,
  LOCAL_FADE_TO,
  createSectorField,
  hashSeed,
  sampleNebulaDensity,
} = fieldModule;
const { edgeDistance, fitScaleFor, maxScaleForTargetWidth } = require('../src/atlas/level-ladder.ts');
const { CONFIG } = require('../src/atlas/config.ts');

const MAP_SIZE = 10000;
/** Ширины кадра для проверок: вся карта и глубокая апертура `L9`. */
const LEVEL_WIDTHS = [10000, 625, 10000 / 512];
const SMALL = 64;

/** Состояние кадра такой ширины, что в него попадает ровно `visibleWidth` мировых единиц. */
function stateForWidth(visibleWidth, size = SMALL) {
  const scale = size / visibleWidth;
  return {
    view: { scale, tx: size / 2 - (MAP_SIZE / 2) * scale, ty: size / 2 - (MAP_SIZE / 2) * scale },
    viewport: { w: size, h: size },
    dpr: 1,
    mapSize: MAP_SIZE,
  };
}

function digest(data) {
  return createHash('sha256').update(Buffer.from(data.buffer, data.byteOffset, data.byteLength)).digest('hex');
}

function uniqueColors(data) {
  const seen = new Set();
  for (let index = 0; index < data.length; index += 4) {
    seen.add((data[index] << 16) | (data[index + 1] << 8) | data[index + 2]);
  }
  return seen.size;
}

test('hashSeed: детерминирован, различает строки и совпадает с xxHash32', () => {
  assert.equal(FIELD_SEED_TEXT, 'KP');
  assert.equal(hashSeed('KP'), hashSeed('KP'));
  assert.notEqual(hashSeed('KP'), hashSeed('KQ'));
  assert.notEqual(hashSeed(''), hashSeed('K'));
  // Значение зафиксировано по эталонной реализации xxHash32 (seed 0).
  assert.equal(hashSeed('KP'), 0xdf8e5bbd);
  assert.equal(hashSeed(''), 0x02cc5d05);
  assert.ok(hashSeed('KP') >= 0 && hashSeed('KP') <= 0xffffffff);
  for (const text of ['a'.repeat(15), 'a'.repeat(16), 'a'.repeat(17), 'сектор Копрулу']) {
    assert.equal(hashSeed(text), hashSeed(text), text);
    assert.ok(hashSeed(text) <= 0xffffffff, text);
  }
});

test('FIELD_PALETTES: ровно два пресета с заполненными полями и растущими densityStops', () => {
  assert.equal(FIELD_PALETTES.length, 2);
  assert.deepEqual(FIELD_PALETTES.map(({ id }) => id).sort(), ['nebula', 'tactical']);

  for (const palette of FIELD_PALETTES) {
    for (const key of ['background', 'dust', 'core', 'rim']) {
      const color = palette[key];
      assert.equal(color.length, 3, `${palette.id}.${key}`);
      for (const channel of color) {
        assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255, `${palette.id}.${key}`);
      }
    }
    assert.ok(Array.isArray([...palette.densityStops]), palette.id);
    assert.ok(palette.densityStops.length >= 2, palette.id);
    for (let index = 1; index < palette.densityStops.length; index++) {
      assert.ok(
        palette.densityStops[index] > palette.densityStops[index - 1],
        `${palette.id}: densityStops не возрастает на ${index}`,
      );
    }
    assert.ok(palette.densityStops[0] >= 0, palette.id);
    assert.ok(palette.densityStops[palette.densityStops.length - 1] <= 1, palette.id);
  }

  // Яркость по §17.12 `V-1`: core > rim >= dust > background. Иначе «ободок»
  // светлее ядра и рампа даёт бирюзовые блины вместо волокон.
  for (const palette of FIELD_PALETTES) {
    const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const core = luminance(palette.core);
    const rim = luminance(palette.rim);
    const dust = luminance(palette.dust);
    const background = luminance(palette.background);
    assert.ok(core > rim, `${palette.id}: core ${core.toFixed(1)} не ярче rim ${rim.toFixed(1)}`);
    assert.ok(rim >= dust, `${palette.id}: rim ${rim.toFixed(1)} темнее dust ${dust.toFixed(1)}`);
    assert.ok(dust > background, `${palette.id}: dust ${dust.toFixed(1)} не ярче background ${background.toFixed(1)}`);
  }

  // Пресеты должны различаться цветом, иначе ?style=tactical ничего не меняет.
  const nebula = FIELD_PALETTES.find(({ id }) => id === 'nebula');
  const tactical = FIELD_PALETTES.find(({ id }) => id === 'tactical');
  assert.notDeepEqual(nebula.background, tactical.background);
  assert.notDeepEqual(nebula.core, tactical.core);
});

test('createSectorField: без холста — cpu, дефолт nebula, явный tactical и неизвестный стиль', () => {
  const fallback = createSectorField(null);
  assert.equal(fallback.backend, 'cpu');
  assert.equal(fallback.style, 'nebula');
  fallback.dispose();

  const tactical = createSectorField(null, { style: 'tactical' });
  assert.equal(tactical.backend, 'cpu');
  assert.equal(tactical.style, 'tactical');
  tactical.dispose();

  // Значение из `?style=` может быть любым: исключения быть не должно.
  for (const style of ['neon', '', 'NEBULA', undefined]) {
    const unknown = createSectorField(null, { style });
    assert.equal(unknown.backend, 'cpu');
    assert.equal(unknown.style, 'nebula');
    unknown.dispose();
  }
});

test('renderToImageData: размеры, длина данных и непрозрачная альфа', () => {
  const field = createSectorField(null);
  const image = field.renderToImageData({ ...stateForWidth(625), viewport: { w: 40, h: 26 }, dpr: 2 });
  assert.equal(image.width, 80);
  assert.equal(image.height, 52);
  assert.equal(image.data.length, image.width * image.height * 4);
  assert.ok(image.data instanceof Uint8ClampedArray);
  for (let index = 3; index < image.data.length; index += 4) {
    assert.equal(image.data[index], 255);
  }

  // Кривое состояние не должно ронять рендер и не должно давать пустой кадр.
  const degenerate = field.renderToImageData({
    view: { scale: 0, tx: Number.NaN, ty: Number.NaN },
    viewport: { w: 0, h: 0 },
    dpr: 1,
    mapSize: MAP_SIZE,
  });
  assert.ok(degenerate.width >= 1 && degenerate.height >= 1);
  assert.equal(degenerate.data.length, degenerate.width * degenerate.height * 4);
  field.dispose();
});

test('детерминизм CPU: два прогона дают побитово равный ImageData', () => {
  for (const width of LEVEL_WIDTHS) {
    const state = stateForWidth(width);
    const first = createSectorField(null).renderToImageData(state);
    const second = createSectorField(null).renderToImageData(state);
    assert.equal(digest(first.data), digest(second.data), `ширина ${width}`);
  }

  // Пресеты — разные поля, но каждый сам по себе воспроизводим.
  const tacticalOne = createSectorField(null, { style: 'tactical' }).renderToImageData(stateForWidth(625));
  const tacticalTwo = createSectorField(null, { style: 'tactical' }).renderToImageData(stateForWidth(625));
  assert.equal(digest(tacticalOne.data), digest(tacticalTwo.data));
  const nebula = createSectorField(null).renderToImageData(stateForWidth(625));
  assert.notEqual(digest(nebula.data), digest(tacticalOne.data));
});

test('кадр не пустой: на L0 и L9 больше одного уникального цвета', () => {
  for (const width of [LEVEL_WIDTHS[0], LEVEL_WIDTHS[2]]) {
    const image = createSectorField(null).renderToImageData(stateForWidth(width));
    const colors = uniqueColors(image.data);
    assert.ok(colors > 1, `ширина ${width}: уникальных цветов ${colors}`);
    assert.ok(colors > 64, `ширина ${width}: слишком однородный кадр, цветов ${colors}`);
  }
});

test('сдвиг камеры меняет кадр, а одинаковое состояние — нет', () => {
  const base = stateForWidth(625);
  const shifted = {
    ...base,
    view: { scale: base.view.scale, tx: base.view.tx + 97.5, ty: base.view.ty - 23.25 },
  };
  const baseImage = createSectorField(null).renderToImageData(base);
  const shiftedImage = createSectorField(null).renderToImageData(shifted);
  assert.notEqual(digest(baseImage.data), digest(shiftedImage.data));
});

test('renderField без canvas не бросает, dispose идемпотентен', () => {
  const field = createSectorField(null);
  const state = stateForWidth(625);
  assert.doesNotThrow(() => field.renderField(state));
  assert.doesNotThrow(() => field.renderField(state));
  assert.equal(field.backend, 'cpu');
  assert.doesNotThrow(() => field.dispose());
  assert.doesNotThrow(() => field.dispose());
  // После dispose рендер — тихий no-op, а не исключение.
  assert.doesNotThrow(() => field.renderField(state));
  assert.doesNotThrow(() => field.renderToImageData(state));
});

/* --------------------------------------------------- §17.15.6: периодичность поля */

/**
 * Кадр, центрированный на точке мира. Соседний сектор — та же точка ±`MAP_SIZE`,
 * поэтому периодичность проверяется сдвигом камеры ровно на карту.
 */
function centredFrame(centreX, centreY, size = 48, scale = 20) {
  return {
    view: { scale, tx: size / 2 - centreX * scale, ty: size / 2 - centreY * scale },
    viewport: { w: size, h: size },
    dpr: 1,
    mapSize: MAP_SIZE,
  };
}

test('периодичность: сдвиг камеры на mapSize даёт побайтово тот же кадр', () => {
  const probe = 137.5;
  for (const style of ['nebula', 'tactical']) {
    const field = createSectorField(null, { style });
    const base = field.renderToImageData(centredFrame(probe, probe));
    const shifts = [
      ['по x', probe + MAP_SIZE, probe],
      ['по y', probe, probe + MAP_SIZE],
      ['по x и y', probe + MAP_SIZE, probe + MAP_SIZE],
      ['в отрицательную сторону', probe - MAP_SIZE, probe - MAP_SIZE],
    ];
    for (const [title, x, y] of shifts) {
      const probeImage = field.renderToImageData(centredFrame(x, y));
      let differing = 0;
      let maxDelta = 0;
      for (let index = 0; index < base.data.length; index++) {
        const delta = Math.abs(base.data[index] - probeImage.data[index]);
        if (delta !== 0) differing++;
        if (delta > maxDelta) maxDelta = delta;
      }
      assert.equal(differing, 0, `${style}, сдвиг ${title}: несовпавших байт ${differing}, maxΔ=${maxDelta}`);
    }

    // Периодичность обязана держаться и на глубоком зуме, где координаты
    // крупнее: там же лежит пресет «1 св.г. до границы» (§17.15).
    const deep = centredFrame(probe, probe, 48, 512);
    const deepBase = field.renderToImageData(deep);
    const deepShifted = field.renderToImageData({
      ...deep,
      view: { scale: deep.view.scale, tx: deep.view.tx - MAP_SIZE * deep.view.scale, ty: deep.view.ty },
    });
    let deepDiff = 0;
    for (let index = 0; index < deepBase.data.length; index++) {
      if (deepBase.data[index] !== deepShifted.data[index]) deepDiff++;
    }
    assert.equal(deepDiff, 0, `${style}: на зуме ×512 сдвиг по x дал ${deepDiff} несовпавших байт`);
    field.dispose();
  }
});

/* ------------------------------------------------- §17.15.5: глубокий пресет field.local */

const PROXY_SIZE = 72;
const PROXY_FRAMES = 5;

/**
 * Оценка плотности облака по цвету пикселя. Первый отрезок рампы монотонен
 * (`V-1`), поэтому плотность до `densityStops[1]` восстанавливается линейно:
 * `density = stops[1] · (L − L(background)) / (L(dust) − L(background))`.
 * Сравниваем только с порогом `0,02` — он лежит глубоко внутри первого отрезка.
 */
function densityProxy(luminance, palette) {
  const lum = (color) => 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  const background = lum(palette.background);
  const dust = lum(palette.dust);
  const stop = palette.densityStops[1];
  const fraction = (luminance - background) / (dust - background);
  return Math.max(0, Math.min(stop, fraction * stop));
}

/**
 * Кадр с погашенной звездой: минимум по пяти сдвигам камеры на три пикселя.
 * Звёзды радиусом ~1 px движутся вместе с миром, поэтому в любом пикселе
 * оказываются не более чем в одном из пяти кадров — минимум их убирает,
 * а облако остаётся (медиана оставляла 1–2 «упрямых» пикселя).
 */
function cloudWithoutStars(field, base, palette) {
  const frames = [];
  for (let step = 0; step < PROXY_FRAMES; step++) {
    const image = field.renderToImageData({
      ...base,
      view: { scale: base.view.scale, tx: base.view.tx + step * 3, ty: base.view.ty },
    });
    const luminance = new Float64Array(image.width * image.height);
    for (let index = 0; index < luminance.length; index++) {
      luminance[index] = 0.2126 * image.data[index * 4]
        + 0.7152 * image.data[index * 4 + 1]
        + 0.0722 * image.data[index * 4 + 2];
    }
    frames.push(luminance);
  }
  const density = new Float64Array(frames[0].length);
  const column = new Float64Array(PROXY_FRAMES);
  for (let index = 0; index < density.length; index++) {
    for (let step = 0; step < PROXY_FRAMES; step++) column[step] = frames[step][index];
    let lowest = column[0];
    for (let step = 1; step < PROXY_FRAMES; step++) if (column[step] < lowest) lowest = column[step];
    density[index] = densityProxy(lowest, palette);
  }
  return density;
}

/**
 * Один и тот же кадр (видимая ширина `20` ед. карты), в котором меняется
 * только `edgeDist`. Так гашение проверяется на одной сцене: разница кадров —
 * это ровно гашение, а не другой зум. Сигнатура прежняя: `edgeDist` — св.г.,
 * в тех же единицах, что отдаёт сцена (§17.23), без перевода.
 */
function deepFrame(edgeDist, size = PROXY_SIZE) {
  return { ...stateForWidth(20, size), edgeDist };
}

test('глубокий пресет: при edgeDist = 1 св.г. облака нет, при edgeDist = 10 св.г. — есть', () => {
  for (const palette of FIELD_PALETTES) {
    const field = createSectorField(null, { style: palette.id });
    const deep = cloudWithoutStars(field, deepFrame(1), palette);
    let above = 0;
    let peak = 0;
    for (const value of deep) {
      if (value > 0.02) above++;
      if (value > peak) peak = value;
    }
    assert.equal(above, 0, `${palette.id}: при edgeDist = 1 св.г. плотность выше 0,02 у ${above} пикселей (пик ${peak.toFixed(3)})`);

    const far = cloudWithoutStars(field, deepFrame(10), palette);
    let clouded = 0;
    for (const value of far) if (value > 0.02) clouded++;
    const share = clouded / far.length;
    assert.ok(share > 0.3, `${palette.id}: при edgeDist = 10 св.г. облако занимает лишь ${(share * 100).toFixed(1)} % кадра`);

    // Гашение монотонное: доля облака не убывает с ростом edgeDist, ступеньки нет.
    let previous = -1;
    for (const edgeDist of [1, 1.5, 2, 3, 4, 10]) {
      const density = cloudWithoutStars(field, deepFrame(edgeDist), palette);
      let seen = 0;
      for (const value of density) if (value > 0.02) seen++;
      assert.ok(seen >= previous, `${palette.id}: гашение немонотонно на edgeDist = ${edgeDist} св.г.`);
      previous = seen;
    }
    field.dispose();
  }
});

/**
 * Гашение по тому же `smoothstep`, что считает поле (`t² · (3 − 2t)` от
 * клампнутого `t`), но пороги берутся из экспортированных констант поля —
 * числа `1`/`4` в формуле не хардкодятся. Вход — св.г., как у поля и сцены.
 */
function localFadeFor(edgeDistLy) {
  const t = Math.max(
    0,
    Math.min(1, (edgeDistLy - LOCAL_FADE_FROM) / (LOCAL_FADE_TO - LOCAL_FADE_FROM)),
  );
  return t * t * (3 - 2 * t);
}

test('контракт единиц гашения: пороги 1 и 4 св.г., как у сцены', () => {
  assert.equal(LOCAL_FADE_FROM, 1);
  assert.equal(LOCAL_FADE_TO, 4);

  const expected = [
    [1, 0],
    [1.25, 0.020],
    [2.5, 0.5],
    [3, 0.741],
    [4, 1],
    [5.3191, 1],
  ];
  for (const [edgeLy, fade] of expected) {
    const actual = localFadeFor(edgeLy);
    assert.ok(
      Math.abs(actual - fade) <= 1e-3,
      `fade(${edgeLy} св.г.) = ${actual}, ожидалось ${fade} ± 1e-3`,
    );
  }
});

test('реальные edgeDist из сцены: справочная дистанция напрямую управляет fade поля', () => {
  // Сцена отдаёт edgeDist в св.г. (`cameraEdgeDistance` → `edgeDistance`
  // лестницы, §17.23), и поле принимает св.г.: значение идёт в поле как
  // есть, без конверсии — прямое `edgeDist: scene.edgeDist` при будущей
  // проводке обязано быть безопасным. Если константы поля снова окажутся
  // в других единицах, этот тест упадёт.
  const viewports = [
    { w: 1920, h: 1080, expectedMaxScale: 500, expectedEdge: 1.08, expectedFade: 0.0020954074074074113, expectedFitScale: 0.10152 },
    { w: 390, h: 844, expectedMaxScale: 500, expectedEdge: 0.39, expectedFade: 0, expectedFitScale: 0.03666 },
  ];
  for (const spec of viewports) {
    const viewport = { w: spec.w, h: spec.h };
    const label = `${spec.w}×${spec.h}`;

    const maxScale = maxScaleForTargetWidth(viewport, MAP_SIZE, CONFIG.view.fitInset);
    assert.ok(
      Math.abs(maxScale - spec.expectedMaxScale) <= 1e-9,
      `${label}: maxScaleForTargetWidth = ${maxScale} px/ед, ожидалось ${spec.expectedMaxScale} px/ед`,
    );
    const edgeAtMaxLy = edgeDistance(viewport, maxScale);
    assert.ok(
      Math.abs(edgeAtMaxLy - spec.expectedEdge) <= 1e-9,
      `${label}: edgeDistance на упоре = ${edgeAtMaxLy} св.г., ожидалось ${spec.expectedEdge} св.г.`,
    );
    assert.ok(
      Math.abs(localFadeFor(edgeAtMaxLy) - spec.expectedFade) <= 1e-12,
      `${label}: fade ${localFadeFor(edgeAtMaxLy)} не совпал с геометрическим edgeDistance ${spec.expectedEdge}`,
    );

    const fitScale = fitScaleFor(viewport, MAP_SIZE, CONFIG.view.fitInset);
    assert.ok(
      Math.abs(fitScale - spec.expectedFitScale) <= 1e-9,
      `${label}: fitScaleFor = ${fitScale} px/ед, ожидалось ${spec.expectedFitScale} px/ед`,
    );
    const edgeAtFitLy = edgeDistance(viewport, fitScale);
    assert.ok(
      Math.abs(edgeAtFitLy - 5319.148936170213) <= 1e-9,
      `${label}: edgeDistance на «вся карта» = ${edgeAtFitLy} св.г., ожидалось 5 319,15 св.г.`,
    );
    assert.equal(
      localFadeFor(edgeAtFitLy),
      1,
      `${label}: fade на «вся карта» не 1 — обычное поле там приглушено`,
    );
  }
});

test('одни единицы на стыке: sector-field не зависит от sector-units', () => {
  // Контракт «одно имя — одни единицы»: поле принимает edgeDist в св.г.,
  // как отдаёт сцена, поэтому переводчик единиц в модуле поля не нужен.
  // Фиксируем grep-контролем, а не комментарием: возврат скрытого перевода
  // на стыке сцена → поле уронит этот тест.
  const source = readFileSync(new URL('../src/atlas/sector-field.ts', import.meta.url), 'utf8');
  assert.ok(
    !source.includes('sector-units'),
    "в src/atlas/sector-field.ts есть подстрока 'sector-units' — модуль поля не должен зависеть от sector-units",
  );
  assert.ok(
    !source.includes('lyToUnits'),
    "в src/atlas/sector-field.ts есть подстрока 'lyToUnits' — edgeDist поля уже в св.г., перевод на стыке запрещён",
  );
});

/* ----------------------------------------------------- §17.12: критерии V-2…V-4 */

/** Метрики кадра по определениям §17.12: `meanL`, `edge / meanL`, `uniq`. */
function frameMetrics(image) {
  const { width, height, data } = image;
  const luminance = new Float64Array(width * height);
  const colors = new Set();
  let sum = 0;
  for (let index = 0; index < luminance.length; index++) {
    const r = data[index * 4];
    const g = data[index * 4 + 1];
    const b = data[index * 4 + 2];
    const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[index] = value;
    sum += value;
    colors.add((r << 16) | (g << 8) | b);
  }
  const meanL = sum / luminance.length;
  let edge = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      edge += Math.abs(
        luminance[index - 1] + luminance[index + 1] + luminance[index - width] + luminance[index + width]
          - 4 * luminance[index],
      );
      count++;
    }
  }
  return { meanL, ratio: edge / count / meanL, uniq: colors.size };
}

test('обзорный кадр сохраняет цветовое разнообразие и диапазон яркости', () => {
  // Прежние V-2…V-4 требовали менять шум и нормировать каждый кадр при зуме.
  // Это противоречит новому требованию неизменного мирового рисунка.
  for (const palette of FIELD_PALETTES) {
    const field = createSectorField(null, { style: palette.id });
    const level = frameMetrics(field.renderToImageData(stateForWidth(10000, 512)));
    assert.ok(level.meanL >= 12 && level.meanL <= 40, `${palette.id}: meanL ${level.meanL}`);
    assert.ok(level.uniq >= (palette.id === 'nebula' ? 3000 : 1800), `${palette.id}: цветов ${level.uniq}`);
    field.dispose();
  }
});

test('плотность туманности в мировой точке не зависит от камеры, зума и разрешения', () => {
  const states = [
    stateForWidth(10000, 512),
    stateForWidth(625, 256),
    { ...centredFrame(3000, 9000, 128, 500), dpr: 2 },
    { ...centredFrame(8500, 1200, 64, 0.08), viewport: { w: 300, h: 800 }, dpr: 3 },
  ];
  for (const style of ['nebula', 'tactical']) {
    for (const [x, y] of [[203, 3858], [3364, 9868], [5000, 5000], [7200, 3000]]) {
      const expected = sampleNebulaDensity(states[0], x, y, style);
      for (const state of states.slice(1)) assert.equal(sampleNebulaDensity(state, x, y, style), expected, `${style}: ${x}, ${y}`);
    }
  }
});

test('панорамирование не перенормирует яркость одного и того же участка CPU-кадра', () => {
  const field = createSectorField(null, { style: 'tactical' });
  const base = centredFrame(4000, 7000, 80, 1);
  const shifted = { ...base, view: { ...base.view, tx: base.view.tx + 13, ty: base.view.ty + 7 } };
  const a = field.renderToImageData(base).data;
  const b = field.renderToImageData(shifted).data;
  let max = 0;
  for (let y = 0; y < 73; y++) for (let x = 0; x < 67; x++) for (let channel = 0; channel < 3; channel++) {
    max = Math.max(max, Math.abs(a[(y * 80 + x) * 4 + channel] - b[((y + 7) * 80 + x + 13) * 4 + channel]));
  }
  assert.ok(max <= 1, `разница ${max}: допускается только дизеринг`);
});

/* ------------------------------------------------- кэш экранного пути и глубина */

/** Холст-заглушка: запоминает последний кадр, который в него положили. */
function stubCanvas() {
  const painted = { image: null, count: 0 };
  const context = {
    drawImage: () => {},
    clearRect: () => {},
    putImageData: (image) => {
      painted.image = image;
      painted.count += 1;
    },
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind) => (kind === '2d' ? context : null),
  };
  return { canvas, painted };
}

test('кэш renderField учитывает edgeDist: смена глубины при той же камере даёт новый кадр', () => {
  const { canvas, painted } = stubCanvas();
  const field = createSectorField(canvas);
  const base = { ...stateForWidth(20, 96) };

  field.renderField({ ...base, edgeDist: 1 });
  const deep = painted.image;
  assert.ok(deep !== null, 'кадр не попал на холст');

  // Та же камера, другая глубина: из кэша вернулся бы предыдущий кадр.
  field.renderField({ ...base, edgeDist: 10 });
  const far = painted.image;
  assert.notEqual(far, deep, 'кадр не пересчитан при смене edgeDist');

  let differing = 0;
  for (let index = 0; index < deep.data.length; index++) if (deep.data[index] !== far.data[index]) differing++;
  assert.ok(differing > 0, 'кадры глубокого и обычного пресета совпали побайтово');

  // Повтор с тем же состоянием — из кэша, новый кадр не считается.
  const before = painted.count;
  field.renderField({ ...base, edgeDist: 10 });
  assert.equal(painted.count, before + 1, 'повторный кадр должен браться из кэша без пересчёта');
  assert.equal(painted.image, far, 'из кэша вернулся другой кадр');
  field.renderField({ ...base, edgeDist: 1 });
  assert.equal(painted.image, deep, 'фон должен сохраняться в кэше вместе с полным полем');
  field.renderField({ ...base, edgeDist: 10 });
  assert.equal(painted.image, far, 'полное поле должно сохраняться при чередовании проходов');
  field.dispose();
});

test('GLSL uint-конструктор использует unsigned-литерал для каждого канала', () => {
  for (const style of ['nebula', 'tactical']) {
    const sources = [];
    const gl = {
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
      createShader: () => ({}), shaderSource: (_shader, source) => sources.push(source),
      compileShader: () => {}, getShaderParameter: () => true, deleteShader: () => {},
      createProgram: () => ({}), attachShader: () => {}, linkProgram: () => {},
      getProgramParameter: () => true, getUniformLocation: () => null, deleteProgram: () => {},
      getExtension: () => null,
    };
    const canvas = { getContext: (kind) => kind === 'webgl2' ? gl : null, addEventListener: () => {}, removeEventListener: () => {} };
    const field = createSectorField(canvas, { style });
    assert.equal(field.backend, 'webgl2');
    const match = sources[1].match(/RIDGE_FINE_CHANNELS\[3\]\s*=\s*uint\[3\]\(([^)]+)\)/);
    assert.ok(match, 'конструктор каналов отсутствует');
    assert.deepEqual(match[1].split(',').map((s) => s.trim()), ['18u', '24u', '25u']);
    field.dispose();
  }
});

test('яркость облака управляется отдельно и учитывается CPU-кэшем', () => {
  const { canvas, painted } = stubCanvas();
  const field = createSectorField(canvas, { style: 'tactical' });
  const base = stateForWidth(625, 96);
  field.renderField({ ...base, cloudBrightness: 0 });
  const dim = painted.image;
  field.renderField({ ...base, cloudBrightness: 1 });
  const bright = painted.image;
  assert.notEqual(digest(dim.data), digest(bright.data));
  field.renderField({ ...base, cloudBrightness: 0 });
  assert.equal(painted.image, dim);
  const sample = sampleNebulaDensity(base, 4000, 7000, 'tactical');
  assert.equal(sampleNebulaDensity({ ...base, cloudBrightness: 0 }, 4000, 7000, 'tactical'), 0);
  assert.equal(sampleNebulaDensity({ ...base, cloudBrightness: 1 }, 4000, 7000, 'tactical'), sample);
  field.dispose();
});

test('WebGL получает постоянные параметры облака и независимый множитель мигания', () => {
  const draws = [];
  let uniforms = {};
  const gl = new Proxy({
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, NO_ERROR: 0,
    createShader: () => ({}), createProgram: () => ({}),
    getShaderParameter: () => true, getProgramParameter: () => true,
    getUniformLocation: (_program, name) => ({ name }), getError: () => 0,
    uniform1f: (location, value) => { if (location) uniforms[location.name] = value; },
    uniform1i: (location, value) => { if (location) uniforms[location.name] = value; },
    uniform1ui: (location, value) => { if (location) uniforms[location.name] = value; },
    uniform2i: (location, x, y) => { if (location) uniforms[location.name] = [x, y]; },
    uniform2f: (location, x, y) => { if (location) uniforms[location.name] = [x, y]; },
    uniform1fv: (location, value) => { if (location) uniforms[location.name] = [...value]; },
    drawArrays: () => { draws.push(uniforms); uniforms = {}; },
    getExtension: () => null,
  }, { get: (target, property) => property in target ? target[property] : () => {} });
  const canvas = { width: 0, height: 0, getContext: (kind) => kind === 'webgl2' ? gl : null, addEventListener() {}, removeEventListener() {} };
  const field = createSectorField(canvas, { style: 'tactical' });
  field.renderField(stateForWidth(10000, 128));
  field.renderField({ ...centredFrame(3300, 9000, 256, 500), dpr: 2 });
  field.renderField({ ...stateForWidth(625, 128), cloudBrightness: 3 });
  assert.equal(draws.length, 3);
  for (const key of ['u_warpAmp', 'u_octaveWeight[0]', 'u_octaveNormalizer', 'u_cloudPeak', 'u_threadGain', 'u_ridgeMidCells', 'u_ridgeFineCells', 'u_dustCells', 'u_dustFade', 'u_detailWarpCells', 'u_detailWarpAmp']) {
    assert.deepEqual(draws[0][key], draws[1][key], key);
    assert.deepEqual(draws[0][key], draws[2][key], key);
  }
  assert.equal(draws[0].u_densityGain, draws[1].u_densityGain);
  assert.ok(Math.abs(draws[2].u_densityGain - draws[0].u_densityGain * 3) < 1e-12);
  field.dispose();
});

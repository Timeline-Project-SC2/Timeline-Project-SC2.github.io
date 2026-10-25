import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const fieldModule = require('../src/atlas/sector-field.ts');
const { FIELD_SEED_TEXT, FIELD_PALETTES, createSectorField, hashSeed } = fieldModule;

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
 * Один и тот же кадр (видимая ширина `20` св.г.), в котором меняется только
 * `edgeDist`. Так гашение проверяется на одной сцене: разница кадров — это
 * ровно гашение, а не другой зум.
 */
function deepFrame(edgeDist, size = PROXY_SIZE) {
  return { ...stateForWidth(20, size), edgeDist };
}

test('глубокий пресет: при edgeDist = 1 облака нет, при edgeDist = 10 — есть', () => {
  for (const palette of FIELD_PALETTES) {
    const field = createSectorField(null, { style: palette.id });
    const deep = cloudWithoutStars(field, deepFrame(1), palette);
    let above = 0;
    let peak = 0;
    for (const value of deep) {
      if (value > 0.02) above++;
      if (value > peak) peak = value;
    }
    assert.equal(above, 0, `${palette.id}: при edgeDist = 1 плотность выше 0,02 у ${above} пикселей (пик ${peak.toFixed(3)})`);

    const far = cloudWithoutStars(field, deepFrame(10), palette);
    let clouded = 0;
    for (const value of far) if (value > 0.02) clouded++;
    const share = clouded / far.length;
    assert.ok(share > 0.3, `${palette.id}: при edgeDist = 10 облако занимает лишь ${(share * 100).toFixed(1)} % кадра`);

    // Гашение монотонное: доля облака не убывает с ростом edgeDist, ступеньки нет.
    let previous = -1;
    for (const edgeDist of [1, 1.5, 2, 3, 4, 10]) {
      const density = cloudWithoutStars(field, deepFrame(edgeDist), palette);
      let seen = 0;
      for (const value of density) if (value > 0.02) seen++;
      assert.ok(seen >= previous, `${palette.id}: гашение немонотонно на edgeDist = ${edgeDist}`);
      previous = seen;
    }
    field.dispose();
  }
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

test('критерии V-2…V-4: деталь не гаснет с зумом, яркость в полосе, цветов достаточно', () => {
  const size = 512;
  for (const palette of FIELD_PALETTES) {
    const field = createSectorField(null, { style: palette.id });
    const levels = [10000, 10000 / 16, 10000 / 512].map((width) => frameMetrics(
      field.renderToImageData(stateForWidth(width, size)),
    ));
    const [shallow, middle, deep] = levels;
    const uniqGate = palette.id === 'nebula' ? 3000 : 1800;
    for (const [index, level] of levels.entries()) {
      assert.ok(level.meanL >= 12 && level.meanL <= 40, `${palette.id} L${index}: meanL ${level.meanL.toFixed(1)} вне полосы 12…40`);
      assert.ok(level.uniq >= uniqGate, `${palette.id} L${index}: уникальных цветов ${level.uniq} < ${uniqGate}`);
    }
    assert.ok(deep.meanL / shallow.meanL <= 1.25, `${palette.id}: рост яркости L9/L0 = ${(deep.meanL / shallow.meanL).toFixed(2)}`);
    assert.ok(middle.ratio >= 0.9 * shallow.ratio, `${palette.id}: деталь L4/L0 = ${(middle.ratio / shallow.ratio).toFixed(2)} < 0,90`);
    assert.ok(deep.ratio >= 0.9 * shallow.ratio, `${palette.id}: деталь L9/L0 = ${(deep.ratio / shallow.ratio).toFixed(2)} < 0,90`);
    field.dispose();
  }
});

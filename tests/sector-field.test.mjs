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

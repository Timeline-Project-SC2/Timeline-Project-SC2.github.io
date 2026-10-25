import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const layout = require('../src/atlas/label-layout.ts');

const { LABEL_BUDGET, LABEL_OFFSETS, boxesOverlap, estimateLabelSize, layoutLabels } = layout;

/** Детерминированный генератор: тесты не должны зависеть от `Math.random`. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeItems(count, viewport, seed = 7) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => ({
    id: `s${String(index).padStart(3, '0')}`,
    text: `Система ${index}`,
    x: 8 + random() * (viewport.w - 16),
    y: 8 + random() * (viewport.h - 16),
    priority: Math.floor(random() * 4) * 25,
  }));
}

const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 1920, h: 1080 },
];

test('пустой вход не падает и не выдумывает подписи', () => {
  for (const viewport of VIEWPORTS) {
    const result = layoutLabels([], viewport);
    assert.deepEqual(result.placed, []);
    assert.deepEqual(result.dropped, []);
    assert.equal(result.skipped, 0);
    assert.equal(result.overflow, 0);
    assert.equal(result.invalid, 0);
    assert.equal(result.budget, LABEL_BUDGET);
    assert.equal(result.budget, 120);

    // Пустые опции и пустые препятствия — тот же результат.
    const withOptions = layoutLabels([], viewport, { obstacles: [], budget: 0 });
    assert.deepEqual(withOptions.placed, []);
    assert.equal(withOptions.budget, 0);
  }
});

test('раскладка детерминирована: один вход — один выход, порядок входа не важен', () => {
  const viewport = { w: 1920, h: 1080 };
  const items = makeItems(40, viewport);

  const first = layoutLabels(items, viewport);
  const second = layoutLabels(items, viewport);
  assert.deepEqual(second, first);
  assert.ok(first.placed.length > 0, 'ни одна подпись не поставлена');

  const shuffled = items.slice().reverse();
  const third = layoutLabels(shuffled, viewport);
  assert.deepEqual(third.placed, first.placed);
  assert.deepEqual(third.dropped, first.dropped);
});

test('на 390×844 и на 1920×1080 поставленные подписи не пересекаются', () => {
  for (const viewport of VIEWPORTS) {
    const items = makeItems(60, viewport, viewport.w);
    const result = layoutLabels(items, viewport);
    assert.ok(result.placed.length > 5, `${viewport.w}×${viewport.h}: поставлено ${result.placed.length}`);

    for (const [index, box] of result.placed.entries()) {
      // Внутри кадра с учётом поля.
      assert.ok(box.x >= 0 && box.y >= 0, `подпись ${box.id} вылезла за левый/верхний край`);
      assert.ok(box.x + box.width <= viewport.w, `подпись ${box.id} вылезла за правый край`);
      assert.ok(box.y + box.height <= viewport.h, `подпись ${box.id} вылезла за нижний край`);
      // Никаких касаний с уже поставленными.
      for (const other of result.placed.slice(index + 1)) {
        assert.ok(!boxesOverlap(box, other), `подписи ${box.id} и ${other.id} пересекаются`);
      }
    }
  }
});

test('бюджет 120 соблюдается, лишние заявки уходят в overflow', () => {
  const viewport = { w: 1920, h: 1080 };
  const items = makeItems(200, viewport, 11);
  const result = layoutLabels(items, viewport);
  assert.ok(result.placed.length <= LABEL_BUDGET, `поставлено ${result.placed.length} из ${LABEL_BUDGET}`);
  assert.ok(result.overflow > 0, 'overflow не посчитан');
  assert.equal(result.placed.length + result.skipped + result.overflow, items.length);

  // Малый бюджет режет ровно по числу.
  const tight = layoutLabels(items, viewport, { budget: 5 });
  assert.ok(tight.placed.length <= 5);
  assert.equal(tight.budget, 5);
});

test('приоритет решает, чья подпись останется при конфликте', () => {
  const viewport = { w: 400, h: 300 };
  const capital = { id: 'a-capital', text: 'Корхал', x: 200, y: 150, priority: 100 };
  const minor = { id: 'b-minor', text: 'Мелкая', x: 200, y: 150, priority: 10 };

  const capitalFirst = layoutLabels([capital, minor], viewport);
  assert.equal(capitalFirst.placed[0]?.id, 'a-capital');
  assert.equal(capitalFirst.placed[0]?.priority, 100);
  assert.ok(
    capitalFirst.placed.some((box) => box.id === 'b-minor') || capitalFirst.dropped.includes('b-minor'),
    'вторая подпись должна быть либо сдвинута, либо отброшена — но не потеряна молча',
  );

  const reversed = layoutLabels([minor, capital], viewport);
  assert.deepEqual(reversed.placed.map((box) => box.id), capitalFirst.placed.map((box) => box.id));
});

test('препятствия не перекрываются подписями', () => {
  const viewport = { w: 800, h: 600 };
  const obstacles = [
    { x: 100, y: 100, width: 60, height: 60 },
    { x: 400, y: 300, width: 120, height: 80 },
    { x: 650, y: 500, width: 90, height: 90 },
  ];
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: `p${index}`,
    text: `Точка ${index}`,
    x: 120 + index * 22,
    y: 130 + index * 15,
    priority: 0,
  }));

  const result = layoutLabels(items, viewport, { obstacles });
  assert.ok(result.placed.length > 0);
  for (const box of result.placed) {
    for (const obstacle of obstacles) {
      assert.ok(!boxesOverlap(box, obstacle, 2), `подпись ${box.id} наехала на препятствие`);
    }
  }
});

test('радиус якоря отодвигает подпись от собственного маркера', () => {
  const viewport = { w: 600, h: 400 };
  const diameter = 40;
  const marker = { x: 300, y: 200, width: diameter, height: diameter };
  const items = [{ id: 'm1', text: 'Корхал', x: 300, y: 200, radius: diameter / 2 }];

  const result = layoutLabels(items, viewport, { obstacles: [marker] });
  assert.equal(result.placed.length, 1);
  const box = result.placed[0];
  assert.ok(!boxesOverlap(box, marker, 2), 'подпись легла на маркер');
  assert.ok(box.x >= 300 + diameter / 2, 'подпись не отодвинута на радиус маркера');

  // Без радиуса и без препятствия подпись садится ближе — радиус действительно работает.
  const plain = layoutLabels([{ id: 'm1', text: 'Корхал', x: 300, y: 200 }], viewport);
  assert.ok(plain.placed[0].x < box.x);
});

test('негодные заявки считаются, а не роняют кадр', () => {
  const viewport = { w: 400, h: 300 };
  const items = [
    { id: 'ok', text: 'Норм', x: 100, y: 100 },
    { id: '', text: 'Без id', x: 120, y: 120 },
    { id: 'empty', text: '', x: 140, y: 140 },
    { id: 'nan', text: 'Нет координаты', x: Number.NaN, y: 160 },
    { id: 'inf', text: 'Бесконечность', x: 180, y: Number.POSITIVE_INFINITY },
  ];

  const result = layoutLabels(items, viewport);
  assert.equal(result.invalid, 4);
  assert.deepEqual(result.placed.map((box) => box.id), ['ok']);
  assert.equal(result.placed.length + result.invalid, items.length);
});

test('рамка подписи и пересечение считаются по метрикам', () => {
  const size = estimateLabelSize('KP·REQHC');
  assert.equal(size.width, 8 * 6.2 + 6);
  assert.equal(size.height, 13 + 4);

  const metrics = { fontSize: 14, charWidth: 8, lineHeight: 18, paddingX: 1, paddingY: 1 };
  const custom = estimateLabelSize('AB', metrics);
  assert.equal(custom.width, 16 + 2);
  assert.equal(custom.height, 18 + 2);

  const a = { x: 0, y: 0, width: 10, height: 10 };
  assert.ok(boxesOverlap(a, { x: 5, y: 5, width: 10, height: 10 }));
  assert.ok(!boxesOverlap(a, { x: 10, y: 0, width: 10, height: 10 }));
  assert.ok(boxesOverlap(a, { x: 11, y: 0, width: 10, height: 10 }, 2));
  assert.ok(!boxesOverlap(a, { x: 13, y: 0, width: 10, height: 10 }, 2));

  assert.equal(LABEL_OFFSETS.length, 8);
  assert.deepEqual(LABEL_OFFSETS[0], { dx: 1, dy: 0 });
});

test('нечисловые и нулевые входы дают RangeError с русским текстом', () => {
  for (const viewport of [{ w: 0, h: 100 }, { w: 100, h: 0 }, { w: Number.NaN, h: 100 }, { w: -5, h: 100 }]) {
    assert.throws(() => layoutLabels([], viewport), RangeError, JSON.stringify(viewport));
  }
  assert.throws(() => layoutLabels([], null), RangeError);
  assert.throws(() => layoutLabels([], undefined), RangeError);

  const viewport = { w: 400, h: 300 };
  assert.throws(() => layoutLabels([], viewport, { budget: -1 }), RangeError);
  assert.throws(() => layoutLabels([], viewport, { budget: 1.5 }), RangeError);
  assert.throws(() => layoutLabels([], viewport, { gap: -1 }), RangeError);
  assert.throws(() => layoutLabels([], viewport, { inset: -1 }), RangeError);
  assert.throws(() => layoutLabels([], viewport, { metrics: { fontSize: 0 } }), RangeError);
  assert.throws(() => layoutLabels([], viewport, { metrics: { charWidth: Number.NaN } }), RangeError);
  assert.throws(() => layoutLabels([], viewport, { offsets: [] }), RangeError);

  // Русский текст ошибки, а не английский.
  try {
    layoutLabels([], { w: 0, h: 100 });
    assert.fail('ожидалась ошибка');
  } catch (error) {
    assert.match(error.message, /[А-Яа-я]/);
  }
});

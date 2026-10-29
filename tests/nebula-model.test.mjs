import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseBounds } from '../src/atlas/sector-bounds.ts';
import { createNebula, setNebulaOutline, moveNebulaVertex, insertNebulaVertex, removeNebulaVertex, deformNebula, setNebulaColor, setNebulaPattern, addNebulaStroke, setNebulaBlink, nebulaColorAt, nebulaPatternPoint, nebulaBlinkIntensity } from '../src/atlas/nebula-model.ts';

const bounds = parseBounds(await readFile(new URL('../data/sector-bounds.json', import.meta.url), 'utf8'));

test('новая туманность начинается с границы сектора или произвольной области за её пределами', () => {
  const sector = bounds.bounds.find((x) => x.id === 'sector.outline');
  const a = createNebula('one', bounds);
  assert.deepEqual(a.points, sector.points);
  assert.notEqual(a.points, sector.points);
  const b = createNebula('two', bounds, [[-200, 0], [11000, 0], [0, 10000]]);
  assert.deepEqual(b.points.at(-1), b.points[0]);
  assert.equal(b.points[0][0], -200);
  assert.throws(() => setNebulaOutline(b, [[0, 0], [0, 0], [1, 1]]), RangeError);
});

test('управляющие вершины и кисть меняют форму без изменения исходного документа', () => {
  const a = createNebula('a', bounds, [[0, 0], [100, 0], [100, 100], [0, 100]]);
  const b = moveNebulaVertex(a, 0, [-10, 0]);
  assert.deepEqual(a.points[0], [0, 0]);
  assert.deepEqual(b.points.at(-1), [-10, 0]);
  const c = insertNebulaVertex(b, 0, [50, -20]);
  assert.deepEqual(c.points[1], [50, -20]);
  assert.deepEqual(removeNebulaVertex(c, 1).points, b.points);
  const d = deformNebula(a, [50, 0], 15, [0, -10]);
  assert.deepEqual(d.points[1], [50, -10]);
  assert.deepEqual(d.points.at(-1), d.points[0]);
  assert.throws(() => removeNebulaVertex(createNebula('x', bounds, [[0, 0], [1, 0], [0, 1]]), 1), RangeError);
});

test('цвет кисти интерполируется вдоль мазка и не влияет на другие области', () => {
  let a = setNebulaColor(createNebula('a', bounds), '#000000');
  a = addNebulaStroke(a, { points: [[0, 0], [100, 0]], radius: 20, hardness: 0, opacity: 1, color: '#FF0000' });
  assert.deepEqual(nebulaColorAt(a, [50, 0]), [255, 0, 0]);
  assert.deepEqual(nebulaColorAt(a, [50, 10]), [128, 0, 0]);
  assert.deepEqual(nebulaColorAt(a, [50, 30]), [0, 0, 0]);
  a = addNebulaStroke(a, { points: [[50, 0]], radius: 20, hardness: 1, opacity: 0.5, color: '#0000ff' });
  assert.deepEqual(nebulaColorAt(a, [50, 0]), [128, 0, 128]);
  assert.throws(() => addNebulaStroke(a, { points: [], radius: 1, hardness: 0, opacity: 1, color: '#ffffff' }), RangeError);
});

test('паттерн определяется мировыми координатами и параметрами, а мигание периодично', () => {
  let a = createNebula('a', bounds);
  a = setNebulaPattern(a, { seed: 'other', scale: 2, rotation: Math.PI / 2, offset: [10, 20] });
  const p = nebulaPatternPoint(a.pattern, [10, 22]);
  assert.ok(Math.abs(p[0] - 1) < 1e-12 && Math.abs(p[1]) < 1e-12);
  a = setNebulaBlink(a, { enabled: true, intervalMs: 2000, min: 0.2, max: 0.8, phase: 0 });
  assert.ok(Math.abs(nebulaBlinkIntensity(a.blink, 0) - 0.2) < 1e-12);
  assert.ok(Math.abs(nebulaBlinkIntensity(a.blink, 1000) - 0.8) < 1e-12);
  assert.ok(Math.abs(nebulaBlinkIntensity(a.blink, 2000) - 0.2) < 1e-12);
  assert.equal(nebulaBlinkIntensity({ ...a.blink, enabled: false }, 1000), 1);
  assert.equal(nebulaBlinkIntensity({ ...a.blink, min: 1, max: 3 }, 1000), 3);
  assert.throws(() => setNebulaBlink(a, { ...a.blink, max: 5 }), RangeError);
  assert.throws(() => setNebulaBlink(a, { ...a.blink, intervalMs: 0 }), RangeError);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test('мигание туманности загружается из данных и проверяется', () => {
  const json = JSON.parse(JSON.stringify(bounds));
  const nebula = json.bounds.find((x) => x.kind === 'nebula');
  nebula.blink = { enabled: true, intervalMs: 4000, min: 0.2, max: 1, phase: 0 };
  assert.deepEqual(parseBounds(json).bounds.find((x) => x.id === nebula.id).blink, nebula.blink);
  nebula.blink.intervalMs = 0;
  assert.throws(() => parseBounds(json), RangeError);
});

test('образец паттерна использует seed, положение, масштаб и не зависит от камеры', async () => {
  const { sampleNebulaPattern } = await import('../src/atlas/nebula-sampler.ts');
  const model = createNebula('test', bounds);
  const state = { view: { scale: 1, tx: 0, ty: 0 }, viewport: { w: 800, h: 600 }, dpr: 1, mapSize: 10000 };
  const changedView = { ...state, view: { scale: 100, tx: -5000, ty: 700 }, viewport: { w: 200, h: 300 }, dpr: 2 };
  const original = sampleNebulaPattern(model.pattern, state, [3200, 4800]);
  assert.equal(sampleNebulaPattern(model.pattern, changedView, [3200, 4800]), original);
  assert.notEqual(sampleNebulaPattern({ ...model.pattern, seed: 'another' }, state, [3200, 4800]), original);
  assert.notEqual(sampleNebulaPattern({ ...model.pattern, scale: 2 }, state, [3200, 4800]), original);
});

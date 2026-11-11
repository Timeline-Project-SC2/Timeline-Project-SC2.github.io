/* Аудит геометрии правки линий границ сектора (карточка SEC-VISUAL-EDIT, B1/S1–S4).
 *
 * Прогоняет **все рёбра всех контуров** `data/sector-bounds.json` через модель
 * правки и печатает измерения, на которые опираются тесты и документация:
 *
 * - доля участка от нарисованной линии между структурными вершинами, ширина
 *   окна влияния и мёртвая зона выбора (S3/S4);
 * - отклонение записи от предпросмотра, самопересечения (складки), выход
 *   координат за поле и валидность выгрузки при реалистичных и предельных
 *   тягах (B1/S1/S2);
 * - поведение защиты от излома: тяга в долях окна влияния (S2).
 *
 * Код завершения 1, если хоть одна запись вышла за поле, дала невалидную
 * выгрузку или складку: скрипт годится как проверка, а не только как отчёт.
 */
import { readFile } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
// `BOUNDS_AUDIT_MODEL` — путь к копии модели с другим срезом краёв: так меряется
// компромисс среза (S3/S4) без правки боевого файла.
const model = await import(process.env.BOUNDS_AUDIT_MODEL ?? new URL('src/atlas/sector-bounds-edit.ts', ROOT));
const { parseBounds, smoothPolyline } = await import(new URL('src/atlas/sector-bounds.ts', ROOT));

const bounds = parseBounds(await readFile(new URL('data/sector-bounds.json', ROOT), 'utf8'));

/* --------------------------------------------------------------- метрики */

function distToPolyline(point, line) {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dy * t));
  }
  return best;
}

/** Нарисованная линия контура — тот же `smoothPolyline`, что у карты. */
function rendered(contour, steps = 16) {
  const closed = contour.kind !== 'halo';
  const path = smoothPolyline(contour.points, closed);
  const points = [];
  let from = path.start;
  const push = (a, control, b) => {
    for (let i = points.length === 0 ? 0 : 1; i <= steps; i += 1) {
      const u = i / steps;
      if (control === null) points.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
      else {
        const v = 1 - u;
        points.push([
          v * v * a[0] + 2 * v * u * control[0] + u * u * b[0],
          v * v * a[1] + 2 * v * u * control[1] + u * u * b[1],
        ]);
      }
    }
  };
  for (const curve of path.curves) {
    push(from, curve.control, curve.end);
    from = curve.end;
  }
  if (path.tail !== null) push(from, null, path.tail);
  return points;
}

/** Складки: число строгих самопересечений нарисованной линии. */
function selfIntersections(points) {
  const crosses = (p1, p2, p3, p4) => {
    const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (Math.abs(d) < 1e-12) return false;
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
    const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
  };
  let count = 0;
  for (let i = 1; i < points.length; i += 1) {
    for (let j = i + 2; j < points.length; j += 1) {
      if (i === 1 && j === points.length - 1) continue;
      if (crosses(points[i - 1], points[i], points[j - 1], points[j])) count += 1;
    }
  }
  return count;
}

/** Максимальный поворот между соседними сегментами ломаной, градусы. */
function maxTurn(points) {
  let worst = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const v1 = [b[0] - a[0], b[1] - a[1]];
    const v2 = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(v1[0], v1[1]);
    const l2 = Math.hypot(v2[0], v2[1]);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const cos = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)));
    worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
  }
  return worst;
}

const insideMap = (p) => p[0] >= 0 && p[0] <= 10000 && p[1] >= 0 && p[1] <= 10000;
const finite = (p) => Number.isFinite(p[0]) && Number.isFinite(p[1]);

function stat(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return { min: NaN, p50: NaN, p95: NaN, max: NaN };
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
  };
}
const fmt = (value) => (Number.isFinite(value) ? value.toFixed(2) : '—');

/* -------------------------------------------------------------- прогон */

/** Точка пика и нормаль к линии в ней — направление «реалистичной» тяги. */
function peakFrame(active) {
  const count = active.base.length;
  const index = Math.min(count - 2, Math.max(0, Math.round(active.coreFraction * (count - 1))));
  const a = active.base[index];
  const b = active.base[index + 1];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy) || 1;
  return { peak: active.core, normal: [-dy / length, dx / length] };
}

const spanRows = [];
const dragRows = [];
const problems = [];

for (const contour of bounds.bounds) {
  for (let edgeIndex = 0; edgeIndex < contour.points.length - 1; edgeIndex += 1) {
    const edge = model.edgePoints(contour, edgeIndex);
    if (!edge) continue;
    const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
    const edited = model.beginBoundsEdit(model.createBoundsEditSession(bounds), contour.id, edgeIndex, click);
    if (edited.active === null) {
      problems.push(`${contour.id} #${edgeIndex}: участок не открылся`);
      continue;
    }
    const active = edited.active;
    const spanRendered = model.denseCurve(contour, active.spanStart, active.spanEnd).length;
    const structural = contour.points.slice(active.spanStart, active.spanEnd + 1);
    let structuralLength = 0;
    for (let i = 1; i < structural.length; i += 1) {
      structuralLength += Math.hypot(structural[i][0] - structural[i - 1][0], structural[i][1] - structural[i - 1][1]);
    }
    spanRows.push({
      contour: contour.id,
      edgeIndex,
      spanShare: spanRendered / (structuralLength || 1),
      windowArc: (active.window[1] - active.window[0]) * spanRendered,
      dead: structuralLength > 0 ? Math.max(0, 1 - spanRendered / structuralLength) : 0,
    });

    const { peak, normal } = peakFrame(active);
    const targets = [
      ['перп. +25', [peak[0] + normal[0] * 25, peak[1] + normal[1] * 25]],
      ['перп. −25', [peak[0] - normal[0] * 25, peak[1] - normal[1] * 25]],
      ['перп. +60', [peak[0] + normal[0] * 60, peak[1] + normal[1] * 60]],
      ['угол 10000', [10000, 10000]],
      ['угол 0', [0, 0]],
      ['за край +', [20000, 20000]],
      ['за край −', [-20000, -20000]],
    ];
    for (const [label, target] of targets) {
      const dragged = model.moveBoundsEditCore(edited, target);
      const preview = dragged.active.curve;
      const committed = model.commitBoundsEdit(dragged);
      const next = model.contourOf(committed.doc, contour.id);
      let deviation = 0;
      let folds = 0;
      let outside = 0;
      if (next !== null) {
        const line = rendered(next);
        deviation = Math.max(0, ...preview.map((point) => distToPolyline(point, line)));
        folds = selfIntersections(line);
        outside = next.points.filter((point) => !insideMap(point) || !finite(point)).length;
      }
      let exportOk = true;
      let exportError = '';
      try {
        model.parseBoundsEdit(model.serializeBoundsEdit(committed.doc));
      } catch (error) {
        exportOk = false;
        exportError = error instanceof Error ? error.message : String(error);
      }
      const row = {
        contour: contour.id,
        edgeIndex,
        drag: label,
        deviation,
        folds,
        outside,
        previewOutside: preview.filter((point) => !insideMap(point)).length,
        exportOk,
        exportError,
        recorded: committed.past.length > 0,
        rejected: committed.rejected ?? null,
        limited: dragged.active.limited,
      };
      dragRows.push(row);
      if (!exportOk || outside > 0 || folds > 0) problems.push(`${contour.id} #${edgeIndex} «${label}»: ${JSON.stringify(row)}`);
    }
  }
}

/* ------------------------------------------------------- предел тяги (S2) */

const pullRows = [];
for (const contour of bounds.bounds) {
  for (let edgeIndex = 0; edgeIndex < contour.points.length - 1; edgeIndex += 1) {
    const edge = model.edgePoints(contour, edgeIndex);
    if (!edge) continue;
    const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
    const edited = model.beginBoundsEdit(model.createBoundsEditSession(bounds), contour.id, edgeIndex, click);
    if (edited.active === null) continue;
    const { peak, normal } = peakFrame(edited.active);
    const arc = (edited.active.window[1] - edited.active.window[0]) * edited.active.base.length;
    for (const factor of [0.25, 0.5, 1, 2, 4]) {
      for (const sign of [1, -1]) {
        const target = [peak[0] + normal[0] * sign * factor * arc, peak[1] + normal[1] * sign * factor * arc];
        const dragged = model.moveBoundsEditCore(edited, target);
        const committed = model.commitBoundsEdit(dragged);
        const next = model.contourOf(committed.doc, contour.id);
        pullRows.push({
          factor,
          previewTurn: maxTurn(dragged.active.curve),
          commitTurn: next === null || committed.past.length === 0 ? NaN : maxTurn(rendered(next)),
          folds: next === null ? 0 : selfIntersections(rendered(next)),
          rejected: committed.rejected ?? null,
        });
      }
    }
  }
}

/* ------------------------------------------------------------- сводка */

console.log(`контуров: ${bounds.bounds.length}, рёбер ${spanRows.length}, участков открыто ${spanRows.length}`);
console.log(`доля участка от линии между вершинами: ${JSON.stringify(stat(spanRows.map((r) => r.spanShare)))}`);
console.log(`окно влияния, ед.: ${JSON.stringify(stat(spanRows.map((r) => r.windowArc)))}`);
console.log(`мёртвая зона: ${JSON.stringify(stat(spanRows.map((r) => r.dead)))}`);

for (const drag of [...new Set(dragRows.map((row) => row.drag))]) {
  const list = dragRows.filter((row) => row.drag === drag);
  const dev = stat(list.map((row) => row.deviation));
  console.log(
    `тяга «${drag}»: отклонение записи min ${fmt(dev.min)} / p50 ${fmt(dev.p50)} / p95 ${fmt(dev.p95)} / max ${fmt(dev.max)}`
    + ` | > ${model.BOUNDS_EDIT_COMMIT_TOLERANCE} ед.: ${list.filter((row) => row.deviation > model.BOUNDS_EDIT_COMMIT_TOLERANCE).length}`
    + ` | записано ${list.filter((row) => row.recorded).length}/${list.length}`
    + ` | отказов ${list.filter((row) => row.rejected !== null).length}`
    + ` | ограничено ${list.filter((row) => row.limited).length}`
    + ` | складок ${list.filter((row) => row.folds > 0).length}`
    + ` | вне поля ${list.filter((row) => row.outside > 0).length}`
    + ` | предпросмотр вне поля ${list.filter((row) => row.previewOutside > 0).length}`
    + ` | выгрузка невалидна ${list.filter((row) => !row.exportOk).length}`,
  );
}

console.log('\nпредел тяги (в долях окна влияния):');
for (const factor of [0.25, 0.5, 1, 2, 4]) {
  const list = pullRows.filter((row) => row.factor === factor);
  const commitTurns = list.map((row) => row.commitTurn);
  console.log(
    `  ${factor}·окна: поворот предпросмотра max ${fmt(Math.max(...list.map((r) => r.previewTurn)))}°,`
    + ` записи max ${fmt(Math.max(...commitTurns.filter(Number.isFinite)))}°,`
    + ` складок ${list.filter((row) => row.folds > 0).length},`
    + ` отказов ${list.filter((row) => row.rejected !== null).length}`,
  );
}

if (problems.length > 0) {
  console.error(`\nПРОБЛЕМЫ (${problems.length}):`);
  for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\nПРОБЛЕМ НЕТ: выгрузка валидна, контуры внутри поля, складок нет.');
}

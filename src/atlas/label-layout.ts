/* Раскладка подписей сектора: приоритеты, отталкивание, антиколлизия.
 *
 * Модуль чистый: без DOM, без canvas, без состояния между вызовами. Вход — точки
 * якорей в пикселях кадра и приоритеты, выход — прямоугольники подписей, которые
 * не пересекаются между собой и с препятствиями (маркеры, апертура) и не выходят
 * за кадр. Один и тот же вход даёт один и тот же выход: сортировка детерминирована
 * (приоритет → идентификатор → порядок во входе), никаких случайностей и времени.
 *
 * Числа бюджета и метрик:
 *   — `LABEL_BUDGET = 120` — бюджет подписей из `CONFIG.layers.labelBudget`
 *     (план §6, §8.1: «подписи с приоритетом … антиколлизия, бюджет 120»);
 *   — метрики шрифта (`LABEL_METRICS`) — значения по умолчанию модуля и
 *     переопределяются опциями: план не задаёт px для подписи, а рендерер
 *     (слот 3) обязан передать фактические замеры `measureText`, чтобы рамки
 *     совпали с нарисованным текстом;
 *   — зазор и поле кадра — минимальные технические отступы, не «числа плана».
 */

/** Кадр, в который раскладываются подписи. */
export interface LabelViewport {
  readonly w: number;
  readonly h: number;
}

/** Прямоугольник в пикселях кадра: левый верхний угол и размеры. */
export interface LabelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Заявка на подпись: якорь — точка объекта в пикселях кадра. */
export interface LabelItem {
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  /** Больше — важнее. По умолчанию `0`. */
  readonly priority?: number;
  /**
   * Радиус занятой области вокруг якоря, px: подпись отодвигается от якоря на
   * `gap + radius`, поэтому не садится на собственный маркер. По умолчанию `0`.
   */
  readonly radius?: number;
}

/** Метрики шрифта подписи; передаются рендерером из фактического замера. */
export interface LabelMetrics {
  readonly fontSize: number;
  readonly charWidth: number;
  readonly lineHeight: number;
  readonly paddingX: number;
  readonly paddingY: number;
}

/** Кандидат смещения подписи относительно якоря: знак по оси, `0` — по центру. */
export interface LabelOffset {
  readonly dx: -1 | 0 | 1;
  readonly dy: -1 | 0 | 1;
}

/** Поставленная подпись: рамка плюс то, что нужно для отрисовки. */
export interface LabelBox extends LabelRect {
  readonly id: string;
  readonly text: string;
  readonly priority: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly fontSize: number;
}

export interface LabelLayoutOptions {
  /** Предел числа поставленных подписей; по умолчанию `LABEL_BUDGET`. */
  readonly budget?: number;
  readonly metrics?: Partial<LabelMetrics>;
  /** Зазор между рамками подписей и до препятствий, px. */
  readonly gap?: number;
  /** Поле от края кадра, px. */
  readonly inset?: number;
  /** Занятые прямоугольники: маркеры, апертура, HUD. */
  readonly obstacles?: readonly LabelRect[];
  /** Порядок кандидатов смещения; по умолчанию `LABEL_OFFSETS`. */
  readonly offsets?: readonly LabelOffset[];
}

export interface LabelLayoutResult {
  readonly placed: readonly LabelBox[];
  readonly dropped: readonly string[];
  /** Сколько подписей отброшено из-за коллизий. */
  readonly skipped: number;
  /** Сколько подписей отброшено из-за бюджета. */
  readonly overflow: number;
  /** Сколько заявок негодны (пустой текст, нечисловые координаты). */
  readonly invalid: number;
  readonly budget: number;
}

/** Бюджет подписей плана (`CONFIG.layers.labelBudget`, §8.1). */
export const LABEL_BUDGET = 120;

/** Метрики по умолчанию: моноширинный шрифт 11 px, рендерер их переопределяет. */
export const LABEL_METRICS: LabelMetrics = Object.freeze({
  fontSize: 11,
  charWidth: 6.2,
  lineHeight: 13,
  paddingX: 3,
  paddingY: 2,
});

export const LABEL_GAP = 2;
export const LABEL_INSET = 4;

/**
 * Порядок «отталкивания»: подпись сначала пробует встать справа от якоря, затем
 * по диагоналям и сторонам света. Смещения не случайные и не зависят от данных —
 * поэтому раскладка воспроизводима.
 */
export const LABEL_OFFSETS: readonly LabelOffset[] = Object.freeze([
  Object.freeze({ dx: 1, dy: 0 }),
  Object.freeze({ dx: 1, dy: -1 }),
  Object.freeze({ dx: 0, dy: -1 }),
  Object.freeze({ dx: -1, dy: -1 }),
  Object.freeze({ dx: -1, dy: 0 }),
  Object.freeze({ dx: -1, dy: 1 }),
  Object.freeze({ dx: 0, dy: 1 }),
  Object.freeze({ dx: 1, dy: 1 }),
]);

function requirePositive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${what} должно быть положительным числом: ${String(value)}`);
  }

  return value;
}

function requireNonNegative(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${what} должно быть неотрицательным числом: ${String(value)}`);
  }

  return value;
}

/** Оценка рамки подписи по метрикам: ширина текста плюс внутренние отступы. */
export function estimateLabelSize(text: string, metrics: LabelMetrics = LABEL_METRICS): LabelRect {
  const width = Math.max(1, text.length) * metrics.charWidth + metrics.paddingX * 2;
  const height = metrics.lineHeight + metrics.paddingY * 2;

  return { x: 0, y: 0, width, height };
}

/** Пересекаются ли прямоугольники с зазором `gap` по обеим осям. */
export function boxesOverlap(a: LabelRect, b: LabelRect, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap
    && b.x < a.x + a.width + gap
    && a.y < b.y + b.height + gap
    && b.y < a.y + a.height + gap
  );
}

function resolveMetrics(overrides: Partial<LabelMetrics> | undefined): LabelMetrics {
  const metrics: LabelMetrics = { ...LABEL_METRICS, ...overrides };
  requirePositive(metrics.fontSize, 'Размер шрифта подписи (fontSize)');
  requirePositive(metrics.charWidth, 'Ширина символа подписи (charWidth)');
  requirePositive(metrics.lineHeight, 'Высота строки подписи (lineHeight)');
  requireNonNegative(metrics.paddingX, 'Горизонтальный отступ подписи (paddingX)');
  requireNonNegative(metrics.paddingY, 'Вертикальный отступ подписи (paddingY)');

  return metrics;
}

/**
 * Рамка подписи, прижатой к якорю с заданной стороны. `spacing` — зазор плюс
 * радиус занятой области якоря (маркера), поэтому подпись не наезжает на него.
 */
function boxAt(
  anchorX: number,
  anchorY: number,
  size: LabelRect,
  offset: LabelOffset,
  spacing: number,
): LabelRect {
  const x = offset.dx === 0
    ? anchorX - size.width / 2
    : (offset.dx > 0 ? anchorX + spacing : anchorX - spacing - size.width);
  const y = offset.dy === 0
    ? anchorY - size.height / 2
    : (offset.dy > 0 ? anchorY + spacing : anchorY - spacing - size.height);

  return { x, y, width: size.width, height: size.height };
}

/**
 * Раскладывает подписи по кадру без пересечений.
 *
 * Порядок обработки: приоритет по убыванию, затем `id` по возрастанию кодовых
 * единиц, затем исходный порядок. Поэтому результат не зависит от порядка входа
 * и не меняется от вызова к вызову. Негодные заявки не бросают исключение —
 * они считаются в `invalid`, потому что подпись не тот объект, ради которого
 * стоит ронять кадр.
 */
export function layoutLabels(
  items: readonly LabelItem[],
  viewport: LabelViewport,
  options: LabelLayoutOptions = {},
): LabelLayoutResult {
  const frame: LabelViewport | null | undefined = viewport;
  if (frame === null || frame === undefined) {
    throw new RangeError('Кадр для подписей должен быть объектом { w, h }');
  }
  const width = requirePositive(frame.w, 'Ширина кадра подписей (viewport.w)');
  const height = requirePositive(frame.h, 'Высота кадра подписей (viewport.h)');

  const metrics = resolveMetrics(options.metrics);
  const budget = options.budget ?? LABEL_BUDGET;
  if (!Number.isInteger(budget) || budget < 0) {
    throw new RangeError(`Бюджет подписей должен быть целым неотрицательным числом: ${String(budget)}`);
  }
  const gap = requireNonNegative(options.gap ?? LABEL_GAP, 'Зазор подписей (gap)');
  const inset = requireNonNegative(options.inset ?? LABEL_INSET, 'Поле кадра подписей (inset)');
  const obstacles = options.obstacles ?? [];
  const offsets = options.offsets ?? LABEL_OFFSETS;
  if (offsets.length === 0) {
    throw new RangeError('Нужен хотя бы один кандидат смещения подписи (offsets)');
  }

  const valid: Array<{
    readonly item: LabelItem;
    readonly priority: number;
    readonly radius: number;
    readonly index: number;
  }> = [];
  let invalid = 0;
  for (const [index, item] of items.entries()) {
    const priority = item.priority ?? 0;
    const usable = typeof item.id === 'string' && item.id.length > 0
      && typeof item.text === 'string' && item.text.length > 0
      && Number.isFinite(item.x) && Number.isFinite(item.y)
      && Number.isFinite(priority);
    if (usable) {
      const radius = Number.isFinite(item.radius) && (item.radius ?? 0) > 0 ? item.radius! : 0;
      valid.push({ item, priority, radius, index });
    } else {
      invalid += 1;
    }
  }

  valid.sort((a, b) => (
    b.priority - a.priority
    || (a.item.id < b.item.id ? -1 : (a.item.id > b.item.id ? 1 : 0))
    || a.index - b.index
  ));

  const placed: LabelBox[] = [];
  const dropped: string[] = [];
  let skipped = 0;
  let overflow = 0;

  for (const [position, entry] of valid.entries()) {
    if (placed.length >= budget) {
      overflow = valid.length - position;
      break;
    }

    const size = estimateLabelSize(entry.item.text, metrics);
    const spacing = gap + entry.radius;
    let accepted: LabelRect | null = null;
    for (const offset of offsets) {
      const box = boxAt(entry.item.x, entry.item.y, size, offset, spacing);
      const inside = box.x >= inset
        && box.y >= inset
        && box.x + box.width <= width - inset
        && box.y + box.height <= height - inset;
      if (!inside) continue;
      if (obstacles.some((obstacle) => boxesOverlap(box, obstacle, gap))) continue;
      if (placed.some((other) => boxesOverlap(box, other, gap))) continue;
      accepted = box;
      break;
    }

    if (accepted === null) {
      skipped += 1;
      dropped.push(entry.item.id);
      continue;
    }

    placed.push({
      ...accepted,
      id: entry.item.id,
      text: entry.item.text,
      priority: entry.priority,
      anchorX: entry.item.x,
      anchorY: entry.item.y,
      fontSize: metrics.fontSize,
    });
  }

  return { placed, dropped, skipped, overflow, invalid, budget };
}

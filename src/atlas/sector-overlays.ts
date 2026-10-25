/* Map Atlas — без-DOM-модель информационно-интерактивных блоков сектора.
 *
 * Карточка `Z-3.2` (§17.22.1 матрицы оркестрации): на эталонной карте сектора
 * есть восемь информационно-интерактивных блоков — легенда, статистика,
 * врезка-мини-карта, водяной знак, метки опасных зон и выноски туманностей.
 * Здесь они описаны как ПЛЕЙСХОЛДЕРЫ: у блока есть якорь, размер, набор слотов и
 * состояние, а содержимое слотов остаётся заготовкой (`value: null`) до наполнения
 * вложениями (медиа, ссылки, списки, счётчики, эффекты).
 *
 * Модуль чистый: без DOM, без canvas, без `Math.random`, `Date.now` и
 * `performance.now`. Один и тот же вход даёт один и тот же выход, поэтому раскладку
 * можно проверять тестами без браузера, а рисовать — отдельной волной (`Z-3.4`).
 *
 * Единицы и «никаких магических литералов»: угловые блоки задают размер долями
 * кадра (`unit: 'frame'`), мировые и экранные — в px (`unit: 'px'`). Отступ от
 * края кадра, зазор в стопке одного угла и высота свёрнутой шапки — экспортированные
 * константы `OVERLAY_*`, а не числа в коде отрисовки.
 *
 * Правило сворачивания на телефоне (§ требование карточки): при ширине кадра
 * `<= OVERLAY_PHONE_MAX_WIDTH` (тот же брейкпоинт `599 px`, что и
 * `(max-width: 599px)` в `app.ts`) блоки `legend` и `statistics` принудительно
 * показываются свёрнутыми — независимо от состояния в данных. Исходные объекты
 * блоков при этом не мутируются: `blocksAt`/`layoutOverlays` возвращают копии.
 */

/** Виды слотов: текст, число, медиа, список, ссылка, счётчик. */
export type OverlaySlotKind = 'text' | 'number' | 'media' | 'list' | 'link' | 'counter';

/** Состояния блока. `collapsed` меняет только высоту шапки, см. раскладку. */
export type OverlayState = 'collapsed' | 'expanded' | 'hover' | 'focus';

/** Угол кадра для углового якоря. */
export type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Вид якоря: угол кадра, координата карты, координата кадра в px. */
export type OverlayAnchorKind = 'corner' | 'world' | 'screen';

/** Единица размера блока: px кадра или доля кадра (0…1). */
export type OverlaySizeUnit = 'px' | 'frame';

/** Действие блока. `focusSystem` — перевести кадр на объект блока. */
export type OverlayActionKind = 'link' | 'toggle' | 'focusSystem';

export interface OverlayAnchor {
  readonly kind: OverlayAnchorKind;
  /** Координата карты (`world`) или кадра в px (`screen`). */
  readonly x?: number;
  readonly y?: number;
  /** Обязателен для `kind: 'corner'`. */
  readonly corner?: OverlayCorner;
}

export interface OverlaySize {
  readonly w: number;
  readonly h: number;
  readonly unit: OverlaySizeUnit;
}

export interface OverlaySlot {
  readonly id: string;
  readonly kind: OverlaySlotKind;
  /** Содержимое вложения; `null` — слот пуст и ждёт данных. */
  readonly value: string | number | null;
  /** Русская подсказка, что сюда войдёт; это не текст интерфейса. */
  readonly placeholder: string;
}

export interface OverlayAction {
  readonly kind: OverlayActionKind;
  /** Цель действия; для плейсхолдеров — условный id объекта данных. */
  readonly target?: string;
}

export interface OverlayBlock {
  readonly id: string;
  readonly title: string;
  readonly anchor: OverlayAnchor;
  readonly size: OverlaySize;
  /** Размер на телефоне: если задан, заменяет `size` при узком кадре. */
  readonly phoneSize?: OverlaySize;
  readonly slots: readonly OverlaySlot[];
  readonly state: OverlayState;
  readonly interactive: boolean;
  /** У неинтерактивного блока действия нет даже если оно было в JSON. */
  readonly action?: OverlayAction;
  /** `true` — блок волны `Z-3.2` остаётся заготовкой до наполнения. */
  readonly placeholder: boolean;
}

/** Кадр, в который раскладываются блоки. */
export interface OverlayViewport {
  readonly w: number;
  readonly h: number;
  /** px кадра на единицу карты — как `state.view.scale` рендерера. */
  readonly scale?: number;
  /** Координата карты в центре кадра. */
  readonly centerX?: number;
  readonly centerY?: number;
}

/** Прямоугольник блока в px кадра. */
export interface OverlayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OverlayPlacement {
  readonly block: OverlayBlock;
  readonly rect: OverlayRect;
}

export interface OverlayA11y {
  readonly role: string;
  readonly label: string;
  readonly hint: string;
}

/** Тот же брейкпоинт, что `(max-width: 599px)` в `src/atlas/app.ts`. */
export const OVERLAY_PHONE_MAX_WIDTH = 599;

/** Отступ угловых блоков от края кадра, px. */
export const OVERLAY_EDGE_INSET_PX = 12;

/** Зазор между блоками в стопке одного угла, px. */
export const OVERLAY_STACK_GAP_PX = 8;

/** Высота свёрнутой шапки блока, px (заменяет `size.h` в состоянии `collapsed`). */
export const OVERLAY_COLLAPSED_HEIGHT_PX = 34;

/** Блоки, которые на телефоне показываются свёрнутыми принудительно. */
export const OVERLAY_PHONE_COLLAPSED_IDS: readonly string[] = Object.freeze(['legend', 'statistics']);

/** Допустимые id блоков: фиксированные панели и нумерованные метки эталона. */
export const OVERLAY_ID_PATTERN = /^(?:legend|statistics|inset|watermark|zone\.\d+|callout\.\d+)$/;

export const OVERLAY_SLOT_KINDS: readonly OverlaySlotKind[] = Object.freeze([
  'text',
  'number',
  'media',
  'list',
  'link',
  'counter',
]);

export const OVERLAY_STATES: readonly OverlayState[] = Object.freeze([
  'collapsed',
  'expanded',
  'hover',
  'focus',
]);

export const OVERLAY_CORNERS: readonly OverlayCorner[] = Object.freeze([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
]);

const OVERLAY_ANCHOR_KINDS: readonly OverlayAnchorKind[] = Object.freeze(['corner', 'world', 'screen']);
const OVERLAY_ACTION_KINDS: readonly OverlayActionKind[] = Object.freeze(['link', 'toggle', 'focusSystem']);

function fail(message: string): never {
  throw new RangeError(message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what}: ожидается объект`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${what}: ожидается непустая строка`);
  }
  return value.trim();
}

function requireFinite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${what}: ожидается конечное число`);
  }
  return value;
}

function requirePositive(value: unknown, what: string): number {
  const number = requireFinite(value, what);
  if (number <= 0) fail(`${what}: ожидается положительное число`);
  return number;
}

function isSlotKind(value: string): value is OverlaySlotKind {
  return OVERLAY_SLOT_KINDS.some((kind) => kind === value);
}

function isState(value: string): value is OverlayState {
  return OVERLAY_STATES.some((state) => state === value);
}

function isCorner(value: string): value is OverlayCorner {
  return OVERLAY_CORNERS.some((corner) => corner === value);
}

function isAnchorKind(value: string): value is OverlayAnchorKind {
  return OVERLAY_ANCHOR_KINDS.some((kind) => kind === value);
}

function isActionKind(value: string): value is OverlayActionKind {
  return OVERLAY_ACTION_KINDS.some((kind) => kind === value);
}

/** Блоки на телефоне сворачиваются по id, а не по своему состоянию в данных. */
export function collapsesOnPhone(id: string): boolean {
  return OVERLAY_PHONE_COLLAPSED_IDS.some((collapsedId) => collapsedId === id);
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Битый JSON блоков наложений: ${detail}`);
  }
}

function parseSize(raw: unknown, what: string): OverlaySize {
  const record = asRecord(raw, what);
  const w = requirePositive(record['w'], `${what}.w`);
  const h = requirePositive(record['h'], `${what}.h`);
  const unit = requireText(record['unit'], `${what}.unit`);
  if (unit !== 'px' && unit !== 'frame') {
    fail(`${what}.unit: ожидается «px» или «frame», получено «${unit}»`);
  }
  return Object.freeze({ w, h, unit });
}

function parseAnchor(raw: unknown, blockId: string): OverlayAnchor {
  const what = `anchor блока ${blockId}`;
  const record = asRecord(raw, what);
  const kind = requireText(record['kind'], `${what}.kind`);
  if (!isAnchorKind(kind)) {
    fail(`${what}: неизвестный вид якоря «${kind}», допустимы ${OVERLAY_ANCHOR_KINDS.join(', ')}`);
  }
  if (kind === 'corner') {
    const corner = requireText(record['corner'], `${what}.corner`);
    if (!isCorner(corner)) {
      fail(`${what}: неизвестный угол «${corner}», допустимы ${OVERLAY_CORNERS.join(', ')}`);
    }
    return Object.freeze({ kind, corner });
  }
  return Object.freeze({
    kind,
    x: requireFinite(record['x'], `${what}.x`),
    y: requireFinite(record['y'], `${what}.y`),
  });
}

function parseAction(raw: unknown, blockId: string): OverlayAction {
  const what = `action блока ${blockId}`;
  const record = asRecord(raw, what);
  const kind = requireText(record['kind'], `${what}.kind`);
  if (!isActionKind(kind)) {
    fail(`${what}: неизвестное действие «${kind}», допустимы ${OVERLAY_ACTION_KINDS.join(', ')}`);
  }
  const targetRaw = record['target'];
  if (targetRaw === undefined || targetRaw === null) return Object.freeze({ kind });
  return Object.freeze({ kind, target: requireText(targetRaw, `${what}.target`) });
}

function parseSlotValue(raw: unknown, what: string): string | number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return fail(`${what}: value должно быть строкой, конечным числом или null`);
}

function parseSlot(raw: unknown, blockId: string, index: number): OverlaySlot {
  const what = `слот #${index} блока ${blockId}`;
  const record = asRecord(raw, what);
  const id = requireText(record['id'], `${what}.id`);
  const kindText = requireText(record['kind'], `${what}.kind`);
  if (!isSlotKind(kindText)) {
    fail(`Неизвестный kind слота «${kindText}» у блока ${blockId} (слот ${id}): допустимы ${OVERLAY_SLOT_KINDS.join(', ')}`);
  }
  return Object.freeze({
    id,
    kind: kindText,
    value: parseSlotValue(record['value'], `${what}.value`),
    placeholder: requireText(record['placeholder'], `${what}.placeholder`),
  });
}

function parseBlock(raw: unknown, index: number): OverlayBlock {
  const what = `блок наложений #${index}`;
  const record = asRecord(raw, what);
  const id = requireText(record['id'], `${what}.id`);
  if (!OVERLAY_ID_PATTERN.test(id)) {
    fail(`Неизвестный id блока наложений: «${id}» (допустимы legend, statistics, inset, watermark, zone.<n>, callout.<n>)`);
  }
  const title = requireText(record['title'], `title блока ${id}`);
  const anchor = parseAnchor(record['anchor'], id);
  const size = parseSize(record['size'], `size блока ${id}`);

  const phoneSizeRaw = record['phoneSize'];
  const phoneSize = phoneSizeRaw === undefined || phoneSizeRaw === null
    ? undefined
    : parseSize(phoneSizeRaw, `phoneSize блока ${id}`);

  const stateText = requireText(record['state'], `state блока ${id}`);
  if (!isState(stateText)) {
    fail(`Неизвестное состояние «${stateText}» у блока ${id}: допустимы ${OVERLAY_STATES.join(', ')}`);
  }

  const interactiveRaw = record['interactive'];
  if (typeof interactiveRaw !== 'boolean') {
    fail(`Блок ${id}: interactive должно быть true или false`);
  }

  const slotsRaw = record['slots'];
  if (!Array.isArray(slotsRaw)) fail(`Блок ${id}: slots должно быть массивом`);
  const slotIds = new Set<string>();
  const slots: OverlaySlot[] = [];
  const list = slotsRaw as unknown[];
  for (let slotIndex = 0; slotIndex < list.length; slotIndex += 1) {
    const slot = parseSlot(list[slotIndex], id, slotIndex);
    if (slotIds.has(slot.id)) fail(`Блок ${id}: повторяющийся id слота «${slot.id}»`);
    slotIds.add(slot.id);
    slots.push(slot);
  }

  // Требование карточки: неинтерактивный блок не отдаёт action, даже если он в данных.
  const actionRaw = record['action'];
  const action = interactiveRaw && actionRaw !== undefined && actionRaw !== null
    ? parseAction(actionRaw, id)
    : undefined;

  const placeholderRaw = record['placeholder'];
  const placeholder = placeholderRaw === undefined ? true : placeholderRaw === true;

  return Object.freeze({
    id,
    title,
    anchor,
    size,
    slots: Object.freeze(slots),
    state: stateText,
    interactive: interactiveRaw,
    placeholder,
    ...(phoneSize === undefined ? {} : { phoneSize }),
    ...(action === undefined ? {} : { action }),
  });
}

/**
 * Разбирает JSON блоков наложений (строку или уже разобранный объект) в модель.
 * Любое нарушение контракта — `RangeError` с русским текстом, а не тихий пропуск.
 */
export function parseOverlays(input: unknown): OverlayBlock[] {
  const payload = typeof input === 'string' ? parseJsonText(input) : input;
  const root = asRecord(payload, 'Документ блоков наложений');
  const rawBlocks = root['blocks'];
  if (!Array.isArray(rawBlocks)) fail('Документ блоков наложений должен содержать массив blocks');
  const list = rawBlocks as unknown[];
  const seen = new Set<string>();
  const blocks: OverlayBlock[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const block = parseBlock(list[index], index);
    if (seen.has(block.id)) fail(`Повторяющийся id блока наложений: ${block.id}`);
    seen.add(block.id);
    blocks.push(block);
  }
  Object.freeze(blocks);
  return blocks;
}

/**
 * Чистая смена состояния блока. Вход не мутируется: меняется только копия
 * целевого блока, остальные объекты переходят в новый массив по ссылке.
 * Повторный вызов с тем же состоянием даёт структурно равный результат.
 */
export function setState(
  blocks: readonly OverlayBlock[],
  id: string,
  state: OverlayState,
): OverlayBlock[] {
  if (!isState(state)) {
    fail(`Неизвестное состояние блока наложений: «${String(state)}», допустимы ${OVERLAY_STATES.join(', ')}`);
  }
  const index = blocks.findIndex((block) => block.id === id);
  const next = blocks.slice();
  if (index < 0) return next;
  const current = blocks[index];
  if (current === undefined || current.state === state) return next;
  next[index] = Object.freeze({ ...current, state }) as OverlayBlock;
  return next;
}

/** Прямоугольники пересекаются (касание сторон пересечением не считается). */
export function overlayRectsOverlap(a: OverlayRect, b: OverlayRect): boolean {
  return (
    a.x < b.x + b.width
    && b.x < a.x + a.width
    && a.y < b.y + b.height
    && b.y < a.y + a.height
  );
}

function requireViewport(viewport: OverlayViewport): void {
  const frame = viewport as unknown as Record<string, unknown>;
  requirePositive(frame['w'], 'Ширина кадра блоков наложений (viewport.w)');
  requirePositive(frame['h'], 'Высота кадра блоков наложений (viewport.h)');
  const scale = viewport.scale;
  if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) {
    fail(`Масштаб кадра блоков наложений (viewport.scale) должен быть положительным числом: ${String(scale)}`);
  }
}

function projectPoint(anchor: OverlayAnchor, viewport: OverlayViewport): { x: number; y: number } | null {
  if (anchor.kind === 'corner') return null;
  if (anchor.kind === 'screen') {
    return { x: anchor.x ?? 0, y: anchor.y ?? 0 };
  }
  // Мировой якорь проецируется как `toScreen` рендерера: без переворота оси Y.
  const scale = viewport.scale;
  const centerX = viewport.centerX;
  const centerY = viewport.centerY;
  if (scale === undefined || centerX === undefined || centerY === undefined) return null;
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return null;
  return {
    x: viewport.w / 2 + ((anchor.x ?? 0) - centerX) * scale,
    y: viewport.h / 2 + ((anchor.y ?? 0) - centerY) * scale,
  };
}

function effectiveSize(block: OverlayBlock, phone: boolean): OverlaySize {
  if (phone && block.phoneSize !== undefined) return block.phoneSize;
  return block.size;
}

function measureBlock(block: OverlayBlock, size: OverlaySize, viewport: OverlayViewport): { width: number; height: number } {
  const width = size.unit === 'frame' ? size.w * viewport.w : size.w;
  const height = block.state === 'collapsed'
    ? OVERLAY_COLLAPSED_HEIGHT_PX
    : size.unit === 'frame' ? size.h * viewport.h : size.h;
  return { width: Math.round(width), height: Math.round(height) };
}

function fitsInFrame(rect: OverlayRect, viewport: OverlayViewport): boolean {
  return (
    rect.x < viewport.w
    && rect.x + rect.width > 0
    && rect.y < viewport.h
    && rect.y + rect.height > 0
  );
}

/**
 * Раскладка видимых блоков в кадре: угловые блоки встают в стопку своего угла
 * (зазор `OVERLAY_STACK_GAP_PX`), мировые и экранные центрируются на якоре.
 * Блоки, чей прямоугольник не пересекает кадр, в результат не попадают.
 * На телефоне `legend` и `statistics` принудительно свёрнуты (см. шапку модуля).
 */
export function layoutOverlays(
  blocks: readonly OverlayBlock[],
  viewport: OverlayViewport,
): OverlayPlacement[] {
  requireViewport(viewport);
  const phone = viewport.w <= OVERLAY_PHONE_MAX_WIDTH;
  const inset = OVERLAY_EDGE_INSET_PX;
  const gap = OVERLAY_STACK_GAP_PX;
  const cursor: Record<OverlayCorner, number> = {
    'top-left': inset,
    'top-right': inset,
    'bottom-left': viewport.h - inset,
    'bottom-right': viewport.h - inset,
  };
  const placements: OverlayPlacement[] = [];

  for (const declared of blocks) {
    const block = phone && collapsesOnPhone(declared.id) && declared.state !== 'collapsed'
      ? Object.freeze({ ...declared, state: 'collapsed' as OverlayState })
      : declared;
    const measured = measureBlock(block, effectiveSize(block, phone), viewport);

    if (block.anchor.kind === 'corner') {
      const corner = block.anchor.corner ?? 'top-left';
      const top = corner === 'top-left' || corner === 'top-right';
      const left = corner === 'top-left' || corner === 'bottom-left';
      const width = Math.max(0, Math.min(measured.width, viewport.w - 2 * inset));
      const height = Math.max(0, Math.min(measured.height, viewport.h - 2 * inset));
      const x = left ? inset : viewport.w - inset - width;
      const y = top ? cursor[corner] : cursor[corner] - height;
      placements.push({ block, rect: Object.freeze({ x, y, width, height }) });
      cursor[corner] = top ? y + height + gap : y - gap;
      continue;
    }

    const point = projectPoint(block.anchor, viewport);
    if (point === null) continue;
    const rect: OverlayRect = Object.freeze({
      x: point.x - measured.width / 2,
      y: point.y - measured.height / 2,
      width: measured.width,
      height: measured.height,
    });
    if (!fitsInFrame(rect, viewport)) continue;
    placements.push({ block, rect });
  }

  return placements;
}

/**
 * Блоки, видимые в кадре, в порядке раскладки. Сюда же применяется правило
 * сворачивания на телефоне, поэтому возвращённые блоки — копии, а вход цел.
 */
export function blocksAt(blocks: readonly OverlayBlock[], viewport: OverlayViewport): OverlayBlock[] {
  return layoutOverlays(blocks, viewport).map((placement) => placement.block);
}

function roleFor(id: string): string {
  if (id === 'legend') return 'region';
  if (id === 'statistics') return 'status';
  if (id === 'inset') return 'figure';
  if (id === 'watermark') return 'img';
  if (id.startsWith('zone.')) return 'alert';
  if (id.startsWith('callout.')) return 'note';
  return 'group';
}

function labelFor(block: OverlayBlock): string {
  const parts: string[] = [];
  for (const slot of block.slots) {
    if (slot.value === null) continue;
    const text = typeof slot.value === 'number' ? String(slot.value) : slot.value.trim();
    if (text === '' || text === block.title || parts.includes(text)) continue;
    parts.push(text);
  }
  return parts.length === 0 ? block.title : `${block.title}: ${parts.join(' · ')}`;
}

function hintFor(block: OverlayBlock): string {
  const action = block.action;
  if (!block.interactive || action === undefined) {
    return block.state === 'collapsed' ? 'Статический блок, свёрнут.' : 'Статический блок: только чтение.';
  }
  if (action.kind === 'toggle') {
    return block.state === 'collapsed' ? 'Развернуть блок' : 'Свернуть блок';
  }
  const target = action.target === undefined ? '' : ` «${action.target}»`;
  if (action.kind === 'link') return `Открыть ссылку${target}`;
  return `Перевести кадр на объект${target}`;
}

/** Роль, `aria-label` и подсказка для блока: тексты готовы к `setAttribute`. */
export function describeForA11y(block: OverlayBlock): OverlayA11y {
  return Object.freeze({
    role: roleFor(block.id),
    label: labelFor(block),
    hint: hintFor(block),
  });
}

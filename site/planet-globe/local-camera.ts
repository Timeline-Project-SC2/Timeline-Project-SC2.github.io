/* Локальная камера 3D-конструктора участка — ЧИСТАЯ логика (UP-1 §3.3).
   --------------------------------------------------------------------------
   Вынесено из `site/planet-globe/planet-globe.ts` без изменения поведения:
   расстояния и наклон по селектору «Видимая ширина», каноническая точка
   прицела, ре-бейзинг при подмене гекса (Stage-8.7), глаз камеры, кривые
   анимации и решение о сглаживании остатка.

   Почему отдельный модуль: это единственная часть страницы, у которой есть
   числовой контракт, проверяемый без DOM/WebGL. Здесь нет ни обращений к
   `document`/`window`/`performance`, ни чтения состояния модуля страницы:
   всё, что зависит от вёрстки или участка (aspect канваса, радиус патча,
   высота центра), передаётся аргументами. Состояние камеры по-прежнему живёт
   в странице — модуль только считает переходы, поэтому второй реализации
   камеры нет.

   Соглашения (те же, что были в странице):
   - система координат касательная: `x = east`, `y = north`, `z` — вверх;
   - `yaw = -π/2` — азимут покоя: глаз на юге смотрит на север;
   - `pitch` — угол над горизонтом, `distance` — длина луча от `target`;
   - шаг между центрами соседних гексов `d_hex = 1.15 · R_patch`.

   Назад: [инструкции домена](../../site/AGENTS.md) · [план этапа 8](../../docs/stages/stage-08/plan.md).
*/

import { GLOBE_CELL_SCALE } from '../shared/planet-globe.ts';

/** Точка в касательной системе координат участка: `[east, north, up]`, метры. */
export type LocalVec3 = [number, number, number];

/** Состояние локальной камеры (снимок для ре-бейзинга и сглаживания остатка). */
export interface LocalCameraState {
  target: LocalVec3;
  yaw: number;
  pitch: number;
  distance: number;
}

/** Анимация локальной камеры: Dive-in, смена масштаба, сглаживание остатка. */
export interface LocalCameraAnim {
  startAt: number;
  durationMs: number;
  fromYaw: number;
  toYaw: number;
  fromPitch: number;
  toPitch: number;
  fromDist: number;
  toDist: number;
  fromTarget: LocalVec3;
  toTarget: LocalVec3;
  /** Stage-8.2: плавная кривая easeInOutCubic для двухфазного спуска
   *  (по умолчанию — easeOutCubic для перелётов внутри локальной карты). */
  easeInOut?: boolean;
}

/** Вертикальный угол обзора локальной камеры (50°). */
export const LOCAL_MAP_FOV = 50 * Math.PI / 180;
/** Рабочий панорамный наклон камеры локальной карты (Stage-8.3: ~17.8°). */
export const LOCAL_REST_PITCH = 0.31;
/**
 * Stage-8.6: азимут покоя локальной камеры строго на настоящий Север (+Y).
 * Вектор взгляда камеры равен `(-cos(yaw), -sin(yaw))` в координатах
 * `(east, north) = (+X, +Y)`, поэтому при `yaw = -π/2` взгляд направлен в `(0, +1)`:
 * глаз стоит на Юге и смотрит на Север.
 */
export const LOCAL_REST_YAW = -Math.PI / 2;
/**
 * Stage-8.7: шаг центров соседних гексов `d_hex = 1.15 · R_patch` — та же
 * величина, что у решётки Patch7/юбки (`SKIRT_HEX_SPACING_RATIO` воркера).
 * W24: отношение берётся из общей таблицы масштабов, чтобы шаг глобуса и шаг
 * локальной карты не разъезжались.
 */
export const LOCAL_HEX_STEP_RATIO = GLOBE_CELL_SCALE.strategicHexStepRatio;
/**
 * Stage-8.7: длительность сглаживания остаточного рассогласования камеры после
 * ре-бейзинга. Точный ре-бейзинг оставляет нулевой остаток, поэтому в штатном
 * переходе камера не двигается вовсе; ограничение в 220 мс гарантирует, что
 * любой ненулевой остаток гасится короткой кривой easeOutCubic.
 */
export const LOCAL_REBASE_SETTLE_MS = 220;
/** Stage-8.7: порог остатка (м), ниже которого сглаживание не запускается. */
export const LOCAL_REBASE_SETTLE_EPS_M = 0.25;
/** Нижняя граница дистанции зума по умолчанию: не ближе 2 м. */
export const LOCAL_MIN_CAMERA_DISTANCE_M = 2;

/** Внешние для камеры числа страницы: вёрстка и радиус участка. */
export interface LocalCameraContext {
  /** Соотношение сторон канваса (`width / height`), стягивается к 0.45…1. */
  aspect: number;
  /** Физический радиус активного участка, метры. */
  radiusM: number;
  /** Кадр камеры по текущей ширине, метры (см. `localPixelsToWorldM` в странице). */
  minCloseDistanceM: number;
}

/**
 * Соотношение сторон канваса участка с полом 0,1 (UP-1 §3.3).
 *
 * Перенесено из `localViewProjection` без изменения формулы: при скрытом
 * канвасе (высота 0 на первом кадре) отношение уходит в ноль, а проекционная
 * матрица обязана остаться конечной — отсюда нижняя граница 0,1.
 */
export function canvasAspectRatio(widthPx: number, heightPx: number): number {
  return Math.max(0.1, widthPx / Math.max(1, heightPx));
}

/**
 * Stage-8.5.2: равномерная логарифмическая шкала селектора «Видимая ширина»
 * по 11 ступеням (1.2 … 1250 км) — шаги 0.0 … 1.0 без мёртвых зон выше 70 км.
 */
export function scaleStep01(widthKm: number): number {
  const safeKm = Math.max(1.2, Number(widthKm) || 1.2);
  return clampLocal(Math.log2(safeKm / 1.2) / Math.log2(1250 / 1.2), 0, 1);
}

/**
 * Stage-8.5.2: дистанция камеры по выбранной видимой ширине `widthKm` без
 * мёртвого потолка на 55 км — каждая из 11 ступеней селектора ощутимо меняет
 * высоту камеры (≈×1.47 за шаг), а максимальная дистанция остаётся ниже
 * `localMaxCameraDistance()`.
 */
export function cameraDistanceForWidthKm(widthKm: number, context: LocalCameraContext): number {
  const aspect = context.aspect > 0 ? context.aspect : 1;
  const fit = Math.max(0.45, Math.min(1, aspect || 1));
  const u = scaleStep01(widthKm);
  const baseUnit = (context.radiusM * 0.44) / (Math.tan(LOCAL_MAP_FOV / 2) * fit);
  const minCloseDist = Math.max(context.minCloseDistanceM, baseUnit * 0.24);
  const maxOverviewDist = baseUnit * 11.2;
  return minCloseDist * Math.pow(maxOverviewDist / minCloseDist, u);
}

/**
 * Stage-8.5.2: целевой наклон камеры по видимой ширине без потолка на 39 км.
 * От `LOCAL_REST_PITCH` у долины (1.2 км) до 0.76 рада на обзоре 1250 км.
 */
export function cameraPitchForWidthKm(widthKm: number): number {
  const u = scaleStep01(widthKm);
  return LOCAL_REST_PITCH + (0.76 - LOCAL_REST_PITCH) * Math.pow(u, 0.85);
}

/**
 * Stage-8.5.2: каноническая точка прицела локальной камеры — чуть впереди по
 * текущему yaw от центра heightfield и чуть выше уровня долины. Смещение
 * вперёд сужается с ростом ширины, чтобы при удалении камеры прицеливать
 * центр кадра в саму долину, а не за её край.
 *
 * @param yaw текущий азимут камеры
 * @param widthKm выбранная видимая ширина
 * @param radiusM физический радиус участка
 * @param centerZ высота центра heightfield (м), конечное число
 */
export function defaultLocalCameraTarget(
  yaw: number,
  widthKm: number,
  radiusM: number,
  centerZ: number,
): LocalVec3 {
  const safeCenterZ = Number.isFinite(centerZ) ? centerZ : 0;
  const u = scaleStep01(widthKm);
  const forwardOffset = radiusM * 0.14 * (1 - 0.65 * u);
  return [
    -Math.cos(yaw) * forwardOffset,
    -Math.sin(yaw) * forwardOffset,
    safeCenterZ + Math.max(14, radiusM * 0.025),
  ];
}

/**
 * Stage-8.7: ре-бейзинг камеры при подмене патча.
 *
 * Локальная система координат каждого участка привязана к центру своего гекса,
 * поэтому при переходе на соседа меняется начало координат: центр нового гекса
 * лежит в старой системе на расстоянии `d_hex = 1.15 · R_patch` вдоль азимута
 * перехода `azimuth = atan2(east, north)`. Функция переносит состояние камеры в
 * новую систему так, чтобы МИРОВАЯ точка прицела и ракурс остались неизменными:
 * к `target` прибавляется вектор `-d_hex · (sin azimuth, cos azimuth)` (старый
 * центр в координатах нового гекса), а `yaw`/`pitch`/`distance` не меняются —
 * пользовательский ракурс сохраняется непрерывно.
 *
 * Функция чистая (без обращения к состоянию модуля), чтобы её можно было
 * проверить тестом и переиспользовать в обе стороны перехода. Радиус 0 или
 * отрицательный шага не даёт: переход без масштаба не сдвигает точку прицела.
 */
export function rebaseLocalCameraState(prev: LocalCameraState, azimuth: number, patchRadiusM: number): LocalCameraState {
  const stepM = LOCAL_HEX_STEP_RATIO * Math.max(0, patchRadiusM);
  return {
    target: [
      prev.target[0] - Math.sin(azimuth) * stepM,
      prev.target[1] - Math.cos(azimuth) * stepM,
      prev.target[2],
    ],
    yaw: prev.yaw,
    pitch: prev.pitch,
    distance: prev.distance,
  };
}

/** Снимок состояния: копия `target`, чтобы анимация не меняла исходный массив. */
export function cloneLocalCameraState(state: LocalCameraState): LocalCameraState {
  return {
    target: [state.target[0], state.target[1], state.target[2]],
    yaw: state.yaw,
    pitch: state.pitch,
    distance: state.distance,
  };
}

/** Глаз камеры в координатах участка: `target + direction · distance`. */
export function cameraEye(state: LocalCameraState): LocalVec3 {
  const cosPitch = Math.cos(state.pitch);
  const direction: LocalVec3 = [
    cosPitch * Math.cos(state.yaw),
    cosPitch * Math.sin(state.yaw),
    Math.sin(state.pitch),
  ];
  return [
    state.target[0] + direction[0] * state.distance,
    state.target[1] + direction[1] * state.distance,
    state.target[2] + direction[2] * state.distance,
  ];
}

/** Линейная интерполяция скаляра. */
export function lerpLocal(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Stage-8.2: плавная кривая перелёта внутри локальной карты. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Stage-8.2: симметричная плавная кривая спуска (мягкий вход и выход). */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Кадр анимации камеры на момент `now` (мс). Чистая замена тела
 * `applyLocalCameraAnim`: возвращает новое состояние и признак завершения,
 * ничего не записывая в модуль страницы.
 */
export function cameraAnimFrame(
  anim: LocalCameraAnim,
  now: number,
): { state: LocalCameraState; done: boolean } {
  const t = clampLocal((now - anim.startAt) / anim.durationMs, 0, 1);
  const e = anim.easeInOut ? easeInOutCubic(t) : easeOutCubic(t);
  return {
    state: {
      yaw: lerpLocal(anim.fromYaw, anim.toYaw, e),
      pitch: lerpLocal(anim.fromPitch, anim.toPitch, e),
      distance: lerpLocal(anim.fromDist, anim.toDist, e),
      target: [
        lerpLocal(anim.fromTarget[0], anim.toTarget[0], e),
        lerpLocal(anim.fromTarget[1], anim.toTarget[1], e),
        lerpLocal(anim.fromTarget[2], anim.toTarget[2], e),
      ],
    },
    done: t >= 1,
  };
}

/**
 * Stage-8.7: остаточное рассогласование после ре-бейзинга, метры.
 * Считается как разница высоты глаза камеры над рельефом нового участка и
 * той же величины до подмены: два участка аппроксимируют одну планету
 * независимо, поэтому остаток может быть ненулевым.
 */
export function rebaseResidualM(
  rebased: LocalCameraState,
  terrainZ: number,
  prevClearanceM: number,
): number {
  return (rebased.target[2] - terrainZ) - prevClearanceM;
}

/**
 * Stage-8.7: нужен ли короткий settle-переход между состояниями. Точный
 * ре-бейзинг даёт нулевую дельту по всем четырём каналам — тогда анимация не
 * запускается и мир не смещается ни на метр.
 */
export function needsRebaseSettle(from: LocalCameraState, to: LocalCameraState): boolean {
  const deltaTarget = Math.hypot(
    to.target[0] - from.target[0],
    to.target[1] - from.target[1],
    to.target[2] - from.target[2],
  );
  const deltaYaw = Math.abs(to.yaw - from.yaw);
  const deltaPitch = Math.abs(to.pitch - from.pitch);
  const deltaDist = Math.abs(to.distance - from.distance);
  return !(deltaTarget < LOCAL_REBASE_SETTLE_EPS_M && deltaYaw < 1e-4
    && deltaPitch < 1e-4 && deltaDist < 1e-3);
}

function clampLocal(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

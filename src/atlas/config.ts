/* Map Atlas — общая конфигурация, типы записей/состояния и малые утилиты.
 *
 * Этот модуль не знает о конкретных фабриках атласа. Он задаёт только
 * контракт kernel-объекта, через который модули вызывают друг друга во время
 * выполнения; поэтому циклических runtime-импортов между ними нет.
 */

import type { SiteLinks } from '../../site/shared/links.ts';
import type {
  TravelCalculation,
  TravelPlannerApi,
  TravelStop,
} from '../../site/shared/travel-planner.ts';
import type { SectorBounds } from './sector-bounds.ts';
import type { FieldStyle, SectorField } from './sector-field.ts';

export type { FieldStyle, SectorBounds, SectorField, SiteLinks, TravelCalculation, TravelPlannerApi, TravelStop };

export const CONFIG = {
  storage: {
    labels: 'map.atlas.labels.v1',
    travel: 'map.atlas.travel.v1',
  },
  data: {
    dir: '/data/',
    meta: 'meta.json',
    systems: 'systems.json',
    planets: 'planets.json',
    overrides: 'system-overrides.json',
    labels: 'map-labels.json',
    bounds: 'sector-bounds.json',
    // Снимок профилей планет (Этап 7): place_id -> пресет, радиус, статус и ключ PG1.
    generation: 'planet-generation.csv',
  },
  field: {
    style: 'nebula' as FieldStyle,
  },
  view: {
    fitInset: 0.94, // «вся карта» с небольшим запасом по краям
    minFactor: 0.62, // насколько можно отъехать от режима «вся карта»
    panMargin: 0.25, // карта может уйти внутрь экрана на эту долю размера экрана (как на галактике)
    wheelStep: 0.0016,
    animate: 340,
  },
  layers: {
    labelScale: 0.11, // подписи объектов карты (мировой масштаб, не подписи систем)
    noisyLabelScale: 0.5, // «шумные» подписи OCR — только крупно
    // Бюджет подписей кадра (§8.1) живёт в одном месте — `LABEL_BUDGET`
    // в `label-layout.ts`; в конфиге дубликата нет.
  },
  scene: {
    // Подписи сцены заданы в пикселях, а не в мировых единицах: при приближении
    // кегль не растёт, поэтому подпись не «раздувается» на глубоком зуме.
    labelFontPx: 11,
    labelPaddingX: 3,
    labelPaddingY: 2,
  },
  maxSuggestions: 22,
} as const;

// Администраторские типы совпадают с docs/ADMIN_GUIDE.md; для каждого типа есть
// метка, чтобы в каталоге не показывалось сырое значение из таблицы. Отдельно
// объявлен `unknown` — его нельзя ввести в таблицу руками: так нормализуется
// место, у которого тип не задан (пустая ячейка или легаси `none`).
export interface PlaceTypeInfo {
  readonly label: string;
  readonly plural: string;
  readonly glyph: string;
}

export const PLACE_TYPES: Readonly<Record<string, PlaceTypeInfo>> = {
  planet: { label: 'Планета', plural: 'планеты', glyph: 'П' },
  moon: { label: 'Луна', plural: 'луны', glyph: 'Л' },
  asteroid: { label: 'Астероид', plural: 'астероиды', glyph: 'А' },
  station: { label: 'Станция', plural: 'станции', glyph: 'С' },
  platform: { label: 'Платформа', plural: 'платформы', glyph: 'Ф' },
  other: { label: 'Иное место', plural: 'иные места', glyph: 'И' },
  // Место без типа в таблице (пустая ячейка или легаси `none`) — «полка ожидания»
  // по плану §9.2 п.5. Такому месту нельзя приписывать вид «планета».
  unknown: { label: 'Без типа', plural: 'места без типа', glyph: '?' },
};

/* Виды вкладки «Места»: какие типы места видны в каждом виде. Таблица — единый
 * источник и для матчинга (`matchesCatalogView`), и для стартовых фильтров
 * (`setCatalogView`), и для списка чипов (`renderFilters`). Каждый тип из
 * PLACE_TYPES обязан попасть хотя бы в один вид, иначе запись есть в данных, но
 * не видна ни в одном виде и не считается в счётчиках. Поэтому `unknown` (место
 * без типа, см. data-loader.ts) отнесён к «Иному месту», а не выброшен. */
export const CATALOG_VIEW_TYPES: Readonly<Record<string, readonly string[]>> = {
  planet: ['planet'],
  station: ['station'],
  platform: ['platform', 'station'],
  other: ['moon', 'asteroid', 'other', 'unknown'],
};

export type UnknownRecord = Record<string, unknown>;
export type MapCoord = [number, number];

/* Статус 3D-профиля планеты из `data/planet-generation.csv` (Этап 7).
 * `frozen` — утверждённый L1-профиль с замороженным `generation_key` (PG1),
 * `draft` — черновик администратора, `review` — профиль на проверке. */
export type PlanetProfileStatus = 'draft' | 'review' | 'frozen';

/* Фракции: цвета — данные таблицы `data/factions.csv` (лист `faction_details`),
 * а не вычисляемый оттенок от имени. Строка с ключом «—» (U+2014) в этой таблице
 * зарезервирована и означает «фракции нет»; у неё обязателен только цвет. */
export const NEUTRAL_FACTION_LABEL = 'Без фракции';
export const NO_FACTION_KEY = '\u2014';
export type FactionColor = string;

export interface FactionDetails {
  readonly color: FactionColor;
  readonly short: string;
  readonly order: number | null;
}

/* Маршрут боевого WebGL2-глобуса и подпись пресета по умолчанию.
 * Ссылка перехода из Атласа сектора собирается только через `planetGlobeUrl`,
 * чтобы формат `?place=<id>&system=<systemId>` оставался единым. */
export const PLANET_GLOBE = {
  route: '/planet-globe/',
  defaultPresetLabel: 'процедурный глобус c100-soft-v2',
} as const;

export interface MapPoint {
  x: number;
  y: number;
}

export interface CanonicalSystemRef {
  name: string;
  [key: string]: unknown;
}

export interface PlaceRecord {
  id: string;
  name: string;
  nameEn?: string;
  systemId?: string | null;
  system?: string | null;
  placeTypes?: string[];
  factions?: string[];
  terrain?: string[];
  wikiCategories?: string[];
  population?: string | number;
  status?: string;
  note?: string;
  parent?: string;
  custom?: boolean;
  onMap?: boolean;
  canonical?: boolean;
  canonicalSystem?: CanonicalSystemRef | null;
  pointOfInterest?: boolean;
  mapCoord?: MapPoint | null;
  mapLabel?: string;
  sourceLine?: string;
  sourceUrl?: string;
  wiki?: string;
  wikiConfidence?: string;
  primaryFaction?: string;
  /* 3D-профиль планеты из `data/planet-generation.csv` (Этап 7). Поля заполняет
   * `mergePlanetGenerationRows`; отсутствие строки в таблице оставляет их пустыми. */
  planetProfileStatus?: PlanetProfileStatus | null;
  planetPresetId?: string | null;
  planetRadiusKm?: number | null;
  planetGenerationKey?: string | null;
  [key: string]: unknown;
}

export interface SystemRecord {
  id: string;
  name: string;
  nameEn?: string;
  systemType?: string;
  system_id?: string;
  coord: MapCoord | null;
  coordSource?: string | null;
  worlds: PlaceRecord[];
  planetIds?: Array<string | number>;
  factions?: string[];
  primaryFaction?: string;
  note?: string;
  sourceUrl?: string;
  refs?: string[];
  wiki?: string;
  canonical?: boolean;
  confidence?: string;
  mapVerified?: boolean;
  needsReview?: boolean;
  mapLabel?: string | null;
  mapNote?: string;
  fromSheet?: boolean;
  isFreePoint?: boolean;
  [key: string]: unknown;
}

export interface TravelPointRecord {
  id: string;
  name: string;
  coord: MapCoord | null;
  coordSource?: string | null;
  isFreePoint?: boolean;
  [key: string]: unknown;
}

export interface AtlasTravelStop extends TravelStop {
  readonly system: SystemRecord | TravelPointRecord;
}

export interface MapLabel {
  name: string;
  x: number;
  y: number;
  kind?: string;
  conf?: string | number;
  noisy?: boolean;
  linkedSystemId?: string;
  linkedPlanetId?: string;
  [key: string]: unknown;
}

export interface SystemOverride {
  name?: string;
  label?: string;
  x?: unknown;
  y?: unknown;
  x_norm?: unknown;
  y_norm?: unknown;
  confidence?: string;
  faction?: string;
  description?: string;
  source?: string;
  [key: string]: unknown;
}

export interface AtlasOverrides {
  systems: Record<string, SystemOverride>;
  [key: string]: unknown;
}

export interface AtlasMeta {
  mapSize?: number;
  generatedAt?: string;
  generated?: string;
  assets?: {
    imageVersion?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AtlasDataset {
  meta: AtlasMeta;
  systems: UnknownRecord[];
  planets: PlaceRecord[];
  overrides: AtlasOverrides;
  labels: MapLabel[];
  readonly sectorBounds?: SectorBounds | null;
}

export type AtlasData = AtlasDataset;

interface SearchEntryBase {
  kindLabel: string;
  glyph: string;
  id: string;
  title: string;
  subtitle: string;
}

export interface CatalogSearchEntry extends SearchEntryBase {
  kind: 'system' | 'planet' | 'marker';
  key: string;
  extra: string;
}

export interface CoordinateSearchEntry extends SearchEntryBase {
  kind: 'coordinate';
  x: number;
  y: number;
}

export type SearchEntry = CatalogSearchEntry | CoordinateSearchEntry;

export interface AtlasView {
  scale: number;
  tx: number;
  ty: number;
}

export interface AtlasViewport {
  w: number;
  h: number;
}

export interface AtlasTravelState {
  enabled: boolean;
  freePointMode: boolean;
  ids: string[];
  customPoints: Record<string, TravelPointRecord>;
  nextFreePointId: number;
  speedText: string;
  returnEnabled: boolean;
  departureLocal: string;
  animationPreference: boolean | null;
  calculation: TravelCalculation | null;
  infoId: string | null;
  catalogWasOpen: boolean;
}

export interface AtlasState {
  meta: AtlasMeta | null;
  systemsRaw: UnknownRecord[];
  systems: SystemRecord[];
  planets: PlaceRecord[];
  labels: MapLabel[];
  overrides: AtlasOverrides | null;
  sectorBounds?: SectorBounds | null;
  systemsById: Record<string, SystemRecord>;
  planetsById: Record<string, PlaceRecord>;
  planetByName: Record<string, PlaceRecord>;
  factionsByPlanet: Record<string, number>;
  order: { systems: string[]; planets: string[] };
  tab: 'systems' | 'planets';
  catalogView: string | null;
  query: string;
  listFactions: string[];
  activeFactions: string[];
  activeTypes: string[];
  mapFaction: string;
  sortByCount: boolean;
  labelsOn: boolean;
  hoverId: string | null;
  hoverPoiId: string | null;
  activeSystemId: string | null;
  activePlanetId: string | null;
  pinned: boolean;
  view: AtlasView;
  viewport: AtlasViewport;
  dpr: number;
  travel: AtlasTravelState;
}

export interface AtlasTheme {
  bg: string;
  accent: string;
  accent2: string;
  text: string;
  muted: string;
  line: string;
  mono: string;
}

export interface AtlasSkin {
  panelOffCanvas: boolean;
  panelBottomSheet: boolean;
  panelSidebar: boolean;
  panelOpen: boolean;
}

export type SuggestionsElement = HTMLElement & { _results?: SearchEntry[] };

export interface AtlasElements {
  searchInput: HTMLInputElement;
  clearSearch: HTMLElement;
  suggestions: SuggestionsElement;
  searchWrap: HTMLElement;
  searchHintViewport: HTMLElement;
  searchHintTrack: HTMLElement;
  mapFactionFilter: HTMLSelectElement;
  mapStage: HTMLElement;
  mapCanvas: HTMLCanvasElement;
  leftPanel: HTMLElement;
  closePanel: HTMLElement;
  toggleSidePanel: HTMLElement | null;
  filters: HTMLElement;
  filterResultCount: HTMLElement;
  filterIndicator: HTMLElement;
  catalogSectionDropdown: HTMLDetailsElement;
  catalogSectionSummary: HTMLElement;
  catalogSectionSummaryCount: HTMLElement;
  catalogListDropdown: HTMLDetailsElement;
  listCaption: HTMLElement;
  sortButton: HTMLElement;
  catalogList: HTMLElement;
  detailPanel: HTMLElement;
  detailType: HTMLElement;
  detailContent: HTMLElement;
  detailFooter: HTMLElement;
  pinButton: HTMLElement;
  closeDetail: HTMLElement;
  helpButton: HTMLElement;
  closeHelp: HTMLElement;
  helpModal: HTMLElement;
  zoomIn: HTMLElement;
  zoomOut: HTMLElement;
  resetMap: HTMLElement;
  zoomPercent: HTMLElement;
  labelsToggle: HTMLElement;
  coordinateToggle: HTMLElement | null;
  mapCoordinateReadout: HTMLElement | null;
  toast: HTMLElement;
  travelPanel: HTMLElement;
  travelModeToggle: HTMLElement;
  travelFreePointToggle: HTMLElement;
  travelTapeTop: HTMLElement;
  travelTapeBottom: HTMLElement;
  travelClose: HTMLElement;
  travelCount: HTMLElement;
  travelSpeed: HTMLInputElement;
  travelSpeedError: HTMLElement;
  travelDeparture: HTMLInputElement;
  travelReturn: HTMLInputElement;
  travelAnimate: HTMLInputElement;
  travelMotionNote: HTMLElement;
  travelStops: HTMLElement;
  travelRouteHint: HTMLElement;
  travelEmpty: HTMLElement;
  travelSummary: HTMLElement;
  travelLogPreview: HTMLElement;
  travelCopy: HTMLButtonElement;
  travelClear: HTMLElement;
  legacyControls: HTMLElement | null;
}

export interface AtlasRuntime {
  renderQueued: boolean;
  toastTimer: number | null;
  loaderDismissed: boolean;
  fieldContextLost: boolean;
  coordinateReadoutEnabled: boolean;
  coordinatePointer: MapPoint | null;
  travelCore: TravelPlannerApi | null;
}

export interface SelectionOptions {
  center?: boolean;
  fromHover?: boolean;
  pin?: boolean;
  forceDetail?: boolean;
}

export interface DataLoaderApi {
  loadDataset(): Promise<AtlasDataset>;
  buildModel(): void;
  mapSize(): number;
  explicitMapNumber(value: unknown): number | null;
  coordinateOnMap(point: MapPoint | null | undefined): point is MapPoint;
  normalizedSystemType(value: unknown): string;
  sheetValue(value: unknown): string;
  isPlatformPlace(place: PlaceRecord): boolean;
  placeTypesOf(place: PlaceRecord): string[];
  primaryPlaceType(place: PlaceRecord): string;
  placeTypeLabel(place: PlaceRecord, all?: boolean): string;
  placeTypeGlyph(place: PlaceRecord): string;
  factionsOf(place: PlaceRecord): string[];
  systemFactions(system: SystemRecord): string[];
  /* Цвета фракций из `data/factions.csv`: пустое имя — цвет строки «—»,
   * известное — цвет её строки, неизвестное — цвет «—» и предупреждение. */
  factionColor(name: string | null | undefined): FactionColor;
  factionsByName(): ReadonlyMap<string, FactionDetails>;
  search(query: string): SearchEntry[];
}

export interface CanvasRendererApi {
  fitScale(): number;
  minScale(): number;
  maxScale(): number;
  fitView(): void;
  clampView(): void;
  toScreen(x: number, y: number): MapPoint;
  toWorld(x: number, y: number): MapPoint;
  zoomAt(screenX: number, screenY: number, factor: number): void;
  centerOn(worldX: number, worldY: number, scale?: number): void;
  cancelAnimation(): void;
  requestRender(): void;
  visibleSystems(): SystemRecord[];
  visiblePointsOfInterest(): PlaceRecord[];
  hasActivePointers(): boolean;
  bindMapEvents(): void;
  /**
   * Приглушение маркеров на время `anticipation` (`§6.4`, долг `SW-3F`): цель
   * полёта остаётся яркой, остальные получают `alpha`. `setFlightDim(null, 1)`
   * возвращает штатное поведение. Внутренний метод рендерера — его вызывает
   * только `app.ts` по подписке на фазы полёта.
   */
  setFlightDim(targetId: string | null, alpha: number): void;
}

export interface CatalogPanelApi {
  bind(): void;
  detectSkin(): void;
  setPanelOpen(open: boolean): void;
  updateSearchHintDistance(): void;
  updateSuggestions(): void;
  matchesCatalogView(place: PlaceRecord, view?: string | null): boolean;
  catalogViewForPlace(place: PlaceRecord): string;
  updateCatalogSectionState(): void;
  setCatalogView(view: string | null): void;
  renderFilters(): void;
  renderCatalog(): void;
}

export interface DossierCardApi {
  bind(): void;
  selectSystem(id: string | null | undefined, options?: SelectionOptions): void;
  selectPlanet(id: string | null | undefined, options?: SelectionOptions): void;
  clearDetail(): void;
  renderDetail(): void;
  syncDetailPreview(): void;
  centerActiveDetail(): void;
  updateHash(): void;
  applyHash(): boolean;
}

export interface CoordsReadoutApi {
  bind(): void;
  initializeTravelPlanner(): void;
  updateZoomReadout(): void;
  updateCoordinateReadout(): void;
  copyTextToClipboard(value: string, successMessage: string, failureMessage: string): void;
  copyMapCoordinates(point: MapPoint): void;
  travelStops(): AtlasTravelStop[];
  travelEntityForId(id: string): SystemRecord | TravelPointRecord | null;
  travelCoordinates(entity: SystemRecord | TravelPointRecord | null | undefined): MapCoord | null;
  isTravelAnimationActive(): boolean;
  cancelPendingTravelTap(): void;
  scheduleTravelSystemAdd(system: SystemRecord, pointerType?: string): void;
  scheduleFreeTravelPoint(world: MapPoint, pointerType?: string): void;
  addTravelSystem(system: SystemRecord): boolean;
  setFreePointMode(enabled: boolean): void;
}

export interface AtlasShellApi {
  toast(message: string): void;
  layoutMapControls(): void;
  resize(): void;
  dismissTimelineLoader(): void;
}

export interface AtlasKernel {
  doc: Document;
  state: AtlasState;
  theme: AtlasTheme;
  el: AtlasElements;
  skin: AtlasSkin;
  runtime: AtlasRuntime;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  fieldCanvas: HTMLCanvasElement | null;
  field: SectorField | null;
  data: DataLoaderApi;
  renderer: CanvasRendererApi;
  catalog: CatalogPanelApi;
  dossier: DossierCardApi;
  coords: CoordsReadoutApi;
  app: AtlasShellApi;
}

declare global {
  interface Window {
    __MAP_DATA__?: Partial<AtlasDataset>;
  }
}

/* ------------------------------------------------------------------ утилиты */

export function qs<T extends Element = HTMLElement>(
  selector: string,
  root?: ParentNode,
): T | null {
  return (root || document).querySelector(selector) as T | null;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : (value > max ? max : value);
}

export function escapeHtml(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function normalize(value: unknown): string {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\wа-я\s-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchKey(value: unknown): string {
  return normalize(value).replace(/^система\s+/, '');
}

export function plural(count: number, forms: readonly [string, string, string]): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

export function formatNumber(value: number | string): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
}

/* Разбор табличного цвета `#rrggbb` в каналы RGB. Цвет не вычисляется из
 * имени и не изменяется: вызывающий только накладывает на него альфу. */
export function parseHexColor(color: FactionColor): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!match) return null;
  const hex = match[1]!;
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

export function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* приватный режим */ }
}

export function assetVersion(): string {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script || !script.src) return '';
  try {
    return new URL(script.src).searchParams.get('v') || '';
  } catch {
    return '';
  }
}

export function resolveFieldStyle(search?: string): FieldStyle {
  try {
    const raw = search === undefined ? window.location.search : search;
    const param = new URLSearchParams(raw).get('style');
    return param === 'tactical' ? 'tactical' : CONFIG.field.style;
  } catch {
    return CONFIG.field.style;
  }
}

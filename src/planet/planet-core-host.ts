// planet-core-host — TS-обёртка над Wasm-ускорителем planet-core
// (CR-01 PR 4, И-6). Ядра (AssemblyScript, src/planet/assembly/kernels.ts)
// повторяют арифметику JS-рецептов Этапов 4–6 побитово; host только
// маршаллит типизированные массивы в линейную память и обратно.
//
// Два модуля:
//  - PlanetCore (полный, ~24 КиБ) — только воркер/Node: синхронная
//    компиляция Wasm > 4 КиБ на главном потоке запрещена Chrome.
//  - PlanetNoiseCore (шумовой, < 4 КиБ) — везде, включая главный поток.
//
// Память: bump-арена с arenaBase() ядра; каждый публичный метод
// самодостаточен (сброс курсора на входе). Таблица градиентов симплекса
// пишется один раз по фиксированному смещению 512 КиБ (статика ядра
// обязана заканчиваться раньше — проверка heapBase()).

import { PLANET_CORE_WASM_BASE64, PLANET_NOISE_WASM_BASE64 } from './planet-core-bytes.ts';

const GRAD3: readonly number[] = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
];
const GRAD_TABLE_OFFSET = 524288;
const DIAL_BUCKETS = 8192;
const MAX_HEAP_CAP = 1 << 28;

function decodeBase64(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const bufferCtor = (globalThis as { Buffer?: { from(data: string, encoding: string): Uint8Array } }).Buffer;
  if (bufferCtor) return new Uint8Array(bufferCtor.from(base64, 'base64'));
  throw new Error('PlanetCore: нет декодера base64 (atob/Buffer)');
}

export interface PlanetNoiseCoreExports {
  memory: WebAssembly.Memory;
  coreVersion(): number;
  heapBase(): number;
  arenaBase(): number;
  setGradTable(ptr: number): void;
  xxhash32(bytes: number, len: number, seed: number): number;
  simplexOnce(table: number, x: number, y: number, z: number): number;
  fbmOnce(table: number, x: number, y: number, z: number, octaves: number, lacunarity: number, gain: number): number;
  valueOnce(seed: number, x: number, y: number, z: number): number;
}

export interface PlanetCoreExports extends PlanetNoiseCoreExports {
  sampleFieldsBatch(tables: number, params: number, centers: number, out: number, volcPreOut: number, count: number): void;
  radixOrderF32(values: number, order: number, tmp: number, counts: number, count: number, descending: number): void;
  radixOrderF64(values: number, order: number, tmp: number, counts: number, count: number, descending: number): void;
  dialBlockSize(): number;
  edgeCosts(neighbors: number, neighborCount: number, elevation: number, temperature: number,
    moisture: number, plateId: number, plateBoundary: number, support: number,
    plateCross: number, out: number, count: number): void;
  dijkstraTopOne(neighbors: number, neighborCount: number, costs: number, seeds: number,
    biases: number, seedCount: number, count: number, labelOut: number, distScratch: number,
    heapDist: number, heapCell: number, heapLabel: number, heapNext: number,
    heapBuckets: number, heapB0Cell: number, heapB0Label: number, heapCap: number): number;
  dialTopOne(neighbors: number, neighborCount: number, costs: number, seeds: number,
    biases: number, seedCount: number, count: number, labelOut: number, distScratch: number,
    dialMeta: number, nBuckets: number, poolK: number, poolC: number, poolL: number,
    blockNext: number, nBlocks: number, sortK: number, sortC: number, sortL: number,
    sortIdx: number, sortAux: number, cnt: number, sortCap: number): number;
  dijkstraTopTwo(neighbors: number, neighborCount: number, costs: number, seeds: number,
    biases: number, seedCount: number, count: number, label1Out: number, label2Out: number,
    dist1Out: number, dist2Out: number, heapDist: number, heapCell: number, heapLabel: number,
    heapNext: number, heapBuckets: number, heapB0Cell: number, heapB0Label: number, heapCap: number): number;
  dialTopTwo(neighbors: number, neighborCount: number, costs: number, seeds: number,
    biases: number, seedCount: number, count: number, label1Out: number, label2Out: number,
    dist1Out: number, dist2Out: number, dialMeta: number, nBuckets: number, poolK: number,
    poolC: number, poolL: number, blockNext: number, nBlocks: number, sortK: number,
    sortC: number, sortL: number, sortIdx: number, sortAux: number, cnt: number, sortCap: number): number;
  coastDistance(neighbors: number, neighborCount: number, elevation: number, hardLand: number,
    seaLevel: number, count: number, distOut: number, heapDist: number, heapCell: number,
    heapNext: number, heapBuckets: number, heapB0Cell: number, heapCap: number): number;
  chooseSeedsKernel(candidates: number, candCount: number, centers: number, score: number,
    desired: number, desiredLen: number, countWant: number, meanSpacing: number, maxScore: number,
    selectedOut: number, minChord2: number, minResidual: number): number;
  priorityFlood(neighbors: number, neighborCount: number, elevation: number, hardLand: number,
    count: number, filledOut: number, parentOut: number, seen: number, heapDist: number,
    heapCell: number, heapNext: number, heapBuckets: number, heapB0Cell: number, heapCap: number): number;
  flowReceivers(neighbors: number, neighborCount: number, centers: number, elevation: number,
    filled: number, parent: number, hardLand: number, count: number, rawSlopeOut: number,
    slopeOut: number, rawReceiverOut: number, filledReceiverOut: number): void;
  accumulateFlow(hardLand: number, landCells: number, landCount: number, flowReceiver: number,
    localKm2: number, localCells: number, filled: number, accKm2: number, accCells: number,
    orderOut: number, orderLenOut: number, upstream: number, processed: number, queue: number,
    sortOrder: number, sortTmp: number, sortCounts: number, count: number): number;
  biomeWeights(muOcean: number, muShelf: number, muLand: number, temperature: number,
    moisture: number, elevation: number, riverInfluence: number, lakeWeight: number,
    deltaWeight: number, slope: number, mountainWeight: number, mountainSeamWeight: number,
    coastExp: number, volcPow: number, hardLand: number, params: number,
    weightsOut: number, count: number): void;
  smoothBiomeWeights(weights: number, next: number, neighbors: number, neighborCount: number,
    muOcean: number, muShelf: number, muLand: number, lakeWeight: number, hardLand: number,
    alphas: number, steps: number, count: number): number;
  globePack(centers: number, cornerCoords: number, cellCorners: number, cellCornerStart: number,
    cellRadius: number, cornerRadius: number, positions: number, normals: number, count: number): number;
  expandVertexColors(vertexCellId: number, cellColors: number, out: number,
    centerCount: number, vertexCount: number): void;
}

/** Счётчики фактических созданий экземпляров ядер (Stage-8.8.1, A-3).
 *  Публичный инструмент границ: тест `tests/planet-core-boundary.test.mjs`
 *  доказывает, что импорт модулей главного потока не создаёт арену.
 *  Инкремент — в конструкторе, т.е. ровно один раз на WebAssembly.Instance. */
export interface PlanetCoreCreationCounters {
  /** Сколько раз создан полный PlanetCore (арена >= 24 МиБ). */
  full: number;
  /** Сколько раз создано компактное PlanetNoiseCore (< 4 КиБ). */
  noise: number;
}

const creationCounters: PlanetCoreCreationCounters = { full: 0, noise: 0 };

/** Счётчики созданий ядер только для чтения (живой объект). */
export function getPlanetCoreCreationCounters(): Readonly<PlanetCoreCreationCounters> {
  return creationCounters;
}

export abstract class PlanetCoreBase<E extends PlanetNoiseCoreExports> {
  readonly exports: E;
  protected cursor: number;
  protected readonly arenaStart: number;

  protected constructor(base64: string, label: string) {
    if (typeof WebAssembly === 'undefined' || typeof WebAssembly.Module !== 'function') {
      throw new Error(`${label}: WebAssembly недоступен в этом окружении`);
    }
    const bytes = decodeBase64(base64);
    const module = new WebAssembly.Module(bytes as BufferSource);
    const instance = new WebAssembly.Instance(module, {
      env: {
        abort: (): never => {
          throw new Error(`${label}: внутренняя остановка Wasm-ядра (abort)`);
        },
      },
    });
    this.exports = instance.exports as unknown as E;
    if (this.exports.heapBase() > GRAD_TABLE_OFFSET) {
      throw new Error(`${label}: статика ядра перекрывает таблицу градиентов`);
    }
    new Float64Array(this.exports.memory.buffer, GRAD_TABLE_OFFSET, GRAD3.length).set(GRAD3);
    this.exports.setGradTable(GRAD_TABLE_OFFSET);
    this.arenaStart = this.exports.arenaBase();
    this.cursor = this.arenaStart;
  }

  protected resetArena(): void {
    this.cursor = this.arenaStart;
  }

  protected alloc(bytes: number): number {
    const ptr = (this.cursor + 15) & ~15;
    this.cursor = ptr + bytes;
    this.ensure(this.cursor);
    return ptr;
  }

  protected ensure(totalBytes: number): void {
    const memory = this.exports.memory;
    const have = memory.buffer.byteLength;
    if (have >= totalBytes) return;
    const pages = Math.ceil((totalBytes - have) / 65536);
    memory.grow(pages);
  }

  protected putU8(data: Uint8Array): number {
    const ptr = this.alloc(data.byteLength);
    new Uint8Array(this.exports.memory.buffer, ptr, data.length).set(data);
    return ptr;
  }

  protected putF32(data: Float32Array): number {
    const ptr = this.alloc(data.byteLength);
    new Float32Array(this.exports.memory.buffer, ptr, data.length).set(data);
    return ptr;
  }

  protected putF64(data: Float64Array): number {
    const ptr = this.alloc(data.byteLength);
    new Float64Array(this.exports.memory.buffer, ptr, data.length).set(data);
    return ptr;
  }

  protected putI32(data: Int32Array): number {
    const ptr = this.alloc(data.byteLength);
    new Int32Array(this.exports.memory.buffer, ptr, data.length).set(data);
    return ptr;
  }

  protected putU32(data: Uint32Array): number {
    const ptr = this.alloc(data.byteLength);
    new Uint32Array(this.exports.memory.buffer, ptr, data.length).set(data);
    return ptr;
  }

  protected getU8(ptr: number, length: number): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, ptr, length).slice();
  }

  protected getF32(ptr: number, length: number): Float32Array {
    return new Float32Array(this.exports.memory.buffer, ptr, length).slice();
  }

  protected getF64(ptr: number, length: number): Float64Array {
    return new Float64Array(this.exports.memory.buffer, ptr, length).slice();
  }

  protected getI32(ptr: number, length: number): Int32Array {
    return new Int32Array(this.exports.memory.buffer, ptr, length).slice();
  }

  protected getU32(ptr: number, length: number): Uint32Array {
    return new Uint32Array(this.exports.memory.buffer, ptr, length).slice();
  }

  protected getI16(ptr: number, length: number): Int16Array {
    return new Int16Array(this.exports.memory.buffer, ptr, length).slice();
  }

  xxhash32(data: Uint8Array, seed: number): number {
    this.resetArena();
    const ptr = this.putU8(data);
    return this.exports.xxhash32(ptr, data.length, seed >>> 0) >>> 0;
  }
}

// Шумовое ядро для сэмплеров planet-noise: таблицы перестановок живут в
// арене постоянно (bump без сброса), указатель таблицы — хэндл сэмплера.
export class PlanetNoiseCore extends PlanetCoreBase<PlanetNoiseCoreExports> {
  constructor() {
    super(PLANET_NOISE_WASM_BASE64, 'PlanetNoiseCore');
    creationCounters.noise++;
  }

  uploadTable(table: Uint8Array): number {
    return this.putU8(table);
  }

  simplexOnce(table: number, x: number, y: number, z: number): number {
    return this.exports.simplexOnce(table, x, y, z);
  }

  fbmOnce(table: number, x: number, y: number, z: number, octaves: number, lacunarity: number, gain: number): number {
    return this.exports.fbmOnce(table, x, y, z, octaves, lacunarity, gain);
  }

  valueOnce(seed: number, x: number, y: number, z: number): number {
    return this.exports.valueOnce(seed, x, y, z);
  }
}

export class PlanetCore extends PlanetCoreBase<PlanetCoreExports> {
  private dialViolated = false;
  private cachedNeighbors: Int32Array | null = null;
  private cachedNeighborCount: Uint8Array | null = null;
  private pCachedNb = 0;
  private pCachedNc = 0;
  private gridArenaEnd = 0;
  private lastFloodNbPtr = 0;
  private lastFloodNcPtr = 0;
  private lastFloodElPtr = 0;
  private lastFloodHlPtr = 0;
  private lastFloodFilledPtr = 0;
  private lastFloodParentPtr = 0;
  private postFloodCursor = 0;
  private postFlowCursor = 0;
  private cachedBalEl: Float32Array | null = null;
  private cachedBalTe: Float32Array | null = null;
  private cachedBalMo: Float32Array | null = null;
  private cachedBalPl: Int32Array | null = null;
  private cachedBalPb: Float32Array | null = null;
  private pBalEl = 0;
  private pBalTe = 0;
  private pBalMo = 0;
  private pBalPl = 0;
  private pBalPb = 0;
  private balArenaEnd = 0;

  constructor() {
    super(PLANET_CORE_WASM_BASE64, 'PlanetCore');
    this.ensure(24 * 1024 * 1024);
    creationCounters.full++;
  }

  protected override resetArena(): void {
    this.postFloodCursor = 0;
    this.postFlowCursor = 0;
    this.cursor = this.balArenaEnd > 0
      ? this.balArenaEnd
      : (this.gridArenaEnd > 0 ? this.gridArenaEnd : this.arenaStart);
  }

  private putGrid(neighbors: Int32Array, neighborCount: Uint8Array): { pNb: number; pNc: number } {
    this.postFloodCursor = 0;
    this.postFlowCursor = 0;
    if (neighbors.length >= 1000 &&
        this.cachedNeighbors !== null &&
        this.cachedNeighborCount !== null &&
        (neighbors === this.cachedNeighbors ||
         (neighbors.length === this.cachedNeighbors.length &&
          neighborCount.length === this.cachedNeighborCount.length &&
          neighbors[0] === this.cachedNeighbors[0] &&
          neighbors[neighbors.length >> 1] === this.cachedNeighbors[neighbors.length >> 1] &&
          neighbors[neighbors.length - 1] === this.cachedNeighbors[neighbors.length - 1]))) {
      this.cachedNeighbors = neighbors;
      this.cachedNeighborCount = neighborCount;
      this.cursor = this.balArenaEnd > 0 ? this.balArenaEnd : this.gridArenaEnd;
      return { pNb: this.pCachedNb, pNc: this.pCachedNc };
    }
    this.balArenaEnd = 0;
    this.cursor = this.arenaStart;
    const pNb = this.putI32(neighbors);
    const pNc = this.putU8(neighborCount);
    if (neighbors.length >= 1000) {
      this.cachedNeighbors = neighbors;
      this.cachedNeighborCount = neighborCount;
      this.pCachedNb = pNb;
      this.pCachedNc = pNc;
      this.gridArenaEnd = this.cursor;
    } else {
      this.cachedNeighbors = null;
      this.cachedNeighborCount = null;
      this.gridArenaEnd = 0;
    }
    return { pNb, pNc };
  }

  // ---- шум/поля -------------------------------------------------------

  sampleFields(
    tables: Uint8Array, params: Float64Array, centers: Float32Array | Float64Array,
    startCell = 0, cellCount?: number,
  ): { fields: Float32Array; volcPre: Float64Array } {
    const count = cellCount !== undefined ? cellCount : (centers.length / 3) - startCell;
    this.balArenaEnd = 0;
    this.resetArena();
    const pTables = this.putU8(tables);
    const pParams = this.putF64(params);
    const len3 = count * 3;
    const base = startCell * 3;
    let pCenters: number;
    let batchCount: number;
    if (centers instanceof Float32Array) {
      pCenters = this.alloc(len3 * 4);
      new Float32Array(this.exports.memory.buffer, pCenters, len3).set(
        base === 0 && centers.length === len3 ? centers : centers.subarray(base, base + len3),
      );
      batchCount = -count;
    } else {
      pCenters = this.alloc(len3 * 8);
      new Float64Array(this.exports.memory.buffer, pCenters, len3).set(
        base === 0 && centers.length === len3 ? centers : centers.subarray(base, base + len3),
      );
      batchCount = count;
    }
    const pOut = this.alloc(count * 6 * 4);
    const pVolc = this.alloc(count * 8);
    this.exports.sampleFieldsBatch(pTables, pParams, pCenters, pOut, pVolc, batchCount);
    const buf = this.exports.memory.buffer;
    return {
      fields: new Float32Array(buf, pOut, count * 6),
      volcPre: new Float64Array(buf, pVolc, count),
    };
  }

  // ---- сортировки -----------------------------------------------------

  radixOrderF32(values: Float32Array, order: Uint32Array, descending: boolean, copy = true): Uint32Array {
    if (values.buffer === this.exports.memory.buffer && this.postFlowCursor > 0) {
      this.cursor = this.postFlowCursor;
      const pValues = values.byteOffset;
      const pOrder = this.putU32(order);
      const pTmp = this.alloc(order.length * 4);
      const pCounts = this.alloc(1024);
      this.exports.radixOrderF32(pValues, pOrder, pTmp, pCounts, order.length, descending ? 1 : 0);
      return copy ? this.getU32(pOrder, order.length) : new Uint32Array(this.exports.memory.buffer, pOrder, order.length);
    }
    this.resetArena();
    const pValues = this.putF32(values);
    const pOrder = this.putU32(order);
    const pTmp = this.alloc(order.length * 4);
    const pCounts = this.alloc(1024);
    this.exports.radixOrderF32(pValues, pOrder, pTmp, pCounts, order.length, descending ? 1 : 0);
    return copy ? this.getU32(pOrder, order.length) : new Uint32Array(this.exports.memory.buffer, pOrder, order.length);
  }

  radixOrderF64(values: Float64Array, order: Uint32Array, descending: boolean, copy = true): Uint32Array {
    if (values.buffer === this.exports.memory.buffer && this.postFlowCursor > 0) {
      this.cursor = this.postFlowCursor;
      const pValues = values.byteOffset;
      const pOrder = this.putU32(order);
      const pTmp = this.alloc(order.length * 4);
      const pCounts = this.alloc(1024);
      this.exports.radixOrderF64(pValues, pOrder, pTmp, pCounts, order.length, descending ? 1 : 0);
      return copy ? this.getU32(pOrder, order.length) : new Uint32Array(this.exports.memory.buffer, pOrder, order.length);
    }
    this.resetArena();
    const pValues = this.putF64(values);
    const pOrder = this.putU32(order);
    const pTmp = this.alloc(order.length * 4);
    const pCounts = this.alloc(1024);
    this.exports.radixOrderF64(pValues, pOrder, pTmp, pCounts, order.length, descending ? 1 : 0);
    return copy ? this.getU32(pOrder, order.length) : new Uint32Array(this.exports.memory.buffer, pOrder, order.length);
  }

  // ---- граф: стоимости и Дейкстры ------------------------------------

  edgeCosts(
    neighbors: Int32Array, neighborCount: Uint8Array, elevation: Float32Array,
    temperature: Float32Array, moisture: Float32Array, plateId: Int32Array,
    plateBoundary: Float32Array, support: Float32Array, plateCross: number, count: number,
  ): Float32Array {
    this.resetArena();
    const pNb = this.putI32(neighbors);
    const pNc = this.putU8(neighborCount);
    const pEl = this.putF32(elevation);
    const pTe = this.putF32(temperature);
    const pMo = this.putF32(moisture);
    const pPl = this.putI32(plateId);
    const pPb = this.putF32(plateBoundary);
    const pSu = this.putF32(support);
    const pOut = this.alloc(count * 6 * 4);
    this.exports.edgeCosts(pNb, pNc, pEl, pTe, pMo, pPl, pPb, pSu, plateCross, pOut, count);
    return this.getF32(pOut, count * 6);
  }

  private heapBuffers(cap: number): { rec: number } {
    return { rec: this.alloc(cap * 16) };
  }

  private dialBuffers(capEntries: number): {
    meta: number; poolK: number; poolC: number; poolL: number; blockNext: number;
    nBlocks: number; sortK: number; sortC: number; sortL: number;
    sortIdx: number; sortAux: number; cnt: number; sortCap: number;
  } {
    const blockSize = this.exports.dialBlockSize();
    const nBlocks = Math.ceil(capEntries / blockSize) + 16;
    const poolEntries = nBlocks * blockSize;
    const sortCap = Math.min(poolEntries, 65536);
    return {
      meta: this.alloc(DIAL_BUCKETS * 3 * 4),
      poolK: this.alloc(poolEntries * 8),
      poolC: this.alloc(poolEntries * 8),
      poolL: 0,
      blockNext: this.alloc(nBlocks * 4),
      nBlocks,
      sortK: this.alloc(sortCap * 8),
      sortC: this.alloc(sortCap * 8),
      sortL: this.alloc(sortCap * 8),
      sortIdx: 0,
      sortAux: this.alloc(sortCap * 8),
      cnt: 0,
      sortCap,
    };
  }

  dijkstraTopOne(
    neighbors: Int32Array, neighborCount: Uint8Array, costs: Float32Array,
    seeds: Int32Array, biases: Float64Array, count: number,
  ): Int32Array {
    let cap = Math.min(6 * count + seeds.length + 1024, Math.max(8192, (count >> 2) + seeds.length + 1024));
    for (;;) {
      this.resetArena();
      const pNb = this.putI32(neighbors);
      const pNc = this.putU8(neighborCount);
      const pCosts = this.putF32(costs);
      const pSeeds = this.putI32(seeds);
      const pBiases = this.putF64(biases);
      const pLabel = this.alloc(count * 4);
      const pDist = this.alloc(count * 8);
      let rc: number;
      if (!this.dialViolated) {
        const d = this.dialBuffers(cap);
        rc = this.exports.dialTopOne(pNb, pNc, pCosts, pSeeds, pBiases, seeds.length, count,
          pLabel, pDist, d.meta, DIAL_BUCKETS, d.poolK, d.poolC, d.poolL, d.blockNext,
          d.nBlocks, d.sortK, d.sortC, d.sortL, d.sortIdx, d.sortAux, d.cnt, d.sortCap);
        if (rc === 2) {
          this.dialViolated = true;
          continue;
        }
      } else {
        const h = this.heapBuffers(cap);
        rc = this.exports.dijkstraTopOne(pNb, pNc, pCosts, pSeeds, pBiases, seeds.length, count,
          pLabel, pDist, h.rec, 0, 16, 0, 0, 0, 0, cap);
      }
      if (rc === 0) return this.getI32(pLabel, count);
      if (cap >= MAX_HEAP_CAP) throw new Error('PlanetCore.dijkstraTopOne: переполнение очереди');
      cap *= 2;
    }
  }

  dijkstraTopTwo(
    neighbors: Int32Array, neighborCount: Uint8Array, costs: Float32Array,
    seeds: Int32Array, biases: Float64Array, count: number,
  ): { label1: Int32Array; label2: Int32Array; dist1: Float64Array; dist2: Float64Array } {
    let cap = Math.min(6 * count + seeds.length + 1024, Math.max(8192, (count >> 2) + seeds.length + 1024));
    for (;;) {
      this.resetArena();
      const pNb = this.putI32(neighbors);
      const pNc = this.putU8(neighborCount);
      const pCosts = this.putF32(costs);
      const pSeeds = this.putI32(seeds);
      const pBiases = this.putF64(biases);
      const pL1 = this.alloc(count * 4);
      const pL2 = this.alloc(count * 4);
      const pD1 = this.alloc(count * 8);
      const pD2 = this.alloc(count * 8);
      let rc: number;
      if (!this.dialViolated) {
        const d = this.dialBuffers(cap);
        rc = this.exports.dialTopTwo(pNb, pNc, pCosts, pSeeds, pBiases, seeds.length, count,
          pL1, pL2, pD1, pD2, d.meta, DIAL_BUCKETS, d.poolK, d.poolC, d.poolL, d.blockNext,
          d.nBlocks, d.sortK, d.sortC, d.sortL, d.sortIdx, d.sortAux, d.cnt, d.sortCap);
        if (rc === 2) {
          this.dialViolated = true;
          continue;
        }
      } else {
        const h = this.heapBuffers(cap);
        rc = this.exports.dijkstraTopTwo(pNb, pNc, pCosts, pSeeds, pBiases, seeds.length, count,
          pL1, pL2, pD1, pD2, h.rec, 0, 16, 0, 0, 0, 0, cap);
      }
      if (rc === 0) {
        return {
          label1: this.getI32(pL1, count),
          label2: this.getI32(pL2, count),
          dist1: this.getF64(pD1, count),
          dist2: this.getF64(pD2, count),
        };
      }
      if (cap >= MAX_HEAP_CAP) throw new Error('PlanetCore.dijkstraTopTwo: переполнение очереди');
      cap *= 2;
    }
  }

  balanceRegionsTopTwo(
    neighbors: Int32Array, neighborCount: Uint8Array,
    elevation: Float32Array, temperature: Float32Array, moisture: Float32Array,
    plateId: Int32Array, plateBoundary: Float32Array, support: Float32Array,
    plateCross: number, seeds: Int32Array, biases: Float64Array,
    desiredMass: Float64Array, radiusScale: number, iterations: number, count: number,
  ): { label1: Int32Array; label2: Int32Array; dist1: Float64Array; dist2: Float64Array } {
    const { pNb, pNc } = this.putGrid(neighbors, neighborCount);
    let pEl: number, pTe: number, pMo: number, pPl: number, pPb: number;
    if (this.balArenaEnd > 0 &&
        elevation === this.cachedBalEl &&
        temperature === this.cachedBalTe &&
        moisture === this.cachedBalMo &&
        plateId === this.cachedBalPl &&
        plateBoundary === this.cachedBalPb) {
      pEl = this.pBalEl;
      pTe = this.pBalTe;
      pMo = this.pBalMo;
      pPl = this.pBalPl;
      pPb = this.pBalPb;
      this.cursor = this.balArenaEnd;
    } else {
      this.cursor = this.gridArenaEnd > 0 ? this.gridArenaEnd : this.arenaStart;
      pEl = this.putF32(elevation);
      pTe = this.putF32(temperature);
      pMo = this.putF32(moisture);
      pPl = this.putI32(plateId);
      pPb = this.putF32(plateBoundary);
      this.cachedBalEl = elevation;
      this.cachedBalTe = temperature;
      this.cachedBalMo = moisture;
      this.cachedBalPl = plateId;
      this.cachedBalPb = plateBoundary;
      this.pBalEl = pEl;
      this.pBalTe = pTe;
      this.pBalMo = pMo;
      this.pBalPl = pPl;
      this.pBalPb = pPb;
      this.balArenaEnd = this.cursor;
    }
    const pSeeds = this.putI32(seeds);
    const pCosts = this.alloc(count * 6 * 4);
    const savedCursor = this.cursor;
    const pSu = this.putF32(support);
    this.exports.edgeCosts(pNb, pNc, pEl, pTe, pMo, pPl, pPb, pSu, plateCross, pCosts, count);

    const seedCount = seeds.length;
    const initCap = Math.min(6 * count + seedCount + 1024, Math.max(8192, (count >> 2) + seedCount + 1024));
    const actual = new Float64Array(seedCount);
    for (let iteration = 0; iteration < iterations - 1; iteration++) {
      let cap = initCap;
      let pLabel = 0;
      for (;;) {
        this.cursor = savedCursor;
        const pBiases = this.putF64(biases);
        pLabel = this.alloc(count * 4);
        const pDist = this.alloc(count * 8);
        let rc: number;
        if (!this.dialViolated) {
          const d = this.dialBuffers(cap);
          rc = this.exports.dialTopOne(pNb, pNc, pCosts, pSeeds, pBiases, seedCount, count,
            pLabel, pDist, d.meta, DIAL_BUCKETS, d.poolK, d.poolC, d.poolL, d.blockNext,
            d.nBlocks, d.sortK, d.sortC, d.sortL, d.sortIdx, d.sortAux, d.cnt, d.sortCap);
          if (rc === 2) {
            this.dialViolated = true;
            continue;
          }
        } else {
          const h = this.heapBuffers(cap);
          rc = this.exports.dijkstraTopOne(pNb, pNc, pCosts, pSeeds, pBiases, seedCount, count,
            pLabel, pDist, h.rec, 0, 16, 0, 0, 0, 0, cap);
        }
        if (rc === 0) break;
        if (cap >= MAX_HEAP_CAP) throw new Error('PlanetCore.balanceRegionsTopTwo: переполнение очереди TopOne');
        cap *= 2;
      }
      const topOneView = new Int32Array(this.exports.memory.buffer, pLabel, count);
      actual.fill(0);
      for (let c = 0; c < count; c++) {
        const label = topOneView[c] as number;
        if (label >= 0) actual[label] = (actual[label] as number) + (support[c] as number);
      }
      const limit = 1.75 * radiusScale;
      for (let i = 0; i < seedCount; i++) {
        const ratio = ((desiredMass[i] as number) + 0.5) / ((actual[i] as number) + 0.5);
        const nextBias = (biases[i] as number) + 0.25 * radiusScale * Math.log(ratio);
        biases[i] = nextBias < -limit ? -limit : (nextBias > limit ? limit : nextBias);
      }
    }

    let cap = initCap;
    for (;;) {
      this.cursor = savedCursor;
      const pBiases = this.putF64(biases);
      const pL1 = this.alloc(count * 4);
      const pL2 = this.alloc(count * 4);
      const pD1 = this.alloc(count * 8);
      const pD2 = this.alloc(count * 8);
      let rc: number;
      if (!this.dialViolated) {
        const d = this.dialBuffers(cap);
        rc = this.exports.dialTopTwo(pNb, pNc, pCosts, pSeeds, pBiases, seedCount, count,
          pL1, pL2, pD1, pD2, d.meta, DIAL_BUCKETS, d.poolK, d.poolC, d.poolL, d.blockNext,
          d.nBlocks, d.sortK, d.sortC, d.sortL, d.sortIdx, d.sortAux, d.cnt, d.sortCap);
        if (rc === 2) {
          this.dialViolated = true;
          continue;
        }
      } else {
        const h = this.heapBuffers(cap);
        rc = this.exports.dijkstraTopTwo(pNb, pNc, pCosts, pSeeds, pBiases, seedCount, count,
          pL1, pL2, pD1, pD2, h.rec, 0, 16, 0, 0, 0, 0, cap);
      }
      if (rc === 0) {
        const buf = this.exports.memory.buffer;
        return {
          label1: new Int32Array(buf, pL1, count),
          label2: new Int32Array(buf, pL2, count),
          dist1: new Float64Array(buf, pD1, count),
          dist2: new Float64Array(buf, pD2, count),
        };
      }
      if (cap >= MAX_HEAP_CAP) throw new Error('PlanetCore.balanceRegionsTopTwo: переполнение очереди TopTwo');
      cap *= 2;
    }
  }

  coastDistance(
    neighbors: Int32Array, neighborCount: Uint8Array, elevation: Float32Array,
    hardLand: Uint8Array, seaLevel: number, count: number,
  ): { dist: Float64Array; boundaryCount: number } {
    let cap = 2 * count + 1024;
    for (;;) {
      const { pNb, pNc } = this.putGrid(neighbors, neighborCount);
      const pEl = this.putF32(elevation);
      const pHl = this.putU8(hardLand);
      const pOut = this.alloc(count * 8);
      const h = this.heapBuffers(cap);
      const rc = this.exports.coastDistance(pNb, pNc, pEl, pHl, seaLevel, count, pOut,
        h.rec, 0, 0, 0, 0, cap);
      if (rc >= 0) return { dist: new Float64Array(this.exports.memory.buffer, pOut, count), boundaryCount: rc };
      if (cap >= MAX_HEAP_CAP) throw new Error('PlanetCore.coastDistance: переполнение очереди');
      cap *= 2;
    }
  }

  chooseSeeds(
    candidates: Int32Array, centers: Float32Array, score: Float32Array,
    desired: Float64Array, countWant: number, meanSpacing: number, maxScore: number,
  ): Int32Array {
    this.resetArena();
    const pCand = this.putI32(candidates);
    const pCenters = this.putF32(centers);
    const pScore = this.putF32(score);
    const pDesired = desired.length > 0 ? this.putF64(desired) : this.alloc(8);
    const pSelected = this.alloc(Math.max(1, Math.min(countWant, candidates.length)) * 4);
    const pMinChord = this.alloc(candidates.length * 8);
    const pMinResidual = this.alloc(candidates.length * 8 * 5);
    const selected = this.exports.chooseSeedsKernel(pCand, candidates.length, pCenters, pScore,
      pDesired, desired.length, countWant, meanSpacing, maxScore, pSelected, pMinChord, pMinResidual);
    return this.getI32(pSelected, selected);
  }

  // ---- гидрология -----------------------------------------------------

  priorityFlood(
    neighbors: Int32Array, neighborCount: Uint8Array, elevation: Float32Array,
    hardLand: Uint8Array, count: number,
  ): { filled: Float64Array; parent: Int32Array } {
    const { pNb, pNc } = this.putGrid(neighbors, neighborCount);
    const pEl = this.putF32(elevation);
    const pHl = this.putU8(hardLand);
    const pFilled = this.alloc(count * 8);
    const pParent = this.alloc(count * 4);
    const postFloodCursor = this.cursor;
    // Заранее гарантируем ёмкость памяти под всю цепочку гидрологии (flowReceivers + radixOrder + accumulateFlow),
    // чтобы возвращённые представления (views) filled и parent не инвалидировались при memory.grow.
    this.ensure(postFloodCursor + count * 96 + 65536);

    let cap = 6 * count + 1024;
    for (;;) {
      this.cursor = postFloodCursor;
      const pSeen = this.alloc(count);
      const h = this.heapBuffers(cap);
      const rc = this.exports.priorityFlood(pNb, pNc, pEl, pHl, count, pFilled, pParent, pSeen,
        h.rec, 0, 0, 0, 0, cap);
      if (rc === 0) {
        this.lastFloodNbPtr = pNb;
        this.lastFloodNcPtr = pNc;
        this.lastFloodElPtr = pEl;
        this.lastFloodHlPtr = pHl;
        this.lastFloodFilledPtr = pFilled;
        this.lastFloodParentPtr = pParent;
        this.postFloodCursor = postFloodCursor;
        this.postFlowCursor = 0;
        this.cursor = postFloodCursor;
        const buf = this.exports.memory.buffer;
        return {
          filled: new Float64Array(buf, pFilled, count),
          parent: new Int32Array(buf, pParent, count),
        };
      }
      if (cap >= MAX_HEAP_CAP) throw new Error('PlanetCore.priorityFlood: переполнение очереди');
      cap *= 2;
    }
  }

  flowReceivers(
    neighbors: Int32Array, neighborCount: Uint8Array, centers: Float32Array,
    elevation: Float32Array, filled: Float64Array, parent: Int32Array,
    hardLand: Uint8Array, count: number,
  ): {
    rawSlope: Float64Array; slope: Float32Array;
    rawReceiver: Int32Array; filledReceiver: Int32Array;
  } {
    let pNb: number;
    let pNc: number;
    let pEl: number;
    let pFilled: number;
    let pParent: number;
    let pHl: number;
    if (this.postFloodCursor > 0 &&
        filled.buffer === this.exports.memory.buffer &&
        filled.byteOffset === this.lastFloodFilledPtr &&
        parent.byteOffset === this.lastFloodParentPtr) {
      this.cursor = this.postFloodCursor;
      pNb = this.lastFloodNbPtr;
      pNc = this.lastFloodNcPtr;
      pEl = this.lastFloodElPtr;
      pHl = this.lastFloodHlPtr;
      pFilled = this.lastFloodFilledPtr;
      pParent = this.lastFloodParentPtr;
    } else {
      const g = this.putGrid(neighbors, neighborCount);
      pNb = g.pNb;
      pNc = g.pNc;
      pEl = this.putF32(elevation);
      pFilled = this.putF64(filled);
      pParent = this.putI32(parent);
      pHl = this.putU8(hardLand);
    }
    const pCenters = this.putF32(centers);
    const pRawSlope = this.alloc(count * 8);
    const pSlope = this.alloc(count * 4);
    const pRawReceiver = this.alloc(count * 4);
    const pFilledReceiver = this.alloc(count * 4);
    this.postFlowCursor = this.cursor;
    this.exports.flowReceivers(pNb, pNc, pCenters, pEl, pFilled, pParent, pHl, count,
      pRawSlope, pSlope, pRawReceiver, pFilledReceiver);
    const buf = this.exports.memory.buffer;
    return {
      rawSlope: new Float64Array(buf, pRawSlope, count),
      slope: new Float32Array(buf, pSlope, count),
      rawReceiver: new Int32Array(buf, pRawReceiver, count),
      filledReceiver: new Int32Array(buf, pFilledReceiver, count),
    };
  }

  accumulateFlow(
    hardLand: Uint8Array, landCells: Int32Array, flowReceiver: Int32Array,
    localKm2: Float64Array, localCells: Float64Array, filled: Float64Array, count: number,
  ): {
    order: Int32Array; accKm2: Float32Array; accCells: Float32Array;
    flowReceiver: Int32Array; cycleBreakCount: number;
  } {
    let pHl: number;
    let pFilled: number;
    if (this.postFloodCursor > 0 &&
        filled.buffer === this.exports.memory.buffer &&
        filled.byteOffset === this.lastFloodFilledPtr) {
      this.cursor = this.postFloodCursor;
      pHl = this.lastFloodHlPtr;
      pFilled = this.lastFloodFilledPtr;
    } else {
      this.resetArena();
      pHl = this.putU8(hardLand);
      pFilled = this.putF64(filled);
    }
    this.postFloodCursor = 0;
    this.postFlowCursor = 0;
    const pLand = this.putI32(landCells);
    const pReceiver = this.putI32(flowReceiver);
    const pLocalKm2 = this.putF64(localKm2);
    const pLocalCells = this.putF64(localCells);
    const pAccKm2 = this.alloc(count * 4);
    const pAccCells = this.alloc(count * 4);
    const pOrder = this.alloc(count * 4);
    const pOrderLen = this.alloc(4);
    const pUpstream = this.alloc(count * 4);
    const pProcessed = this.alloc(count);
    const pQueue = this.alloc(count * 4);
    const pSortOrder = this.alloc(count * 4);
    const pSortTmp = this.alloc(count * 4);
    const pSortCounts = this.alloc(1024);
    const cycleBreakCount = this.exports.accumulateFlow(pHl, pLand, landCells.length, pReceiver,
      pLocalKm2, pLocalCells, pFilled, pAccKm2, pAccCells, pOrder, pOrderLen, pUpstream,
      pProcessed, pQueue, pSortOrder, pSortTmp, pSortCounts, count);
    const buf = this.exports.memory.buffer;
    const orderLen = new Int32Array(buf, pOrderLen, 1)[0] as number;
    return {
      order: this.getI32(pOrder, orderLen),
      accKm2: new Float32Array(buf, pAccKm2, count),
      accCells: new Float32Array(buf, pAccCells, count),
      flowReceiver: new Int32Array(buf, pReceiver, count),
      cycleBreakCount,
    };
  }

  // ---- биомы ----------------------------------------------------------

  biomeWeights(
    fields: {
      muOcean: Float32Array; muShelf: Float32Array; muLand: Float32Array;
      temperature: Float32Array; moisture: Float32Array; elevation: Float32Array;
      riverInfluence: Float32Array; lakeWeight: Float32Array; deltaWeight: Float32Array;
      slope: Float32Array; mountainWeight: Float32Array; mountainSeamWeight: Float32Array;
      coastExp: Float64Array; volcPow: Float64Array;
    },
    hardLand: Uint8Array, params: Float64Array, count: number,
  ): Float32Array {
    this.resetArena();
    const p0 = this.putF32(fields.muOcean);
    const p1 = this.putF32(fields.muShelf);
    const p2 = this.putF32(fields.muLand);
    const p3 = this.putF32(fields.temperature);
    const p4 = this.putF32(fields.moisture);
    const p5 = this.putF32(fields.elevation);
    const p6 = this.putF32(fields.riverInfluence);
    const p7 = this.putF32(fields.lakeWeight);
    const p8 = this.putF32(fields.deltaWeight);
    const p9 = this.putF32(fields.slope);
    const p10 = this.putF32(fields.mountainWeight);
    const p11 = this.putF32(fields.mountainSeamWeight);
    const p12 = this.putF64(fields.coastExp);
    const p13 = this.putF64(fields.volcPow);
    const pHl = this.putU8(hardLand);
    const pParams = this.putF64(params);
    const pOut = this.alloc(count * 16 * 4);
    this.exports.biomeWeights(p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13,
      pHl, pParams, pOut, count);
    return this.getF32(pOut, count * 16);
  }

  smoothBiomeWeights(
    weights: Float32Array, neighbors: Int32Array, neighborCount: Uint8Array,
    muOcean: Float32Array, muShelf: Float32Array, muLand: Float32Array,
    lakeWeight: Float32Array, hardLand: Uint8Array, alphas: Float64Array, count: number,
  ): Float32Array {
    const { pNb, pNc } = this.putGrid(neighbors, neighborCount);
    const pWeights = this.putF32(weights);
    const pNext = this.alloc(weights.byteLength);
    const pMo = this.putF32(muOcean);
    const pMs = this.putF32(muShelf);
    const pMl = this.putF32(muLand);
    const pLake = this.putF32(lakeWeight);
    const pHl = this.putU8(hardLand);
    const pAlphas = this.putF64(alphas);
    const which = this.exports.smoothBiomeWeights(pWeights, pNext, pNb, pNc, pMo, pMs, pMl,
      pLake, pHl, pAlphas, alphas.length, count);
    return this.getF32(which === 0 ? pWeights : pNext, weights.length);
  }

  biomeWeightsAndSmooth(
    fields: {
      muOcean: Float32Array; muShelf: Float32Array; muLand: Float32Array;
      temperature: Float32Array; moisture: Float32Array; elevation: Float32Array;
      riverInfluence: Float32Array; lakeWeight: Float32Array; deltaWeight: Float32Array;
      slope: Float32Array; mountainWeight: Float32Array; mountainSeamWeight: Float32Array;
      coastExp: Float64Array; volcPow: Float64Array;
    },
    neighbors: Int32Array, neighborCount: Uint8Array,
    hardLand: Uint8Array, params: Float64Array, alphas: Float64Array | null, count: number,
  ): Float32Array {
    const { pNb, pNc } = this.putGrid(neighbors, neighborCount);
    const pMo = this.putF32(fields.muOcean);
    const pMs = this.putF32(fields.muShelf);
    const pMl = this.putF32(fields.muLand);
    const pLake = this.putF32(fields.lakeWeight);
    const pHl = this.putU8(hardLand);
    const pWeights = this.alloc(count * 16 * 4);
    const savedCursor = this.cursor;

    const p3 = this.putF32(fields.temperature);
    const p4 = this.putF32(fields.moisture);
    const p5 = this.putF32(fields.elevation);
    const p6 = this.putF32(fields.riverInfluence);
    const p8 = this.putF32(fields.deltaWeight);
    const p9 = this.putF32(fields.slope);
    const p10 = this.putF32(fields.mountainWeight);
    const p11 = this.putF32(fields.mountainSeamWeight);
    const p12 = this.putF64(fields.coastExp);
    const p13 = this.putF64(fields.volcPow);
    const pParams = this.putF64(params);
    this.exports.biomeWeights(pMo, pMs, pMl, p3, p4, p5, p6, pLake, p8, p9, p10, p11, p12, p13,
      pHl, pParams, pWeights, count);

    if (!alphas || alphas.length === 0) {
      return new Float32Array(this.exports.memory.buffer, pWeights, count * 16);
    }
    this.cursor = savedCursor;
    const pNext = this.alloc(count * 16 * 4);
    const pAlphas = this.putF64(alphas);
    const which = this.exports.smoothBiomeWeights(pWeights, pNext, pNb, pNc, pMo, pMs, pMl,
      pLake, pHl, pAlphas, alphas.length, count);
    return new Float32Array(this.exports.memory.buffer, which === 0 ? pWeights : pNext, count * 16);
  }

  // ---- глобус ----------------------------------------------------------

  globePack(
    centers: Float32Array, cornerCoords: Float32Array, cellCorners: Int32Array,
    cellCornerStart: Int32Array, cellRadius: Float32Array, cornerRadius: Float32Array,
    count: number,
  ): { positions: Float32Array; normals: Int16Array; vertexCount: number } {
    const vertexTotal = count + cellCorners.length;
    this.resetArena();
    const pCenters = this.putF32(centers);
    const pCorners = this.putF32(cornerCoords);
    const pCellCorners = this.putI32(cellCorners);
    const pCellCornerStart = this.putI32(cellCornerStart);
    const pCellRadius = this.putF32(cellRadius);
    const pCornerRadius = this.putF32(cornerRadius);
    const pPositions = this.alloc(vertexTotal * 3 * 4);
    const pNormals = this.alloc(vertexTotal * 4 * 2);
    const vertexCount = this.exports.globePack(pCenters, pCorners, pCellCorners,
      pCellCornerStart, pCellRadius, pCornerRadius, pPositions, pNormals, count);
    return {
      positions: this.getF32(pPositions, vertexTotal * 3),
      normals: this.getI16(pNormals, vertexTotal * 4),
      vertexCount,
    };
  }

  expandVertexColors(
    vertexCellId: Uint32Array, cellColors: Float32Array, centerCount: number,
  ): Uint8Array {
    this.resetArena();
    const pIds = this.putU32(vertexCellId);
    const pColors = this.putF32(cellColors);
    const pOut = this.alloc(vertexCellId.length * 4);
    this.exports.expandVertexColors(pIds, pColors, pOut, centerCount, vertexCellId.length);
    return this.getU8(pOut, vertexCellId.length * 4);
  }
}

// Ленивый синглтон (Stage-8.8.1, A-3): на верхнем уровне модуля НЕТ
// `new PlanetCore()`. Полный Wasm-модуль (~42 КиБ) компилируется синхронно и
// резервирует арену >= 24 МиБ только при первом реальном обращении, то есть в
// воркере (`site/planet-globe/planet-globe-worker.ts`) или в Node-тестах.
// Главный поток при импорте рендерера/географии/поверхности не платит ни
// компиляцией, ни ареной; счётчик `getPlanetCoreCreationCounters().full`
// остаётся 0 (см. `tests/planet-core-boundary.test.mjs`).
// Поведение для существующих вызовов сохранено: возвращается тот же
// единственный экземпляр на всё время жизни модуля.
let sharedPlanetCore: PlanetCore | null = null;

export function getSharedPlanetCore(): PlanetCore {
  if (sharedPlanetCore === null) sharedPlanetCore = new PlanetCore();
  return sharedPlanetCore;
}

/** Уже созданный синглтон или null — без побочного эффекта создания. */
export function peekSharedPlanetCore(): PlanetCore | null {
  return sharedPlanetCore;
}


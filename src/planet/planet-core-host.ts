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
const DIAL_BUCKETS = 16384;
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

  constructor() {
    super(PLANET_CORE_WASM_BASE64, 'PlanetCore');
  }

  // ---- шум/поля -------------------------------------------------------

  sampleFields(
    tables: Uint8Array, params: Float64Array, centers: Float64Array,
  ): { fields: Float32Array; volcPre: Float64Array } {
    const count = centers.length / 3;
    this.resetArena();
    const pTables = this.putU8(tables);
    const pParams = this.putF64(params);
    const pCenters = this.putF64(centers);
    const pOut = this.alloc(count * 6 * 4);
    const pVolc = this.alloc(count * 8);
    this.exports.sampleFieldsBatch(pTables, pParams, pCenters, pOut, pVolc, count);
    return { fields: this.getF32(pOut, count * 6), volcPre: this.getF64(pVolc, count) };
  }

  // ---- сортировки -----------------------------------------------------

  radixOrderF32(values: Float32Array, order: Uint32Array, descending: boolean): Uint32Array {
    this.resetArena();
    const pValues = this.putF32(values);
    const pOrder = this.putU32(order);
    const pTmp = this.alloc(order.length * 4);
    const pCounts = this.alloc(1024);
    this.exports.radixOrderF32(pValues, pOrder, pTmp, pCounts, order.length, descending ? 1 : 0);
    return this.getU32(pOrder, order.length);
  }

  radixOrderF64(values: Float64Array, order: Uint32Array, descending: boolean): Uint32Array {
    this.resetArena();
    const pValues = this.putF64(values);
    const pOrder = this.putU32(order);
    const pTmp = this.alloc(order.length * 4);
    const pCounts = this.alloc(1024);
    this.exports.radixOrderF64(pValues, pOrder, pTmp, pCounts, order.length, descending ? 1 : 0);
    return this.getU32(pOrder, order.length);
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
    const nBlocks = Math.ceil(capEntries / blockSize) + 64;
    const poolEntries = nBlocks * blockSize;
    return {
      meta: this.alloc(DIAL_BUCKETS * 3 * 4),
      poolK: this.alloc(poolEntries * 8),
      poolC: this.alloc(poolEntries * 4),
      poolL: this.alloc(poolEntries * 4),
      blockNext: this.alloc(nBlocks * 4),
      nBlocks,
      sortK: this.alloc(poolEntries * 8),
      sortC: this.alloc(poolEntries * 4),
      sortL: this.alloc(poolEntries * 4),
      sortIdx: this.alloc(poolEntries * 4),
      sortAux: this.alloc(poolEntries * 4),
      cnt: this.alloc(1024),
      sortCap: poolEntries,
    };
  }

  dijkstraTopOne(
    neighbors: Int32Array, neighborCount: Uint8Array, costs: Float32Array,
    seeds: Int32Array, biases: Float64Array, count: number,
  ): Int32Array {
    let cap = 6 * count + seeds.length + 1024;
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
    let cap = 6 * count + seeds.length + 1024;
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

  coastDistance(
    neighbors: Int32Array, neighborCount: Uint8Array, elevation: Float32Array,
    hardLand: Uint8Array, seaLevel: number, count: number,
  ): { dist: Float64Array; boundaryCount: number } {
    let cap = 6 * count + 1024;
    for (;;) {
      this.resetArena();
      const pNb = this.putI32(neighbors);
      const pNc = this.putU8(neighborCount);
      const pEl = this.putF32(elevation);
      const pHl = this.putU8(hardLand);
      const pOut = this.alloc(count * 8);
      const h = this.heapBuffers(cap);
      const rc = this.exports.coastDistance(pNb, pNc, pEl, pHl, seaLevel, count, pOut,
        h.rec, 0, 0, 0, 0, cap);
      if (rc >= 0) return { dist: this.getF64(pOut, count), boundaryCount: rc };
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
    const pMinResidual = this.alloc(candidates.length * 8);
    const selected = this.exports.chooseSeedsKernel(pCand, candidates.length, pCenters, pScore,
      pDesired, desired.length, countWant, meanSpacing, maxScore, pSelected, pMinChord, pMinResidual);
    return this.getI32(pSelected, selected);
  }

  // ---- гидрология -----------------------------------------------------

  priorityFlood(
    neighbors: Int32Array, neighborCount: Uint8Array, elevation: Float32Array,
    hardLand: Uint8Array, count: number,
  ): { filled: Float64Array; parent: Int32Array } {
    let cap = 6 * count + 1024;
    for (;;) {
      this.resetArena();
      const pNb = this.putI32(neighbors);
      const pNc = this.putU8(neighborCount);
      const pEl = this.putF32(elevation);
      const pHl = this.putU8(hardLand);
      const pFilled = this.alloc(count * 8);
      const pParent = this.alloc(count * 4);
      const pSeen = this.alloc(count);
      const h = this.heapBuffers(cap);
      const rc = this.exports.priorityFlood(pNb, pNc, pEl, pHl, count, pFilled, pParent, pSeen,
        h.rec, 0, 0, 0, 0, cap);
      if (rc === 0) {
        return { filled: this.getF64(pFilled, count), parent: this.getI32(pParent, count) };
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
    this.resetArena();
    const pNb = this.putI32(neighbors);
    const pNc = this.putU8(neighborCount);
    const pCenters = this.putF32(centers);
    const pEl = this.putF32(elevation);
    const pFilled = this.putF64(filled);
    const pParent = this.putI32(parent);
    const pHl = this.putU8(hardLand);
    const pRawSlope = this.alloc(count * 8);
    const pSlope = this.alloc(count * 4);
    const pRawReceiver = this.alloc(count * 4);
    const pFilledReceiver = this.alloc(count * 4);
    this.exports.flowReceivers(pNb, pNc, pCenters, pEl, pFilled, pParent, pHl, count,
      pRawSlope, pSlope, pRawReceiver, pFilledReceiver);
    return {
      rawSlope: this.getF64(pRawSlope, count),
      slope: this.getF32(pSlope, count),
      rawReceiver: this.getI32(pRawReceiver, count),
      filledReceiver: this.getI32(pFilledReceiver, count),
    };
  }

  accumulateFlow(
    hardLand: Uint8Array, landCells: Int32Array, flowReceiver: Int32Array,
    localKm2: Float64Array, localCells: Float64Array, filled: Float64Array, count: number,
  ): {
    order: Int32Array; accKm2: Float32Array; accCells: Float32Array;
    flowReceiver: Int32Array; cycleBreakCount: number;
  } {
    this.resetArena();
    const pHl = this.putU8(hardLand);
    const pLand = this.putI32(landCells);
    const pReceiver = this.putI32(flowReceiver);
    const pLocalKm2 = this.putF64(localKm2);
    const pLocalCells = this.putF64(localCells);
    const pFilled = this.putF64(filled);
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
    const orderLen = new Int32Array(this.exports.memory.buffer, pOrderLen, 1)[0] as number;
    return {
      order: this.getI32(pOrder, orderLen),
      accKm2: this.getF32(pAccKm2, count),
      accCells: this.getF32(pAccCells, count),
      flowReceiver: this.getI32(pReceiver, count),
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
    this.resetArena();
    const pWeights = this.putF32(weights);
    const pNext = this.alloc(weights.byteLength);
    const pNb = this.putI32(neighbors);
    const pNc = this.putU8(neighborCount);
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

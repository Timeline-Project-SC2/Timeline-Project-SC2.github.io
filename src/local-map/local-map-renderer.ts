/* LocalMapRenderer — main-thread WebGL2 рендерер локальной карты
   (Этапы 8/9, CR-01 PR 5). Модуль 3 из четырёх распила
   site/shared/temp_code_structures.js (И-5).
   --------------------------------------------------------------------------
   Патч 8 (Этап 8): приём данных воркера переведён на порционную (staged)
   GPU-догрузку. GPU-ресурсы создаются ОДИН раз при инициализации, а данные
   очередного участка заливаются порциями через `gl.bufferSubData` по
   кадровому бюджету времени (по умолчанию 3 мс) — без пересоздания VAO и без
   фризов кадра во время dive-in перехода с глобуса на локальную карту.

   Контракт GPU-ресурсов:
   - terrain VAO: `terrainIdxBuf` (`Uint32Array`, `gl.UNSIGNED_INT`,
     (res - 1)² * 6 индексов) статичен и заливается один раз; `terrainPosBuf`
     и `terrainNormBuf` предвыделены на res² * 3 * 4 байт `DYNAMIC_DRAW` и
     обновляются порциями через `bufferSubData`;
   - VAO модуля: статические позиции/нормали/индексы меша плюс предвыделенный
     instance VBO (MAX_INSTANCES * 32 Б) с атрибутами location 2 и 3
     (`vertexAttribDivisor = 1`), настроенными один раз.

   Шейдеры — local-map-shaders.ts; layout-контракт атрибутов (locations 0…3,
   divisor 1 у инстансов) зафиксирован в обоих модулях. */

// Типы wire-протокола — только import type: value-импорт из модуля воркера
// тащил бы его побочный эффект регистрации onmessage в главный поток.
import {
  STRUCTURE_FRAGMENT_SHADER,
  STRUCTURE_VERTEX_SHADER,
  TERRAIN_FRAGMENT_SHADER,
  TERRAIN_VERTEX_SHADER,
} from './local-map-shaders.ts';
import type { LocalMapWorkerResponse, InstanceBuffers } from './local-map-worker.ts';
import type { MeshData, MeshLibrary } from './local-map-mesh.ts';

/** Хард-кап инстансов на модуль (зеркало контракта воркера: MAX_INSTANCES). */
export const MAX_INSTANCES_PER_MODULE = 4096;
/** Байт на инстанс: 8 float (a_inst_pos_yaw + a_inst_scale_tint). */
export const INSTANCE_STRIDE_BYTES = 32;
/** Размер порции заливки вершин/нормалей/инстансов, байт. */
export const UPLOAD_CHUNK_BYTES = 96 * 1024;
/** Бюджет одной порции staged-догрузки по умолчанию, мс. */
export const DEFAULT_UPLOAD_BUDGET_MS = 3.0;

export interface LocalMapGpuMesh {
  readonly vao: WebGLVertexArrayObject | null;
  readonly indexCount: number;
}

export interface LocalMapInstanceVbo {
  readonly vbo: WebGLBuffer | null;
  count: number;
}

export interface LocalMapVaoStats {
  /** Сколько раз создавался VAO рельефа (контракт Патча 8: ровно 1). */
  terrainVaoCreates: number;
  /** Сколько раз создавались VAO модулей построек. */
  moduleVaoCreates: number;
  /** Число порционных вызовов `gl.bufferSubData`. */
  stagedSubDataCalls: number;
}

export interface LocalMapPrograms {
  readonly terrainProgram: WebGLProgram;
  readonly structureProgram: WebGLProgram;
}

export interface LocalMapRenderOptions {
  readonly lightDir?: readonly [number, number, number];
  readonly ambientColor?: readonly [number, number, number];
  readonly fogColor?: readonly [number, number, number];
  /** Начало кругового тумана в долях radiusM (по умолчанию 0.72). */
  readonly fogStartRatio?: number;
  /** Конец кругового тумана в долях radiusM (по умолчанию 0.98). */
  readonly fogEndRatio?: number;
}

const DEFAULT_LIGHT_DIR: readonly [number, number, number] = [0.42, 0.28, 0.86];
const DEFAULT_AMBIENT: readonly [number, number, number] = [0.32, 0.34, 0.38];
const DEFAULT_FOG_COLOR: readonly [number, number, number] = [0.58, 0.66, 0.74];
const FOG_START_RATIO = 0.72;
const FOG_END_RATIO = 0.98;

/** Стадии staged-догрузки (Патч 8). */
const STAGE_TEXTURES = 0;
const STAGE_POSITIONS = 1;
const STAGE_NORMALS = 2;
const STAGE_INSTANCES = 3;
const STAGE_COUNT = 4;

interface PendingUpload {
  data: LocalMapWorkerResponse;
  /** Размер сетки рельефа payload-а (для позиций/нормалей). */
  readonly res: number;
  stage: number;
  /** Курсор строк сетки на стадиях positions/normals. */
  row: number;
  /** Порядок модулей на стадии instances. */
  moduleIds: string[];
  moduleIndex: number;
  /** Курсор инстансов текущего модуля (в инстансах, не в байтах). */
  moduleInstance: number;
}

interface LocalMapModuleBuffers {
  position: WebGLBuffer | null;
  normal: WebGLBuffer | null;
  index: WebGLBuffer | null;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class StructureRenderer {
  private gl: WebGL2RenderingContext;
  private meshLibrary: Record<string, LocalMapGpuMesh> | null;
  private moduleBuffers: Record<string, LocalMapModuleBuffers>;
  private terrainVAO: WebGLVertexArrayObject | null;
  private terrainPosBuf: WebGLBuffer | null;
  private terrainNormBuf: WebGLBuffer | null;
  private terrainIdxBuf: WebGLBuffer | null;
  private terrainRes: number;
  private terrainIndexCount: number;
  private texZoning: WebGLTexture | null;
  private texTerraform: WebGLTexture | null;
  private instanceVBOs: Record<string, LocalMapInstanceVbo>;
  private pending: PendingUpload | null;
  private scratch: Float32Array;
  private programs: LocalMapPrograms | null;
  private uniformCache: Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>;
  private stats: LocalMapVaoStats;
  /** Бюджет порции по умолчанию (переопределяется enqueueWorkerData). */
  private uploadBudgetMs: number;
  ready: boolean;
  /** Метка размеров последнего принятого payload (hfRes/zoneRes/tfRes/radiusM). */
  meta: LocalMapWorkerResponse['meta'] | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.meshLibrary = null;   // { moduleId: { vao, indexCount } }
    this.moduleBuffers = {};
    this.terrainVAO = null;
    this.terrainPosBuf = null;
    this.terrainNormBuf = null;
    this.terrainIdxBuf = null;
    this.terrainRes = 0;
    this.terrainIndexCount = 0;
    this.texZoning = null;
    this.texTerraform = null;
    this.instanceVBOs = {};    // { moduleId: { vbo, count } }
    this.pending = null;
    this.scratch = new Float32Array(0);
    this.programs = null;
    this.uniformCache = new Map();
    this.stats = { terrainVaoCreates: 0, moduleVaoCreates: 0, stagedSubDataCalls: 0 };
    this.uploadBudgetMs = DEFAULT_UPLOAD_BUDGET_MS;
    this.ready = false;
    this.meta = null;
  }

  // ---- Инициализация библиотеки мешей (один раз при старте) ----
  initMeshLibrary(meshes: MeshLibrary | Readonly<Record<string, MeshData>>): void {
    // meshes = buildMeshLibrary() из local-map-mesh.ts
    const gl = this.gl;
    const library: Record<string, LocalMapGpuMesh> = {};
    const buffers: Record<string, LocalMapModuleBuffers> = {};

    for (const [id, mesh] of Object.entries(meshes)) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      // Positions → location 0
      const posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

      // Normals → location 1
      const normBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

      // Index buffer
      const idxBuf = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

      // Патч 8: instance VBO предвыделен на хард-кап инстансов, атрибуты
      // location 2/3 с divisor = 1 настраиваются здесь ОДИН раз — смена
      // участка обновляет инстансы только через gl.bufferSubData.
      const instVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, instVbo);
      gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES_PER_MODULE * INSTANCE_STRIDE_BYTES, gl.DYNAMIC_DRAW);

      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, INSTANCE_STRIDE_BYTES, 0);
      gl.vertexAttribDivisor(2, 1);

      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, INSTANCE_STRIDE_BYTES, 16);
      gl.vertexAttribDivisor(3, 1);

      gl.bindVertexArray(null);

      library[id] = { vao, indexCount: mesh.indexCount };
      buffers[id] = { position: posBuf, normal: normBuf, index: idxBuf };
      this.instanceVBOs[id] = { vbo: instVbo, count: 0 };
      this.stats.moduleVaoCreates++;
    }
    this.meshLibrary = library;
    this.moduleBuffers = buffers;
  }

  // ---- Патч 8: постановка данных воркера в очередь порционной догрузки ----
  enqueueWorkerData(data: LocalMapWorkerResponse, budgetMs: number = DEFAULT_UPLOAD_BUDGET_MS): void {
    // latest-wins: новый участок вытесняет незавершённую догрузку предыдущего.
    const res = data.meta.hfRes;
    const moduleIds = Object.keys(data.instanceBuffers);
    this.pending = {
      data,
      res,
      stage: STAGE_TEXTURES,
      row: 0,
      moduleIds,
      moduleIndex: 0,
      moduleInstance: 0,
    };
    this.meta = data.meta;
    this.ensureTerrainVao(res);
    // До завершения очередной порции кадр не рисует недогруженный участок.
    this.ready = false;
    // Кадровый бюджет запоминается и применяется в processPendingUpload(),
    // если его вызывают без явного аргумента (цикл рендера страницы).
    if (Number.isFinite(budgetMs) && budgetMs > 0) this.uploadBudgetMs = budgetMs;
  }

  /**
   * Отрабатывает порции staged-догрузки в пределах бюджета.
   * @returns `true`, когда вся загрузка завершена (очередь пуста).
   */
  processPendingUpload(budgetMs: number = this.uploadBudgetMs): boolean {
    if (!this.pending) return true;
    const deadline = Number.isFinite(budgetMs) ? nowMs() + Math.max(0, budgetMs) : Infinity;

    for (;;) {
      const done = this.stepUpload();
      if (done) {
        this.pending = null;
        this.ready = true;
        return true;
      }
      if (nowMs() >= deadline) return false;
    }
  }

  isUploading(): boolean {
    return this.pending !== null;
  }

  /** Прогресс staged-догрузки: 0..1 (1 — всё залито). */
  getUploadProgress(): number {
    const pending = this.pending;
    if (!pending) return this.ready ? 1 : 0;
    const res = pending.res;
    let fraction = 0;
    if (pending.stage === STAGE_POSITIONS) fraction = res > 0 ? pending.row / res : 1;
    else if (pending.stage === STAGE_NORMALS) fraction = res > 0 ? pending.row / res : 1;
    else if (pending.stage === STAGE_INSTANCES) {
      const total = pending.moduleIds.length;
      const moduleFraction = total > 0 ? pending.moduleIndex / total : 1;
      fraction = moduleFraction;
    }
    const value = (pending.stage + fraction) / STAGE_COUNT;
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  getVaoStats(): LocalMapVaoStats {
    return { ...this.stats };
  }

  // ---- Приём данных от Worker (синхронная совместимость) ----
  onWorkerData(data: LocalMapWorkerResponse): void {
    this.enqueueWorkerData(data, Infinity);
    this.processPendingUpload(Infinity);
  }

  // ---- Террейн: VAO и буферы создаются один раз на res (Патч 8) ----
  private ensureTerrainVao(res: number): void {
    const gl = this.gl;
    if (this.terrainVAO && this.terrainRes === res) return;
    if (this.terrainVAO) this.disposeTerrain();

    this.terrainRes = res;
    const quadsPerRow = Math.max(0, res - 1);
    this.terrainIndexCount = quadsPerRow * quadsPerRow * 6;

    // Индексный буфер статичен для сетки res×res: Uint32Array, UNSIGNED_INT.
    const indices = new Uint32Array(this.terrainIndexCount);
    let ptr = 0;
    for (let y = 0; y < quadsPerRow; y++) {
      for (let x = 0; x < quadsPerRow; x++) {
        const tl = y * res + x;
        const tr = tl + 1;
        const bl = tl + res;
        const br = bl + 1;
        indices[ptr++] = tl; indices[ptr++] = bl; indices[ptr++] = tr;
        indices[ptr++] = tr; indices[ptr++] = bl; indices[ptr++] = br;
      }
    }

    const vao = gl.createVertexArray();
    this.terrainVAO = vao;
    gl.bindVertexArray(vao);

    this.terrainPosBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, res * res * 3 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    this.terrainNormBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainNormBuf);
    gl.bufferData(gl.ARRAY_BUFFER, res * res * 3 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    this.terrainIdxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.terrainIdxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    this.stats.terrainVaoCreates++;
  }

  /** Одна порция staged-догрузки. `true` — очередь исчерпана. */
  private stepUpload(): boolean {
    const pending = this.pending;
    if (!pending) return true;
    const gl = this.gl;
    const data = pending.data;
    const meta = data.meta;
    const res = pending.res;

    if (pending.stage === STAGE_TEXTURES) {
      this.uploadTextures(data);
      pending.stage = STAGE_POSITIONS;
      pending.row = 0;
      return false;
    }

    if (pending.stage === STAGE_POSITIONS || pending.stage === STAGE_NORMALS) {
      const rowsPerChunk = Math.max(1, Math.floor(UPLOAD_CHUNK_BYTES / Math.max(1, res * 3 * 4)));
      const from = pending.row;
      const to = Math.min(res, from + rowsPerChunk);
      const floatCount = (to - from) * res * 3;
      if (this.scratch.length < floatCount) this.scratch = new Float32Array(floatCount);
      const lines = to - from;

      if (pending.stage === STAGE_POSITIONS) {
        this.fillPositions(data.heightfield, res, meta.radiusM, from, lines);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainPosBuf);
      } else {
        this.fillNormals(data.heightfield, res, meta.radiusM, from, lines);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainNormBuf);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, from * res * 3 * 4, this.scratch.subarray(0, floatCount));
      this.stats.stagedSubDataCalls++;

      pending.row = to;
      if (pending.row >= res) {
        pending.stage = pending.stage === STAGE_POSITIONS ? STAGE_NORMALS : STAGE_INSTANCES;
        pending.row = 0;
      }
      return false;
    }

    // STAGE_INSTANCES: порционная заливка instance VBO по модулям.
    if (!this.uploadNextInstanceChunk(data.instanceBuffers)) return false;
    return true;
  }

  private uploadTextures(data: LocalMapWorkerResponse): void {
    const gl = this.gl;
    const meta = data.meta;

    if (!this.texZoning) this.texZoning = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texZoning);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RG8UI,
      meta.zoneRes, meta.zoneRes, 0,
      gl.RG_INTEGER, gl.UNSIGNED_BYTE, data.zoneMap,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (!this.texTerraform) this.texTerraform = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texTerraform);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R8,
      meta.tfRes, meta.tfRes, 0,
      gl.RED, gl.UNSIGNED_BYTE, data.terraformMap,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private fillPositions(heightfield: Float32Array, res: number, radiusM: number, from: number, lines: number): void {
    const cellSize = (2 * radiusM) / res;
    const scratch = this.scratch;
    let out = 0;
    for (let y = from; y < from + lines; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        scratch[out++] = (x - res / 2) * cellSize;
        scratch[out++] = (y - res / 2) * cellSize;
        scratch[out++] = heightfield[i] as number;
      }
    }
  }

  private fillNormals(heightfield: Float32Array, res: number, radiusM: number, from: number, lines: number): void {
    const cellSize = (2 * radiusM) / res;
    const scratch = this.scratch;
    let out = 0;
    for (let y = from; y < from + lines; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        const hL = x > 0 ? heightfield[i - 1] as number : heightfield[i] as number;
        const hR = x < res - 1 ? heightfield[i + 1] as number : heightfield[i] as number;
        const hD = y > 0 ? heightfield[i - res] as number : heightfield[i] as number;
        const hU = y < res - 1 ? heightfield[i + res] as number : heightfield[i] as number;
        const nx = (hL - hR) / (2 * cellSize);
        const ny = (hD - hU) / (2 * cellSize);
        const len = Math.hypot(nx, ny, 1.0);
        scratch[out++] = nx / len;
        scratch[out++] = ny / len;
        scratch[out++] = 1.0 / len;
      }
    }
  }

  /**
   * Заливает очередную порцию инстансов. `true` — стадия завершена
   * (все модули обновлены).
   */
  private uploadNextInstanceChunk(instanceBuffers: InstanceBuffers): boolean {
    const gl = this.gl;
    const pending = this.pending;
    if (!pending) return true;
    const chunkInstances = Math.max(1, Math.floor(UPLOAD_CHUNK_BYTES / INSTANCE_STRIDE_BYTES));

    while (pending.moduleIndex < pending.moduleIds.length) {
      const moduleId = pending.moduleIds[pending.moduleIndex] as string;
      const pack = instanceBuffers[moduleId as keyof InstanceBuffers];
      const entry = this.instanceVBOs[moduleId];
      if (!pack || !entry) {
        pending.moduleIndex++;
        pending.moduleInstance = 0;
        continue;
      }
      const total = Math.min(pack.count, MAX_INSTANCES_PER_MODULE);
      entry.count = total;

      if (pending.moduleInstance >= total) {
        pending.moduleIndex++;
        pending.moduleInstance = 0;
        continue;
      }

      const from = pending.moduleInstance;
      const to = Math.min(total, from + chunkInstances);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.vbo);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        from * INSTANCE_STRIDE_BYTES,
        pack.buffer.subarray(from * 8, to * 8),
      );
      this.stats.stagedSubDataCalls++;
      pending.moduleInstance = to;
      return false;
    }

    // Модули, отсутствующие в новом payload, гасим (count = 0).
    for (const [moduleId, entry] of Object.entries(this.instanceVBOs)) {
      if (!instanceBuffers[moduleId as keyof InstanceBuffers]) entry.count = 0;
    }
    return true;
  }

  // ---- Программы шейдеров ----
  compilePrograms(): LocalMapPrograms {
    if (this.programs) return this.programs;
    const terrainProgram = this.linkProgram(TERRAIN_VERTEX_SHADER, TERRAIN_FRAGMENT_SHADER, 'terrain');
    const structureProgram = this.linkProgram(STRUCTURE_VERTEX_SHADER, STRUCTURE_FRAGMENT_SHADER, 'structure');
    this.programs = { terrainProgram, structureProgram };
    return this.programs;
  }

  private compileShader(type: number, source: string, label: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error(`LocalMapRenderer: не удалось создать шейдер ${label}`);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`LocalMapRenderer: ошибка компиляции шейдера ${label}: ${log ?? ''}`);
    }
    return shader;
  }

  private linkProgram(vsSource: string, fsSource: string, label: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource, `${label}.vert`);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource, `${label}.frag`);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error(`LocalMapRenderer: не удалось создать программу ${label}`);
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`LocalMapRenderer: ошибка линковки программы ${label}: ${log ?? ''}`);
    }
    return program;
  }

  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    const gl = this.gl;
    let cache = this.uniformCache.get(program);
    if (!cache) {
      cache = new Map();
      this.uniformCache.set(program, cache);
    }
    if (cache.has(name)) {
      const cached = cache.get(name);
      return cached === undefined ? null : cached;
    }
    const location = gl.getUniformLocation(program, name);
    cache.set(name, location);
    return location;
  }

  // ---- Render Loop ----
  drawTerrain(shaderProgram: WebGLProgram): void {
    if (!this.ready) return;
    const gl = this.gl;

    gl.useProgram(shaderProgram);

    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texZoning);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texTerraform);

    gl.bindVertexArray(this.terrainVAO);
    gl.drawElements(gl.TRIANGLES, this.terrainIndexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  drawStructures(shaderProgram: WebGLProgram): void {
    if (!this.ready) return;
    const gl = this.gl;

    gl.useProgram(shaderProgram);

    for (const [moduleId, inst] of Object.entries(this.instanceVBOs)) {
      if (inst.count === 0) continue;
      const mesh = this.meshLibrary ? this.meshLibrary[moduleId] : null;
      if (!mesh) continue;

      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(
        gl.TRIANGLES,
        mesh.indexCount,
        gl.UNSIGNED_SHORT,     // Меш-индексы — 16-bit (модули маленькие, <100 вершин)
        0,
        inst.count,
      );
    }

    gl.bindVertexArray(null);
  }

  /** Полный кадр локальной карты: юниформы + рельеф + инстансы построек. */
  renderFrame(viewProj: Float32Array, options: LocalMapRenderOptions = {}): void {
    const gl = this.gl;
    const { terrainProgram, structureProgram } = this.compilePrograms();
    const radiusM = this.meta ? this.meta.radiusM : 0;
    const lightDir = options.lightDir ?? DEFAULT_LIGHT_DIR;
    const ambient = options.ambientColor ?? DEFAULT_AMBIENT;
    const fogColor = options.fogColor ?? DEFAULT_FOG_COLOR;
    const fogStart = radiusM * (options.fogStartRatio ?? FOG_START_RATIO);
    const fogEnd = radiusM * (options.fogEndRatio ?? FOG_END_RATIO);
    const terrainSize = 2 * radiusM;

    gl.useProgram(terrainProgram);
    gl.uniformMatrix4fv(this.uniform(terrainProgram, 'u_viewProj'), false, viewProj);
    gl.uniform1f(this.uniform(terrainProgram, 'u_terrainSize'), terrainSize);
    gl.uniform3fv(this.uniform(terrainProgram, 'u_lightDir'), lightDir);
    gl.uniform3fv(this.uniform(terrainProgram, 'u_ambientColor'), ambient);
    gl.uniform3fv(this.uniform(terrainProgram, 'u_fogColor'), fogColor);
    gl.uniform1f(this.uniform(terrainProgram, 'u_fogStart'), fogStart);
    gl.uniform1f(this.uniform(terrainProgram, 'u_fogEnd'), fogEnd);
    gl.uniform1i(this.uniform(terrainProgram, 'u_zoning_map'), 0);
    gl.uniform1i(this.uniform(terrainProgram, 'u_terraform_map'), 1);
    this.drawTerrain(terrainProgram);

    gl.useProgram(structureProgram);
    gl.uniformMatrix4fv(this.uniform(structureProgram, 'u_viewProj'), false, viewProj);
    gl.uniform3fv(this.uniform(structureProgram, 'u_lightDir'), lightDir);
    gl.uniform3fv(this.uniform(structureProgram, 'u_ambientColor'), ambient);
    gl.uniform3fv(this.uniform(structureProgram, 'u_fogColor'), fogColor);
    gl.uniform1f(this.uniform(structureProgram, 'u_fogStart'), fogStart);
    gl.uniform1f(this.uniform(structureProgram, 'u_fogEnd'), fogEnd);
    this.drawStructures(structureProgram);
  }

  // ---- Освобождение GPU-ресурсов ----
  dispose(): void {
    const gl = this.gl;
    this.disposeTerrain();

    for (const [moduleId, entry] of Object.entries(this.instanceVBOs)) {
      if (entry.vbo) gl.deleteBuffer(entry.vbo);
      this.instanceVBOs[moduleId] = { vbo: null, count: 0 };
    }
    this.instanceVBOs = {};

    for (const mesh of Object.values(this.meshLibrary ?? {})) {
      if (mesh.vao) gl.deleteVertexArray(mesh.vao);
    }
    for (const buffers of Object.values(this.moduleBuffers)) {
      if (buffers.position) gl.deleteBuffer(buffers.position);
      if (buffers.normal) gl.deleteBuffer(buffers.normal);
      if (buffers.index) gl.deleteBuffer(buffers.index);
    }
    this.meshLibrary = null;
    this.moduleBuffers = {};

    if (this.texZoning) gl.deleteTexture(this.texZoning);
    if (this.texTerraform) gl.deleteTexture(this.texTerraform);
    this.texZoning = null;
    this.texTerraform = null;

    if (this.programs) {
      gl.deleteProgram(this.programs.terrainProgram);
      gl.deleteProgram(this.programs.structureProgram);
      this.programs = null;
    }
    this.uniformCache.clear();

    this.pending = null;
    this.meta = null;
    this.ready = false;
  }

  private disposeTerrain(): void {
    const gl = this.gl;
    if (this.terrainPosBuf) gl.deleteBuffer(this.terrainPosBuf);
    if (this.terrainNormBuf) gl.deleteBuffer(this.terrainNormBuf);
    if (this.terrainIdxBuf) gl.deleteBuffer(this.terrainIdxBuf);
    if (this.terrainVAO) gl.deleteVertexArray(this.terrainVAO);
    this.terrainPosBuf = null;
    this.terrainNormBuf = null;
    this.terrainIdxBuf = null;
    this.terrainVAO = null;
    this.terrainRes = 0;
    this.terrainIndexCount = 0;
  }
}

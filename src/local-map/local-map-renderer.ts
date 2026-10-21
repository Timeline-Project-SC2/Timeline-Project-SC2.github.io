/* LocalMapRenderer — main-thread WebGL2 рендерер локальной карты
   (Этапы 8/9, CR-01 PR 5). Модуль 3 из четырёх распила
   site/shared/temp_code_structures.js (И-5).
   --------------------------------------------------------------------------
   Приём данных worker, создание GPU-ресурсов (VAO рельефа на gl.UNSIGNED_INT,
   instance VBOs на 32 байта, текстуры RG8UI и R8), drawTerrain и
   drawStructures. Шейдеры — local-map-shaders.ts; layout-контракт атрибутов
   (locations 0…3, divisor 1 у инстансов) зафиксирован в обоих модулях. */

// Типы wire-протокола — только import type: value-импорт из модуля воркера
// тащил бы его побочный эффект регистрации onmessage в главный поток.
import type { LocalMapWorkerResponse, InstanceBuffers } from './local-map-worker.ts';
import type { MeshData, MeshLibrary } from './local-map-mesh.ts';

export interface LocalMapGpuMesh {
  readonly vao: WebGLVertexArrayObject | null;
  readonly indexCount: number;
}

export interface LocalMapInstanceVbo {
  readonly vbo: WebGLBuffer | null;
  count: number;
}

export class StructureRenderer {
  private gl: WebGL2RenderingContext;
  private meshLibrary: Partial<Record<string, LocalMapGpuMesh>> | null;
  private terrainVAO: WebGLVertexArrayObject | null;
  private terrainIndexCount: number;
  private texZoning: WebGLTexture | null;
  private texTerraform: WebGLTexture | null;
  private instanceVBOs: Record<string, LocalMapInstanceVbo>;
  ready: boolean;
  /** Метка размеров последнего принятого payload (hfRes/zoneRes/tfRes/radiusM). */
  meta: LocalMapWorkerResponse['meta'] | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.meshLibrary = null;   // { moduleId: { vao, indexCount } }
    this.terrainVAO = null;
    this.terrainIndexCount = 0;
    this.texZoning = null;
    this.texTerraform = null;
    this.instanceVBOs = {};    // { moduleId: { vbo, count } }
    this.ready = false;
    this.meta = null;
  }

  // ---- Инициализация библиотеки мешей (один раз при старте) ----
  initMeshLibrary(meshes: MeshLibrary | Readonly<Record<string, MeshData>>): void {
    // meshes = buildMeshLibrary() из local-map-mesh.ts
    const gl = this.gl;
    const library: Record<string, LocalMapGpuMesh> = {};

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

      gl.bindVertexArray(null);

      library[id] = { vao, indexCount: mesh.indexCount };
    }
    this.meshLibrary = library;
  }

  // ---- Приём данных от Worker ----
  onWorkerData(data: LocalMapWorkerResponse): void {
    const gl = this.gl;
    const { heightfield, zoneMap, terraformMap, instanceBuffers, meta } = data;
    this.meta = meta;

    // --- Текстура t_zoning (RG8UI, NEAREST) ---
    if (!this.texZoning) this.texZoning = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texZoning);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RG8UI,
      meta.zoneRes, meta.zoneRes, 0,
      gl.RG_INTEGER, gl.UNSIGNED_BYTE, zoneMap,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // --- Текстура t_terraform (R8, LINEAR) ---
    if (!this.texTerraform) this.texTerraform = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texTerraform);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R8,
      meta.tfRes, meta.tfRes, 0,
      gl.RED, gl.UNSIGNED_BYTE, terraformMap,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // --- Terrain Mesh (256×256 plane, indexed GL_TRIANGLES, UINT32 indices) ---
    this.buildTerrainMesh(heightfield, meta);

    // --- Instance VBOs (per module type) ---
    this.uploadInstances(instanceBuffers);

    this.ready = true;
  }

  private buildTerrainMesh(heightfield: Float32Array, meta: LocalMapWorkerResponse['meta']): void {
    const gl = this.gl;
    const res = meta.hfRes;                           // 256
    const cellSize = (2 * meta.radiusM) / res;

    // Positions (x, y, z)
    const positions = new Float32Array(res * res * 3);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        positions[i * 3] = (x - res / 2) * cellSize;   // world X
        positions[i * 3 + 1] = (y - res / 2) * cellSize;   // world Y
        positions[i * 3 + 2] = heightfield[i] as number;   // world Z
      }
    }

    // Indices (UNSIGNED_INT — контракт, 256×256 = 65536 вершин)
    const quadsPerRow = res - 1;
    const indexCount = quadsPerRow * quadsPerRow * 6;
    const indices = new Uint32Array(indexCount);
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
    this.terrainIndexCount = indexCount;

    // Нормали (finite differences)
    const normals = new Float32Array(res * res * 3);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        const hL = x > 0 ? heightfield[i - 1] as number : heightfield[i] as number;
        const hR = x < res - 1 ? heightfield[i + 1] as number : heightfield[i] as number;
        const hD = y > 0 ? heightfield[i - res] as number : heightfield[i] as number;
        const hU = y < res - 1 ? heightfield[i + res] as number : heightfield[i] as number;
        // Tangent vectors → cross product
        const nx = (hL - hR) / (2 * cellSize);
        const ny = (hD - hU) / (2 * cellSize);
        const nz = 1.0;
        const len = Math.hypot(nx, ny, nz);
        normals[i * 3] = nx / len;
        normals[i * 3 + 1] = ny / len;
        normals[i * 3 + 2] = nz / len;
      }
    }

    // VAO
    if (!this.terrainVAO) this.terrainVAO = gl.createVertexArray();
    gl.bindVertexArray(this.terrainVAO);

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const normBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
  }

  private uploadInstances(instanceBuffers: InstanceBuffers): void {
    const gl = this.gl;

    for (const [moduleId, pack] of Object.entries(instanceBuffers)) {
      const entry = this.meshLibrary ? this.meshLibrary[moduleId] : null;
      if (!entry || !pack) continue;

      // Создаём или обновляем instance VBO
      if (!this.instanceVBOs[moduleId]) {
        this.instanceVBOs[moduleId] = { vbo: gl.createBuffer(), count: 0 };
      }

      const inst = this.instanceVBOs[moduleId] as LocalMapInstanceVbo;
      inst.count = pack.count;

      // Привязываем instance-атрибуты к VAO модуля
      gl.bindVertexArray(entry.vao);

      gl.bindBuffer(gl.ARRAY_BUFFER, inst.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, pack.buffer, gl.DYNAMIC_DRAW);

      const stride = 32;  // 8 float × 4 bytes

      // a_inst_pos_yaw → location 2
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(2, 1);

      // a_inst_scale_tint → location 3
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 16);
      gl.vertexAttribDivisor(3, 1);

      gl.bindVertexArray(null);
    }
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
}

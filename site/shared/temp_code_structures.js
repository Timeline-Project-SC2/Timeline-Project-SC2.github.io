/* ============================================================================
 * TEMP_CODE: 3D Urban & Industrial Structures on Local Map (Этап 8 / 9)
 * ----------------------------------------------------------------------------
 * Файл временной сборки для последующей интеграции в проект:
 *   - site/shared/local-map-mesh.js       (Модуль 1: Библиотека базовых мешей)
 *   - site/shared/local-map-worker.js     (Модуль 2: Worker-генератор)
 *   - site/shared/local-map-renderer.js   (Модуль 3: WebGL2 Main Thread рендерер)
 *   - shaders: structure.vert/frag, terrain.vert/frag (Модуль 4: Шейдеры)
 *
 * Архитектурный базис (LOCKED CONTRACT):
 * 1. Worker (CPU) — единственный источник истины: генерирует heightfield,
 *    zone_map (Uint8Array RG), terraform_map (Uint8Array R) и scatter-инстансы.
 * 2. Текстуры на GPU:
 *    - t_zoning: gl.RG8UI, usampler2D, строго GL_NEAREST (R: enum зоны, G: плотность).
 *    - t_terraform: gl.R8, sampler2D, GL_LINEAR (R: falloff альфа 0..1).
 * 3. Рельеф: h_smoothed через 2-проходный BoxBlur(heightfield),
 *    h_final = mix(h_natural, h_smoothed, terraform_map).
 * 4. Сетка ландшафта 256x256 вершин: индексный буфер gl.UNSIGNED_INT (65536 вершин).
 * 5. Scatter инстансов: Jittered Grid с отбраковкой, Hard-Cap 4096 инстансов
 *    (отсечение от периферии к центру базы).
 * 6. Instance layout: 32 байта (8 float) на инстанс:
 *    - a_inst_pos_yaw: vec4(x, y, z, yaw)
 *    - a_inst_scale_tint: vec4(sx, sy, sz, packed_tint)
 * 7. Packed tint: uintBitsToFloat(r | g<<8 | b<<16 | a<<24).
 * ============================================================================
 */


/* ============================================================================
 * >>> ПРИНАДЛЕЖНОСТЬ: МОДУЛЬ 1: БИБЛИОТЕКА БАЗОВЫХ МЕШЕЙ (site/shared/local-map-mesh.js)
 * >>> НАЗНАЧЕНИЕ: Параметрические Low-Poly меши модулей (box, cylinder, dome, wedge, tower) и фабрика buildMeshLibrary().
 * ============================================================================
 */

// ============================================================
//  meshLibrary.js — Параметрические Low-Poly модули
//  Каждый модуль: { positions: Float32Array, normals: Float32Array,
//                   indices: Uint16Array, vertexCount, indexCount }
//  Все модули нормализованы: footprint ~1×1, высота ~1 (масштаб задаёт инстанс).
// ============================================================

export function createBoxMesh(wx = 1, wy = 1, hz = 1) {
  // Параллелепипед с 24 вершинами (уникальные нормали на грань)
  const p = wx / 2, q = wy / 2;
  // prettier-ignore
  const positions = new Float32Array([
    // Front face (Z+)
    -p, -q, 0,   p, -q, 0,   p, q, 0,   -p, q, 0,
    // Back face (Z-)  — не нужна, основание лежит на земле (отбрасываем)
    // Впрочем оставим для корректных теней при будущем shadow pass
    -p, -q, hz,  p, -q, hz,  p, q, hz,  -p, q, hz,
    // Right (+X)
     p, -q, 0,   p, -q, hz,  p, q, hz,   p, q, 0,
    // Left (-X)
    -p, -q, hz, -p, -q, 0,  -p, q, 0,  -p, q, hz,
    // Top (+Z)
    -p, -q, hz,  p, -q, hz,  p, q, hz,  -p, q, hz,
    // Bottom (-Z)
    -p, -q, 0,  -p, q, 0,    p, q, 0,    p, -q, 0,
  ]);

  // prettier-ignore
  const normals = new Float32Array([
     0, 0,-1,  0, 0,-1,  0, 0,-1,  0, 0,-1,  // Front  (в сторону земли — не ошибка, см. ниже)
     0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,  // Back   (верх)
     1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,  // Right
    -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,  // Left
     0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,  // Top
     0, 0,-1,  0, 0,-1,  0, 0,-1,  0, 0,-1,  // Bottom
  ]);

  // prettier-ignore
  const indices = new Uint16Array([
     0, 1, 2,  0, 2, 3,    // front
     4, 5, 6,  4, 6, 7,    // back
     8, 9,10,  8,10,11,    // right
    12,13,14, 12,14,15,    // left
    16,17,18, 16,18,19,    // top
    20,21,22, 20,22,23,    // bottom
  ]);

  return { positions, normals, indices, vertexCount: 24, indexCount: 36 };
}


export function createCylinderMesh(radius = 0.5, height = 1, segments = 12) {
  // Цистерна / силос. Без нижнего диска (стоит на земле).
  const verts = [];
  const norms = [];
  const idx   = [];

  // --- Боковая поверхность ---
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const cs = Math.cos(a), sn = Math.sin(a);
    // Нижнее кольцо
    verts.push(cs * radius, sn * radius, 0);
    norms.push(cs, sn, 0);
    // Верхнее кольцо
    verts.push(cs * radius, sn * radius, height);
    norms.push(cs, sn, 0);
  }
  for (let i = 0; i < segments; i++) {
    const b = i * 2;
    idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
  }

  // --- Верхний диск ---
  const topCenterIdx = verts.length / 3;
  verts.push(0, 0, height);
  norms.push(0, 0, 1);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    verts.push(Math.cos(a) * radius, Math.sin(a) * radius, height);
    norms.push(0, 0, 1);
  }
  for (let i = 0; i < segments; i++) {
    idx.push(topCenterIdx, topCenterIdx + 1 + i, topCenterIdx + 2 + i);
  }

  return {
    positions:   new Float32Array(verts),
    normals:     new Float32Array(norms),
    indices:     new Uint16Array(idx),
    vertexCount: verts.length / 3,
    indexCount:  idx.length,
  };
}


export function createDomeMesh(radius = 0.5, height = 0.6, rings = 6, segments = 12) {
  // Полусфера / купол (научная станция, радар)
  const verts = [];
  const norms = [];
  const idx   = [];

  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * (Math.PI / 2);     // 0 … π/2
    const rr  = Math.cos(phi) * radius;
    const zz  = Math.sin(phi) * height;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const x = Math.cos(theta) * rr;
      const y = Math.sin(theta) * rr;
      verts.push(x, y, zz);
      // Нормаль — нормализованная позиция (для полусферы)
      const len = Math.hypot(x, y, zz) || 1;
      norms.push(x / len, y / len, zz / len);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const cur  = r * (segments + 1) + s;
      const next = cur + segments + 1;
      idx.push(cur, next, cur + 1);
      idx.push(cur + 1, next, next + 1);
    }
  }

  return {
    positions:   new Float32Array(verts),
    normals:     new Float32Array(norms),
    indices:     new Uint16Array(idx),
    vertexCount: verts.length / 3,
    indexCount:  idx.length,
  };
}


export function createWedgeMesh(wx = 1, wy = 1, hFront = 1, hBack = 0.6) {
  // Скошенная крыша / ангар. Основание wx × wy, передняя стена hFront, задняя hBack.
  const p = wx / 2, q = wy / 2;
  // prettier-ignore
  const positions = new Float32Array([
    // Front face (+Y)
    -p, q, 0,   p, q, 0,   p, q, hFront,  -p, q, hFront,
    // Back face (-Y)
    -p,-q, 0,  -p,-q, hBack,  p,-q, hBack,  p,-q, 0,
    // Left  (-X)
    -p,-q, 0,  -p, q, 0,  -p, q, hFront,  -p,-q, hBack,
    // Right (+X)
     p,-q, 0,   p,-q, hBack,   p, q, hFront,   p, q, 0,
    // Roof (sloped quad)
    -p,-q, hBack,  -p, q, hFront,   p, q, hFront,   p,-q, hBack,
    // Bottom
    -p,-q, 0,   p,-q, 0,   p, q, 0,  -p, q, 0,
  ]);

  // Нормали для наклонной крыши
  const roofDz = hFront - hBack;
  const roofDy = wy;
  const roofLen = Math.hypot(roofDz, roofDy);
  const rnY = -roofDz / roofLen;
  const rnZ =  roofDy / roofLen;

  // prettier-ignore
  const normals = new Float32Array([
     0, 1, 0,   0, 1, 0,   0, 1, 0,   0, 1, 0,
     0,-1, 0,   0,-1, 0,   0,-1, 0,   0,-1, 0,
    -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
     1, 0, 0,   1, 0, 0,   1, 0, 0,   1, 0, 0,
     0, rnY, rnZ,  0, rnY, rnZ,  0, rnY, rnZ,  0, rnY, rnZ,
     0, 0,-1,   0, 0,-1,   0, 0,-1,   0, 0,-1,
  ]);

  // prettier-ignore
  const indices = new Uint16Array([
     0, 1, 2,  0, 2, 3,
     4, 5, 6,  4, 6, 7,
     8, 9,10,  8,10,11,
    12,13,14, 12,14,15,
    16,17,18, 16,18,19,
    20,21,22, 20,22,23,
  ]);

  return { positions, normals, indices, vertexCount: 24, indexCount: 36 };
}


export function createTowerMesh(baseRadius = 0.3, topRadius = 0.15, height = 1, segments = 8) {
  // Усечённый конус — вышка, башня, опора
  const verts = [];
  const norms = [];
  const idx   = [];

  const slope = Math.atan2(baseRadius - topRadius, height);
  const nz    = Math.sin(slope);
  const nr    = Math.cos(slope);

  for (let i = 0; i <= segments; i++) {
    const a  = (i / segments) * Math.PI * 2;
    const cs = Math.cos(a), sn = Math.sin(a);
    // Bottom
    verts.push(cs * baseRadius, sn * baseRadius, 0);
    norms.push(cs * nr, sn * nr, nz);
    // Top
    verts.push(cs * topRadius, sn * topRadius, height);
    norms.push(cs * nr, sn * nr, nz);
  }
  for (let i = 0; i < segments; i++) {
    const b = i * 2;
    idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
  }

  // Top cap
  const ci = verts.length / 3;
  verts.push(0, 0, height);
  norms.push(0, 0, 1);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    verts.push(Math.cos(a) * topRadius, Math.sin(a) * topRadius, height);
    norms.push(0, 0, 1);
  }
  for (let i = 0; i < segments; i++) {
    idx.push(ci, ci + 1 + i, ci + 2 + i);
  }

  return {
    positions:   new Float32Array(verts),
    normals:     new Float32Array(norms),
    indices:     new Uint16Array(idx),
    vertexCount: verts.length / 3,
    indexCount:  idx.length,
  };
}


// ============================================================
//  Фабрика: привязка к Module IDs из ZONE_MODULES
// ============================================================
const MESH_BUILDERS = {
  hab_box:     () => createBoxMesh(1, 1, 1),
  container:   () => createBoxMesh(1.2, 0.5, 0.5),
  comm_mast:   () => createTowerMesh(0.1, 0.05, 1, 6),
  factory:     () => createWedgeMesh(1.4, 1, 1, 0.65),
  silo_tank:   () => createCylinderMesh(0.5, 1, 12),
  pipe_stack:  () => createCylinderMesh(0.15, 1, 8),
  cargo_bay:   () => createBoxMesh(1.3, 0.8, 0.7),
  guard_tower: () => createTowerMesh(0.35, 0.2, 1, 6),
  barrier:     () => createBoxMesh(1.5, 0.3, 0.5),
  radar_dish:  () => createDomeMesh(0.4, 0.3, 5, 10),
  hq_center:   () => createBoxMesh(1.5, 1.5, 1),
  dome_vault:  () => createDomeMesh(0.7, 0.5, 6, 12),
};

export function buildMeshLibrary() {
  const library = {};
  for (const [id, builder] of Object.entries(MESH_BUILDERS)) {
    library[id] = builder();
  }
  return library;
}


/* ============================================================================
 * >>> ПРИНАДЛЕЖНОСТЬ: МОДУЛЬ 2: WORKER-ГЕНЕРАТОР (site/shared/local-map-worker.js)
 * >>> НАЗНАЧЕНИЕ: Ядро генерации: fBm terrain, lowpass blur, mix терраформинга, jittered scatter инстансов, упаковка transferable buffers.
 * ============================================================================
 */

// ============================================================
//  structureWorker.js — Web Worker: генерация terrain + scatter
//  Получает: { seed, placeId, radiusM, centerLat, centerLon }
//  Отдаёт:   { heightfield, zoneMap, terraformMap, instances }
//  Все — Transferable (zero-copy).
// ============================================================

// ---- Константы контракта ----
const HEIGHTFIELD_RES = 256;
const ZONE_RES        = 64;
const TERRAFORM_RES   = 256;
const MAX_INSTANCES   = 4096;

// ---- Детерминированный хэш (pcg-подобный) ----
function pcgHash(state) {
  // PCG-XSH-RR: один раунд
  state = state >>> 0;
  state = (Math.imul(state, 747796405) + 2891336453) >>> 0;
  const word = ((state >>> ((state >>> 28) + 4)) ^ state) * 277803737;
  return ((word >>> 22) ^ word) >>> 0;
}

function hash2(ix, iy, seed) {
  // 2D → uint32
  return pcgHash(pcgHash(ix + seed * 198491317) ^ (iy * 6542989));
}

function hashFloat(ix, iy, seed) {
  // 2D → [0, 1)
  return (hash2(ix, iy, seed) >>> 0) / 4294967296;
}

function hashFloat2(ix, iy, seed) {
  // Два независимых [0,1)
  const h1 = hashFloat(ix, iy, seed);
  const h2 = hashFloat(ix, iy, seed ^ 0x9E3779B9);
  return [h1, h2];
}


// ---- fBm (Simplex-шум, 6 октав) ----
// Для краткости — простой value noise с хешем. В продакшене заменить на Simplex.
function valueNoise2D(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  // smoothstep
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hashFloat(ix,     iy,     seed);
  const b = hashFloat(ix + 1, iy,     seed);
  const c = hashFloat(ix,     iy + 1, seed);
  const d = hashFloat(ix + 1, iy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fBm(x, y, seed, octaves = 6, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    sum    += valueNoise2D(x * freq, y * freq, seed + i * 7919) * amp;
    maxAmp += amp;
    amp    *= gain;
    freq   *= lacunarity;
  }
  return sum / maxAmp;   // нормализовано в [0, 1]
}


// ---- Box Blur (separable, 2 прохода) ----
function boxBlurSeparable(src, w, h, kernelRadius) {
  const dst = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  const k   = kernelRadius;
  const d   = 2 * k + 1;

  // Горизонтальный проход
  for (let row = 0; row < h; row++) {
    let sum = 0;
    // Инициализация окна для первого пикселя строки
    for (let dx = -k; dx <= k; dx++) {
      sum += src[row * w + Math.max(0, Math.min(dx, w - 1))];
    }
    tmp[row * w] = sum / d;
    for (let col = 1; col < w; col++) {
      const addIdx = Math.min(col + k, w - 1);
      const remIdx = Math.max(col - k - 1, 0);
      sum += src[row * w + addIdx] - src[row * w + remIdx];
      tmp[row * w + col] = sum / d;
    }
  }

  // Вертикальный проход
  for (let col = 0; col < w; col++) {
    let sum = 0;
    for (let dy = -k; dy <= k; dy++) {
      sum += tmp[Math.max(0, Math.min(dy, h - 1)) * w + col];
    }
    dst[col] = sum / d;
    for (let row = 1; row < h; row++) {
      const addIdx = Math.min(row + k, h - 1);
      const remIdx = Math.max(row - k - 1, 0);
      sum += tmp[addIdx * w + col] - tmp[remIdx * w + col];
      dst[row * w + col] = sum / d;
    }
  }

  return dst;
}


// ---- Генерация текстурных карт (CPU) ----
function generateZoneMap(seed, placeId, radiusM) {
  // Простейшая радиальная зонация: ядро → пром → жилой → периметр → пустошь
  const map = new Uint8Array(ZONE_RES * ZONE_RES * 2); // RG
  const cx  = ZONE_RES / 2, cy = ZONE_RES / 2;
  const maxR = ZONE_RES / 2;
  const baseSeed = seed ^ (placeId * 48611);

  for (let y = 0; y < ZONE_RES; y++) {
    for (let x = 0; x < ZONE_RES; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) / maxR;  // 0..1+
      const noise = hashFloat(x, y, baseSeed) * 0.15;    // jitter зон

      let zone, density;
      const d = dist + noise;

      if (d > 0.95) {
        zone = 0; density = 0;                            // Пустошь
      } else if (d > 0.70) {
        zone = 3; density = Math.floor((1 - d) * 400);    // Периметр
      } else if (d > 0.35) {
        zone = 1; density = Math.floor((1 - d) * 300);    // Лёгкая застройка
      } else if (d > 0.12) {
        zone = 2; density = Math.floor((1 - d) * 350);    // Пром
      } else {
        zone = 4; density = Math.floor(200 + hashFloat(x, y, baseSeed + 1) * 55); // Ядро
      }

      const idx = (y * ZONE_RES + x) * 2;
      map[idx]     = zone;
      map[idx + 1] = Math.min(255, Math.max(0, density));
    }
  }
  return map;
}


function generateTerraformMap(seed, placeId) {
  // Gaussian falloff от центра
  const map = new Uint8Array(TERRAFORM_RES * TERRAFORM_RES);
  const cx  = TERRAFORM_RES / 2, cy = TERRAFORM_RES / 2;
  const sigma = TERRAFORM_RES * 0.3;

  for (let y = 0; y < TERRAFORM_RES; y++) {
    for (let x = 0; x < TERRAFORM_RES; x++) {
      const dx = x - cx, dy = y - cy;
      const r2 = dx * dx + dy * dy;
      const alpha = Math.exp(-r2 / (2 * sigma * sigma));
      map[y * TERRAFORM_RES + x] = Math.floor(alpha * 255);
    }
  }
  return map;
}


// ---- ZONE_MODULES (зеркало контракта) ----
const ZONE_MODULES = {
  1: [
    { id: 'hab_box',   weight: 0.50, scale: [0.8, 1.2], hScale: [0.8, 1.3] },
    { id: 'container', weight: 0.35, scale: [0.6, 1.0], hScale: [0.5, 1.0] },
    { id: 'comm_mast', weight: 0.15, scale: [0.9, 1.1], hScale: [1.2, 2.0] },
  ],
  2: [
    { id: 'factory',    weight: 0.40, scale: [1.2, 1.8], hScale: [1.0, 1.5] },
    { id: 'silo_tank',  weight: 0.30, scale: [0.9, 1.3], hScale: [1.0, 1.8] },
    { id: 'pipe_stack', weight: 0.20, scale: [1.0, 1.5], hScale: [1.5, 2.5] },
    { id: 'cargo_bay',  weight: 0.10, scale: [1.0, 1.4], hScale: [0.8, 1.2] },
  ],
  3: [
    { id: 'guard_tower', weight: 0.50, scale: [0.9, 1.2], hScale: [1.4, 2.2] },
    { id: 'barrier',     weight: 0.35, scale: [1.0, 1.5], hScale: [0.6, 1.0] },
    { id: 'radar_dish',  weight: 0.15, scale: [1.0, 1.3], hScale: [1.2, 1.8] },
  ],
  4: [
    { id: 'hq_center',  weight: 0.60, scale: [1.5, 2.2], hScale: [1.2, 1.8] },
    { id: 'dome_vault', weight: 0.40, scale: [1.2, 1.7], hScale: [1.0, 1.5] },
  ],
};

// Предвычисляем CDF для weighted random
const ZONE_CDF = {};
for (const [zone, modules] of Object.entries(ZONE_MODULES)) {
  let cumul = 0;
  ZONE_CDF[zone] = modules.map(m => { cumul += m.weight; return cumul; });
}


function pickModule(zone, rand01) {
  const cdf     = ZONE_CDF[zone];
  const modules = ZONE_MODULES[zone];
  for (let i = 0; i < cdf.length; i++) {
    if (rand01 < cdf[i]) return modules[i];
  }
  return modules[modules.length - 1];
}


function lerp(a, b, t) { return a + (b - a) * t; }

function packTint(r, g, b, a) {
  const u32 = ((r & 0xFF) | ((g & 0xFF) << 8) | ((b & 0xFF) << 16) | ((a & 0xFF) << 24)) >>> 0;
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = u32;
  return new Float32Array(buf)[0];
}


// ---- ПАЛИТРЫ ОТТЕНКОВ ----
const TINT_PALETTES = {
  1: [ [180,180,190], [160,155,140], [140,150,160] ],   // серо-стальной, песочный
  2: [ [200,120, 50], [180,160,100], [150,150,150] ],   // индустриальный оранж
  3: [ [100,110,100], [120,120, 80], [ 90,100, 90] ],   // камуфляж / тёмный
  4: [ [200,200,210], [170,190,220], [220,220,230] ],   // светлый штаб
};


// ---- Scatter Engine ----
function scatterInstances(zoneMap, heightfield, radiusM, seed, placeId) {
  const instances = [];                                 // будет max 4096
  const hfRes = HEIGHTFIELD_RES;
  const zRes  = ZONE_RES;
  const cellWorldSize = (2 * radiusM) / hfRes;         // метры на ячейку heightfield
  const baseSeed = seed ^ (placeId * 91939);

  // Jittered Grid: шаг зависит от зоны, но для простоты — фиксированный шаг
  // и фильтрация по density
  const GRID_STEP = 4;                                  // в ячейках heightfield (≈ 4 * cellWorldSize метров)

  // Пройдём по grid
  for (let gy = 0; gy < hfRes; gy += GRID_STEP) {
    for (let gx = 0; gx < hfRes; gx += GRID_STEP) {
      if (instances.length >= MAX_INSTANCES) break;

      // Jitter
      const [jx, jy] = hashFloat2(gx, gy, baseSeed);
      const px = gx + jx * GRID_STEP * 0.8;
      const py = gy + jy * GRID_STEP * 0.8;

      const pxi = Math.floor(px), pyi = Math.floor(py);
      if (pxi < 0 || pxi >= hfRes || pyi < 0 || pyi >= hfRes) continue;

      // Сэмплируем зону (64×64 → перемасштабируем координаты)
      const zx = Math.floor((px / hfRes) * zRes);
      const zy = Math.floor((py / hfRes) * zRes);
      const zIdx = (zy * zRes + zx) * 2;
      const zone    = zoneMap[zIdx];
      const density = zoneMap[zIdx + 1];

      if (zone === 0 || !ZONE_MODULES[zone]) continue;  // пустошь — пропуск

      // Проверка плотности
      const spawnRoll = hashFloat(gx + 1, gy + 1, baseSeed + 3);
      if (spawnRoll > density / 255) continue;

      // Inset: проверяем соседние ячейки зоны на смену зоны
      let onBorder = false;
      for (const [dx2, dy2] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nzx = zx + dx2, nzy = zy + dy2;
        if (nzx < 0 || nzy < 0 || nzx >= zRes || nzy >= zRes) { onBorder = true; break; }
        if (zoneMap[(nzy * zRes + nzx) * 2] !== zone) { onBorder = true; break; }
      }
      if (onBorder) continue;

      // Выбираем модуль
      const moduleRoll = hashFloat(gx + 2, gy + 2, baseSeed + 7);
      const mod = pickModule(zone, moduleRoll);

      // Мировые координаты (origin = центр карты)
      const worldX = (px - hfRes / 2) * cellWorldSize;
      const worldY = (py - hfRes / 2) * cellWorldSize;
      const worldZ = heightfield[pyi * hfRes + pxi];

      // Yaw
      const yaw = hashFloat(gx + 3, gy + 3, baseSeed + 11) * Math.PI * 2;

      // Scale
      const sRoll  = hashFloat(gx + 4, gy + 4, baseSeed + 13);
      const hRoll  = hashFloat(gx + 5, gy + 5, baseSeed + 17);
      const sx = lerp(mod.scale[0], mod.scale[1], sRoll);
      const sy = sx;  // квадратный footprint (или отдельный roll для sy)
      const sz = lerp(mod.hScale[0], mod.hScale[1], hRoll);

      // Tint
      const palette = TINT_PALETTES[zone];
      const tIdx    = Math.floor(hashFloat(gx + 6, gy + 6, baseSeed + 19) * palette.length);
      const [tr, tg, tb] = palette[Math.min(tIdx, palette.length - 1)];
      const tintPacked = packTint(tr, tg, tb, 255);

      instances.push({
        moduleId: mod.id,
        data: [worldX, worldY, worldZ, yaw, sx, sy, sz, tintPacked]
      });
    }
    if (instances.length >= MAX_INSTANCES) break;
  }

  return instances;
}


// ---- Группировка инстансов по модулю ----
function packInstancesByModule(instances) {
  const groups = {};   // moduleId → Float32Array
  const counts = {};

  // Подсчёт
  for (const inst of instances) {
    counts[inst.moduleId] = (counts[inst.moduleId] || 0) + 1;
  }

  // Аллокация
  for (const [id, count] of Object.entries(counts)) {
    groups[id] = { buffer: new Float32Array(count * 8), count, offset: 0 };
  }

  // Заполнение
  for (const inst of instances) {
    const g = groups[inst.moduleId];
    g.buffer.set(inst.data, g.offset * 8);
    g.offset++;
  }

  // Результат: { moduleId: { buffer: Float32Array, count: N } }
  const result = {};
  for (const [id, g] of Object.entries(groups)) {
    result[id] = { buffer: g.buffer, count: g.count };
  }
  return result;
}


// ---- Main Entry Point ----
self.onmessage = function(e) {
  const { seed, placeId, radiusM } = e.data;
  const hfRes  = HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / hfRes;

  // 1. Heightfield (h_natural)
  const heightfield = new Float32Array(hfRes * hfRes);
  const noiseScale  = 0.01;   // подбирается под масштаб планеты
  for (let y = 0; y < hfRes; y++) {
    for (let x = 0; x < hfRes; x++) {
      const wx = (x - hfRes / 2) * cellSize;
      const wy = (y - hfRes / 2) * cellSize;
      heightfield[y * hfRes + x] = fBm(wx * noiseScale, wy * noiseScale, seed, 6) * 80;
      // 80 = макс. перепад высот в метрах
    }
  }

  // 2. Smoothed copy + box blur
  const blurKernel = Math.max(4, Math.min(32, Math.round(radiusM / cellSize * 0.3)));
  const smoothed   = boxBlurSeparable(heightfield, hfRes, hfRes, blurKernel);

  // 3. Terraform mask
  const terraformMap = generateTerraformMap(seed, placeId);

  // 4. Mix: h_final = mix(h_natural, h_smoothed, terraform_alpha)
  for (let i = 0; i < hfRes * hfRes; i++) {
    const alpha = terraformMap[i] / 255;
    heightfield[i] = heightfield[i] * (1 - alpha) + smoothed[i] * alpha;
  }

  // 5. Zone map
  const zoneMap = generateZoneMap(seed, placeId, radiusM);

  // 6. Scatter
  const instances     = scatterInstances(zoneMap, heightfield, radiusM, seed, placeId);
  const instancePacks = packInstancesByModule(instances);

  // 7. Собираем Transferable
  const transferables = [heightfield.buffer, zoneMap.buffer, terraformMap.buffer];
  const instanceBuffers = {};
  for (const [id, pack] of Object.entries(instancePacks)) {
    instanceBuffers[id] = { buffer: pack.buffer, count: pack.count };
    transferables.push(pack.buffer.buffer);
  }

  self.postMessage({
    heightfield,
    zoneMap,
    terraformMap,
    instanceBuffers,        // { moduleId: { buffer: Float32Array, count } }
    meta: { radiusM, hfRes: HEIGHTFIELD_RES, zoneRes: ZONE_RES, tfRes: TERRAFORM_RES }
  }, transferables);
};


/* ============================================================================
 * >>> ПРИНАДЛЕЖНОСТЬ: МОДУЛЬ 3: MAIN THREAD РЕНДЕРЕР (site/shared/local-map-renderer.js)
 * >>> НАЗНАЧЕНИЕ: Загрузчик GPU-ресурсов (VAO рельефа на gl.UNSIGNED_INT, instance VBOs на 32 байта, текстуры RG8UI и R8), методы drawTerrain и drawStructures.
 * ============================================================================
 */

// ============================================================
//  structureRenderer.js — Main Thread: приём данных Worker,
//  создание GPU-ресурсов, отрисовка terrain + instanced structures
// ============================================================

export class StructureRenderer {
  constructor(gl) {
    this.gl = gl;
    this.meshLibrary   = null;   // { moduleId: { vao, indexCount } }
    this.terrainVAO    = null;
    this.terrainIndexCount = 0;
    this.texZoning     = null;
    this.texTerraform  = null;
    this.instanceVBOs  = {};     // { moduleId: { vbo, count } }
    this.ready         = false;
    this.meta          = null;
  }


  // ---- Инициализация библиотеки мешей (один раз при старте) ----
  initMeshLibrary(meshes) {
    // meshes = buildMeshLibrary() из meshLibrary.js
    const gl = this.gl;
    this.meshLibrary = {};

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

      this.meshLibrary[id] = { vao, indexCount: mesh.indexCount };
    }
  }


  // ---- Приём данных от Worker ----
  onWorkerData(data) {
    const gl = this.gl;
    const { heightfield, zoneMap, terraformMap, instanceBuffers, meta } = data;
    this.meta = meta;

    // --- Текстура t_zoning (RG8UI, NEAREST) ---
    if (!this.texZoning) this.texZoning = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texZoning);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RG8UI,
      meta.zoneRes, meta.zoneRes, 0,
      gl.RG_INTEGER, gl.UNSIGNED_BYTE, zoneMap
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
      gl.RED, gl.UNSIGNED_BYTE, terraformMap
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // --- Terrain Mesh (256×256 plane, indexed GL_TRIANGLES, UINT32 indices) ---
    this._buildTerrainMesh(heightfield, meta);

    // --- Instance VBOs (per module type) ---
    this._uploadInstances(instanceBuffers);

    this.ready = true;
  }


  _buildTerrainMesh(heightfield, meta) {
    const gl  = this.gl;
    const res = meta.hfRes;                           // 256
    const cellSize = (2 * meta.radiusM) / res;

    // Positions (x, y, z)
    const positions = new Float32Array(res * res * 3);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        positions[i * 3]     = (x - res / 2) * cellSize;   // world X
        positions[i * 3 + 1] = (y - res / 2) * cellSize;   // world Y
        positions[i * 3 + 2] = heightfield[i];              // world Z
      }
    }

    // Indices (UNSIGNED_INT — контракт, 256×256 = 65536 вершин)
    const quadsPerRow = res - 1;
    const indexCount  = quadsPerRow * quadsPerRow * 6;
    const indices     = new Uint32Array(indexCount);
    let ptr = 0;
    for (let y = 0; y < quadsPerRow; y++) {
      for (let x = 0; x < quadsPerRow; x++) {
        const tl = y * res + x;
        const tr = tl + 1;
        const bl = tl + res;
        const br = bl + 1;
        indices[ptr++] = tl;  indices[ptr++] = bl;  indices[ptr++] = tr;
        indices[ptr++] = tr;  indices[ptr++] = bl;  indices[ptr++] = br;
      }
    }
    this.terrainIndexCount = indexCount;

    // Нормали (finite differences)
    const normals = new Float32Array(res * res * 3);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i  = y * res + x;
        const hL = x > 0       ? heightfield[i - 1]   : heightfield[i];
        const hR = x < res - 1 ? heightfield[i + 1]   : heightfield[i];
        const hD = y > 0       ? heightfield[i - res]  : heightfield[i];
        const hU = y < res - 1 ? heightfield[i + res]  : heightfield[i];
        // Tangent vectors → cross product
        const nx = (hL - hR) / (2 * cellSize);
        const ny = (hD - hU) / (2 * cellSize);
        const nz = 1.0;
        const len = Math.hypot(nx, ny, nz);
        normals[i * 3]     = nx / len;
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


  _uploadInstances(instanceBuffers) {
    const gl = this.gl;

    for (const [moduleId, pack] of Object.entries(instanceBuffers)) {
      const entry = this.meshLibrary[moduleId];
      if (!entry) continue;

      // Создаём или обновляем instance VBO
      if (!this.instanceVBOs[moduleId]) {
        this.instanceVBOs[moduleId] = { vbo: gl.createBuffer(), count: 0 };
      }

      const inst = this.instanceVBOs[moduleId];
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
  drawTerrain(shaderProgram) {
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


  drawStructures(shaderProgram) {
    if (!this.ready) return;
    const gl = this.gl;

    gl.useProgram(shaderProgram);

    for (const [moduleId, inst] of Object.entries(this.instanceVBOs)) {
      if (inst.count === 0) continue;
      const mesh = this.meshLibrary[moduleId];
      if (!mesh) continue;

      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(
        gl.TRIANGLES,
        mesh.indexCount,
        gl.UNSIGNED_SHORT,     // Меш-индексы — 16-bit (модули маленькие, <100 вершин)
        0,
        inst.count
      );
    }

    gl.bindVertexArray(null);
  }
}


/* ============================================================================
 * >>> ПРИНАДЛЕЖНОСТЬ: МОДУЛЬ 4.1: ШЕЙДЕР СТРУКТУР — VERTEX (structure.vert)
 * >>> НАЗНАЧЕНИЕ: WebGL2 Vertex Shader: сборка матрицы трансформации из 8 float, распаковка tint, круговой туман.
 * ============================================================================
 */

// ============================================================
//  structure.vert — Instanced structures vertex shader
// ============================================================
#version 300 es
precision highp float;

// Per-vertex (из VAO модуля)
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;

// Per-instance (divisor = 1)
layout(location = 2) in vec4 a_inst_pos_yaw;     // (x, y, z, yaw)
layout(location = 3) in vec4 a_inst_scale_tint;   // (sx, sy, sz, packed_tint)

uniform mat4 u_viewProj;
uniform vec3 u_lightDir;         // normalised, world space
uniform vec3 u_fogColor;
uniform float u_fogStart;        // 0.75 * R_gen
uniform float u_fogEnd;          // R_gen

out vec3 v_normal;
out vec3 v_worldPos;
out vec4 v_tint;
out float v_fog;

vec4 unpackTint(float packed) {
  uint u = floatBitsToUint(packed);
  return vec4(
    float(u & 0xFFu),
    float((u >> 8u) & 0xFFu),
    float((u >> 16u) & 0xFFu),
    float((u >> 24u) & 0xFFu)
  ) / 255.0;
}

void main() {
  float c = cos(a_inst_pos_yaw.w);
  float s = sin(a_inst_pos_yaw.w);
  float sx = a_inst_scale_tint.x;
  float sy = a_inst_scale_tint.y;
  float sz = a_inst_scale_tint.z;

  // T * R_z * S  (column-major)
  mat4 model = mat4(
     sx*c,  sx*s, 0.0, 0.0,
    -sy*s,  sy*c, 0.0, 0.0,
     0.0,   0.0,  sz,  0.0,
     a_inst_pos_yaw.x, a_inst_pos_yaw.y, a_inst_pos_yaw.z, 1.0
  );

  vec4 worldPos = model * vec4(a_position, 1.0);
  gl_Position   = u_viewProj * worldPos;

  // Нормаль: (R * S)^-T ≈ R * S^-1 для осевого масштабирования
  mat3 normalMat = mat3(
     c/sx,  s/sx, 0.0,
    -s/sy,  c/sy, 0.0,
     0.0,   0.0,  1.0/sz
  );
  v_normal   = normalize(normalMat * a_normal);
  v_worldPos = worldPos.xyz;
  v_tint     = unpackTint(a_inst_scale_tint.w);

  // Circular distance fog
  float dist = length(worldPos.xy);     // от центра карты (origin)
  v_fog = clamp((dist - u_fogStart) / (u_fogEnd - u_fogStart), 0.0, 1.0);
}


/* ============================================================================
 * >>> ПРИНАДЛЕЖНОСТЬ: МОДУЛЬ 4.2: ШЕЙДЕР СТРУКТУР — FRAGMENT (structure.frag)
 * >>> НАЗНАЧЕНИЕ: WebGL2 Fragment Shader: Directional + Ambient освещение, примитивное контактное AO у основания, Circular Fog.
 * ============================================================================
 */

// ============================================================
//  structure.frag — Instanced structures fragment shader
// ============================================================
#version 300 es
precision highp float;

in vec3  v_normal;
in vec3  v_worldPos;
in vec4  v_tint;
in float v_fog;

uniform vec3  u_lightDir;
uniform vec3  u_ambientColor;
uniform vec3  u_fogColor;

out vec4 fragColor;

void main() {
  // Simple directional + ambient
  vec3 N = normalize(v_normal);
  float NdL = max(dot(N, u_lightDir), 0.0);

  vec3 diffuse = v_tint.rgb * (u_ambientColor + vec3(NdL));

  // Простейшее AO: затемнение у основания (z близко к 0)
  float ao = smoothstep(0.0, 0.3, v_worldPos.z / 20.0);  // 20м = масштаб здания
  diffuse *= mix(0.6, 1.0, ao);

  // Fog
  vec3 finalColor = mix(diffuse, u_fogColor, v_fog);

  fragColor = vec4(finalColor, 1.0);
}


/* ============================================================================
 * >>> ПРИНАДЛЕЖНОСТЬ: МОДУЛЬ 4.3: ШЕЙДЕР ТЕРРЕЙНА — VERTEX (terrain.vert)
 * >>> НАЗНАЧЕНИЕ: WebGL2 Vertex Shader: расчёт мировых координат, нормалей, UV зон и кругового тумана.
 * ============================================================================
 */

// ============================================================
//  terrain.vert — Terrain vertex shader
// ============================================================
#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;

uniform mat4 u_viewProj;
uniform float u_fogStart;
uniform float u_fogEnd;

out vec3 v_worldPos;
out vec3 v_normal;
out vec2 v_uv;         // для сэмплинга зон
out float v_fog;

uniform float u_terrainSize;     // 2 * R_gen в метрах

void main() {
  gl_Position = u_viewProj * vec4(a_position, 1.0);
  v_worldPos  = a_position;
  v_normal    = a_normal;

  // UV: мировые координаты → [0,1] (центр карты = 0.5, 0.5)
  v_uv = a_position.xy / u_terrainSize + 0.5;

  float dist = length(a_position.xy);
  v_fog = clamp((dist - u_fogStart) / (u_fogEnd - u_fogStart), 0.0, 1.0);
}


/* ============================================================================
 * >>> ПРИНАДЛЕЖНОСТЬ: МОДУЛЬ 4.4: ШЕЙДЕР ТЕРРЕЙНА — FRAGMENT (terrain.frag)
 * >>> НАЗНАЧЕНИЕ: WebGL2 Fragment Shader: сэмплирование usampler2D (RG8UI) и sampler2D (R8), смешивание палитр грунта зон, освещение и туман.
 * ============================================================================
 */

// ============================================================
//  terrain.frag — Terrain fragment shader
// ============================================================
#version 300 es
precision highp float;

in vec3  v_worldPos;
in vec3  v_normal;
in vec2  v_uv;
in float v_fog;

uniform usampler2D u_zoning_map;     // RG8UI
uniform sampler2D  u_terraform_map;  // R8
uniform vec3  u_lightDir;
uniform vec3  u_ambientColor;
uniform vec3  u_fogColor;

out vec4 fragColor;

// Палитра зон (грунт)
const vec3 ZONE_COLORS[5] = vec3[5](
  vec3(0.45, 0.40, 0.35),   // 0: пустошь (натуральный грунт)
  vec3(0.50, 0.48, 0.45),   // 1: жилая зона (слегка серее)
  vec3(0.42, 0.40, 0.38),   // 2: промзона (тёмный бетон)
  vec3(0.35, 0.38, 0.30),   // 3: периметр (камуфляж)
  vec3(0.55, 0.55, 0.58)    // 4: ядро (чистый бетон)
);

void main() {
  uvec4 zoneData = texture(u_zoning_map, v_uv);
  uint zone = zoneData.r;
  float terraformBlend = texture(u_terraform_map, v_uv).r;

  // Базовый цвет грунта: микс натурального и зонального
  vec3 naturalColor = ZONE_COLORS[0];
  vec3 zoneColor    = (zone < 5u) ? ZONE_COLORS[zone] : naturalColor;
  vec3 baseColor    = mix(naturalColor, zoneColor, terraformBlend);

  // Освещение
  vec3 N   = normalize(v_normal);
  float NdL = max(dot(N, u_lightDir), 0.0);
  vec3 lit  = baseColor * (u_ambientColor + vec3(NdL * 0.8));

  // Fog
  vec3 finalColor = mix(lit, u_fogColor, v_fog);
  fragColor = vec4(finalColor, 1.0);
}

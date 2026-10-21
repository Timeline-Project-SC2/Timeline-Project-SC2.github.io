/* LocalMapMesh — библиотека базовых low-poly мешей 3D-структур локальной карты
   (Этапы 8/9, CR-01 PR 5). Модуль 1 из четырёх распила
   site/shared/temp_code_structures.js (правило вытеснения И-5: свалка удалена).
   --------------------------------------------------------------------------
   Каждый модуль: { positions, normals, indices, vertexCount, indexCount }.
   Все модули нормализованы: footprint ~1×1, высота ~1 (масштаб задаёт инстанс).
   Меш-индексы — Uint16 (<100 вершин на модуль), как ждёт drawElementsInstanced
   рендерера local-map-renderer.ts (gl.UNSIGNED_SHORT). */

export interface MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint16Array;
  readonly vertexCount: number;
  readonly indexCount: number;
}

/** Канонические ID модулей — привязка к ZONE_MODULES из local-map-worker.ts. */
export type MeshModuleId =
  | 'hab_box'
  | 'container'
  | 'comm_mast'
  | 'factory'
  | 'silo_tank'
  | 'pipe_stack'
  | 'cargo_bay'
  | 'guard_tower'
  | 'barrier'
  | 'radar_dish'
  | 'hq_center'
  | 'dome_vault';

export type MeshLibrary = Readonly<Record<MeshModuleId, MeshData>>;

function finishMesh(verts: number[], norms: number[], idx: number[]): MeshData {
  return {
    positions: new Float32Array(verts),
    normals: new Float32Array(norms),
    indices: new Uint16Array(idx),
    vertexCount: verts.length / 3,
    indexCount: idx.length,
  };
}

export function createBoxMesh(wx = 1, wy = 1, hz = 1): MeshData {
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

export function createCylinderMesh(radius = 0.5, height = 1, segments = 12): MeshData {
  // Цистерна / силос. Без нижнего диска (стоит на земле).
  const verts: number[] = [];
  const norms: number[] = [];
  const idx: number[] = [];

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

  return finishMesh(verts, norms, idx);
}

export function createDomeMesh(radius = 0.5, height = 0.6, rings = 6, segments = 12): MeshData {
  // Полусфера / купол (научная станция, радар)
  const verts: number[] = [];
  const norms: number[] = [];
  const idx: number[] = [];

  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * (Math.PI / 2);     // 0 … π/2
    const rr = Math.cos(phi) * radius;
    const zz = Math.sin(phi) * height;
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
      const cur = r * (segments + 1) + s;
      const next = cur + segments + 1;
      idx.push(cur, next, cur + 1);
      idx.push(cur + 1, next, next + 1);
    }
  }

  return finishMesh(verts, norms, idx);
}

export function createWedgeMesh(wx = 1, wy = 1, hFront = 1, hBack = 0.6): MeshData {
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
  const rnZ = roofDy / roofLen;

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

export function createTowerMesh(baseRadius = 0.3, topRadius = 0.15, height = 1, segments = 8): MeshData {
  // Усечённый конус — вышка, башня, опора
  const verts: number[] = [];
  const norms: number[] = [];
  const idx: number[] = [];

  const slope = Math.atan2(baseRadius - topRadius, height);
  const nz = Math.sin(slope);
  const nr = Math.cos(slope);

  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
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

  return finishMesh(verts, norms, idx);
}

// ============================================================
//  Фабрика: привязка к Module IDs из ZONE_MODULES
// ============================================================
const MESH_BUILDERS: Readonly<Record<MeshModuleId, () => MeshData>> = {
  hab_box: () => createBoxMesh(1, 1, 1),
  container: () => createBoxMesh(1.2, 0.5, 0.5),
  comm_mast: () => createTowerMesh(0.1, 0.05, 1, 6),
  factory: () => createWedgeMesh(1.4, 1, 1, 0.65),
  silo_tank: () => createCylinderMesh(0.5, 1, 12),
  pipe_stack: () => createCylinderMesh(0.15, 1, 8),
  cargo_bay: () => createBoxMesh(1.3, 0.8, 0.7),
  guard_tower: () => createTowerMesh(0.35, 0.2, 1, 6),
  barrier: () => createBoxMesh(1.5, 0.3, 0.5),
  radar_dish: () => createDomeMesh(0.4, 0.3, 5, 10),
  hq_center: () => createBoxMesh(1.5, 1.5, 1),
  dome_vault: () => createDomeMesh(0.7, 0.5, 6, 12),
};

export function buildMeshLibrary(): MeshLibrary {
  const library = {} as Record<MeshModuleId, MeshData>;
  for (const id of Object.keys(MESH_BUILDERS) as MeshModuleId[]) {
    library[id] = MESH_BUILDERS[id]();
  }
  return library;
}

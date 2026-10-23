/* LocalMapShaders — GLSL ES 3.00 шейдеры локальной карты (Этапы 8/9, CR-01 PR 5;
   Stage-8 Planetary Horizon: кривизна планеты, оптический блюр горизонта,
   гекс-сетка 6 колец, атмосферная дымка и купол неба).
   --------------------------------------------------------------------------
   Поля шейдеров обязаны совпадать с контрактом VAO рендерера
   (local-map-renderer.ts):
   - location 0: a_position (per-vertex), location 1: a_normal (per-vertex);
   - location 2: a_inst_pos_yaw (divisor 1), location 3: a_inst_scale_tint
     (divisor 1) — 32 байта на инстанс, упаковка packTint из local-map-worker.ts;
   - t_zoning: usampler2D (RG8UI, строго GL_NEAREST), t_terraform: sampler2D
     (R8, GL_LINEAR).
   Сферическое проседание Δz = R_p − sqrt(R_p² − r²) выполняется в вершинных
   шейдерах по uniform u_planetRadiusM (0.0 — плоская карта, старое поведение). */

// ============================================================
//  structure.vert — Instanced structures vertex shader
// ============================================================
export const STRUCTURE_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

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
uniform float u_planetRadiusM;   // <= 1.0 — сферическое проседание выключено

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

  // Здания стоят на изогнутой поверхности: та же формула проседания, что и у
  // рельефа, — без зависания над сферическим горизонтом.
  float r2 = dot(worldPos.xy, worldPos.xy);
  float curvatureDrop = (u_planetRadiusM > 1.0)
    ? (u_planetRadiusM - sqrt(max(0.0, u_planetRadiusM * u_planetRadiusM - r2)))
    : 0.0;
  vec4 curvedPos = vec4(worldPos.x, worldPos.y, worldPos.z - curvatureDrop, 1.0);
  gl_Position   = u_viewProj * curvedPos;

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
`;

// ============================================================
//  structure.frag — Instanced structures fragment shader
// ============================================================
export const STRUCTURE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

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
`;

// ============================================================
//  terrain.vert — Terrain vertex shader
// ============================================================
export const TERRAIN_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;

uniform mat4 u_viewProj;
uniform float u_fogStart;
uniform float u_fogEnd;
uniform float u_terrainSize;     // 2 * R_gen в метрах
uniform float u_planetRadiusM;   // <= 1.0 — плоская карта (обратная совместимость)

out vec3 v_worldPos;
out vec3 v_normal;
out vec2 v_uv;         // для сэмплинга зон
out float v_fog;

void main() {
  // v_worldPos хранит ИСХОДНУЮ гипсометрическую высоту a_position.z: вода
  // (z <= 0) и изолинии считаются над уровнем моря, а не по просевшему z.
  v_worldPos  = a_position;
  v_normal    = a_normal;

  // UV: мировые координаты → [0,1] (центр карты = 0.5, 0.5)
  v_uv = a_position.xy / u_terrainSize + 0.5;

  float dist = length(a_position.xy);
  v_fog = clamp((dist - u_fogStart) / (u_fogEnd - u_fogStart), 0.0, 1.0);

  // Сферическое проседание касательной плоскости: Δz = R − sqrt(R² − r²).
  float r2 = dot(a_position.xy, a_position.xy);
  float curvatureDrop = (u_planetRadiusM > 1.0)
    ? (u_planetRadiusM - sqrt(max(0.0, u_planetRadiusM * u_planetRadiusM - r2)))
    : 0.0;
  vec3 curvedPos = vec3(a_position.x, a_position.y, a_position.z - curvatureDrop);
  gl_Position = u_viewProj * vec4(curvedPos, 1.0);
}
`;

// ============================================================
//  terrain.frag — Terrain fragment shader
// ============================================================
export const TERRAIN_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec3  v_worldPos;
in vec3  v_normal;
in vec2  v_uv;
in float v_fog;

uniform usampler2D u_zoning_map;     // RG8UI
uniform sampler2D  u_terraform_map;  // R8
uniform vec3  u_lightDir;
uniform vec3  u_ambientColor;
uniform vec3  u_fogColor;
uniform vec3  u_horizonColor;        // цвет атмосферного лимба у горизонта
uniform float u_fogStart;
uniform float u_fogEnd;
uniform float u_isSkirt;             // 1.0 — планетарная юбка, 0.0 — центр
uniform float u_focusRadiusM;        // радиус детального участка R_patch
uniform float u_hexSizeM;            // шаг гексов d_hex в метрах

out vec4 fragColor;

// Палитра зон (грунт)
const vec3 ZONE_COLORS[5] = vec3[5](
  vec3(0.45, 0.40, 0.35),   // 0: пустошь (натуральный грунт)
  vec3(0.50, 0.48, 0.45),   // 1: жилая зона (слегка серее)
  vec3(0.42, 0.40, 0.38),   // 2: промзона (тёмный бетон)
  vec3(0.35, 0.38, 0.30),   // 3: периметр (камуфляж)
  vec3(0.55, 0.55, 0.58)    // 4: ядро (чистый бетон)
);

// Вода/озёра/русла (И-3.2, И-3.3): мелководье и глубина ниже уровня моря.
const vec3 SHALLOW_WATER_COLOR = vec3(0.145, 0.375, 0.415);
const vec3 DEEP_WATER_COLOR    = vec3(0.055, 0.235, 0.290);

// Число видимых колец соседних гексов планетарной юбки.
const int SKIRT_RING_COUNT = 6;

/** Округление аксиальных кубических координат гекса к центру ближайшей ячейки. */
vec3 roundHexCube(vec3 cube) {
  vec3 r = round(cube);
  float dx = abs(r.x - cube.x);
  float dy = abs(r.y - cube.y);
  float dz = abs(r.z - cube.z);
  if (dx > dy && dx > dz) {
    r.x = -r.y - r.z;
  } else if (dy > dz) {
    r.y = -r.x - r.z;
  } else {
    r.z = -r.x - r.y;
  }
  return r;
}

void main() {
  uvec4 zoneData = texture(u_zoning_map, v_uv);
  uint zone = zoneData.r;
  float terraformBlend = texture(u_terraform_map, v_uv).r;

  float dist = length(v_worldPos.xy);
  // Оптический блюр: мелкие складки рельефа и сетки растворяются к горизонту.
  // При u_focusRadiusM <= 1 (старый путь без юбки) эффекты Stage-8 выключены.
  float blur = (u_focusRadiusM > 1.0)
    ? smoothstep(u_focusRadiusM * 0.75, u_fogEnd * 0.82, dist)
    : 0.0;

  // Гипсометрия и изолинии рельефа: низины зеленее, склоны и гребни каменистее.
  float hNorm = clamp((v_worldPos.z - 15.0) / 140.0, 0.0, 1.0);
  vec3 lowlandColor  = vec3(0.31, 0.39, 0.30);
  vec3 highlandColor = vec3(0.57, 0.53, 0.47);
  vec3 naturalColor  = mix(lowlandColor, ZONE_COLORS[0], smoothstep(0.0, 0.45, hNorm));
  naturalColor       = mix(naturalColor, highlandColor, smoothstep(0.45, 1.0, hNorm));

  // Тонкие топографические изолинии каждые 16 м высоты; к горизонту гаснут.
  float contourPhase = abs(fract(v_worldPos.z / 16.0) - 0.5);
  float contourLine  = (1.0 - smoothstep(0.0, 0.045, contourPhase))
    * (1.0 - blur * 0.92);
  naturalColor      *= (1.0 - 0.12 * contourLine);

  vec3 zoneColor    = (zone < 5u) ? ZONE_COLORS[zone] : naturalColor;
  if (zone > 0u && zone < 5u) {
    vec2 gridCell = abs(fract(v_uv * 64.0) - 0.5);
    // Техногенная сетка базы тоже оптически размывается вдали.
    float padGrid = (1.0 - smoothstep(0.44, 0.49, max(gridCell.x, gridCell.y)))
      * (1.0 - blur * 0.9);
    zoneColor *= (0.92 + 0.08 * padGrid);
  }
  vec3 baseColor    = mix(naturalColor, zoneColor, terraformBlend * 0.72);

  // И-3.2/И-3.3: плавное тонирование водных низин и речных русел. Зеркало
  // воды/озёр канонической ячейки лежит ровно на уровне seaLevel (z == 0),
  // врез речного русла уходит ниже, поэтому условие — z <= 0. Воркер не
  // зонирует воду (applyWaterZoning), так что zone == 0u здесь означает
  // «вода, озеро, русло или пустошь вне техногенных площадок».
  if (zone == 0u && v_worldPos.z <= 0.0) {
    float depthBelowZero = max(0.0, -v_worldPos.z);
    float waterBlend = smoothstep(0.0, 3.0, depthBelowZero);
    vec3 waterColor = mix(SHALLOW_WATER_COLOR, DEEP_WATER_COLOR, smoothstep(0.0, 24.0, depthBelowZero));
    baseColor = mix(baseColor, waterColor, waterBlend * 0.92);
  }

  // Освещение: нормаль сглаживается к вертикали по мере оптического блюра.
  vec3 N   = normalize(mix(normalize(v_normal), vec3(0.0, 0.0, 1.0), blur * 0.78));
  float NdL = max(dot(N, u_lightDir), 0.0);
  vec3 lit  = baseColor * (u_ambientColor + vec3(NdL * 0.8));

  // Мягкая топографическая гексагональная сетка 6 колец на юбке и дальней
  // зоне: тонкие цианово-золотистые грани соседних гексов, гаснущие в блюре.
  if ((u_isSkirt > 0.5 || dist > u_focusRadiusM * 0.9)
      && u_hexSizeM > 1.0 && u_focusRadiusM > 1.0) {
    vec3 cube = vec3(
      (0.57735026919 * v_worldPos.x - v_worldPos.y / 3.0) / u_hexSizeM,
      (2.0 * v_worldPos.y / 3.0) / u_hexSizeM,
      0.0
    );
    cube.z = -cube.x - cube.y;
    vec3 rounded = roundHexCube(cube);
    float edgeCoord = max(
      max(abs(cube.x - rounded.x), abs(cube.y - rounded.y)),
      abs(cube.z - rounded.z)
    );
    float hexLine = smoothstep(0.36, 0.5, edgeCoord);
    float ringK = (abs(rounded.x) + abs(rounded.y) + abs(rounded.z)) * 0.5;
    float ringFade = 1.0 - smoothstep(
      float(SKIRT_RING_COUNT), float(SKIRT_RING_COUNT + 1), ringK);
    float hexFade = hexLine * ringFade * (1.0 - blur * 0.85);
    vec3 hexCyan = vec3(0.30, 0.72, 0.78);
    vec3 hexGold = vec3(0.83, 0.68, 0.32);
    vec3 hexColor = mix(hexCyan, hexGold, clamp(ringK / float(SKIRT_RING_COUNT), 0.0, 1.0));
    lit = mix(lit, hexColor, clamp(hexFade * 0.5, 0.0, 0.6));
  }

  // Атмосферная перспектива (Rayleigh/Mie): сначала голубоватая дымка лимба
  // по экспоненте, у самого края 6-го кольца — полное растворение в u_fogColor.
  vec3 finalColor;
  if (u_focusRadiusM > 1.0) {
    float haze = 1.0 - exp(-2.6 * v_fog * v_fog);
    vec3 hazed = mix(lit, u_horizonColor, clamp(haze, 0.0, 1.0));
    finalColor = mix(hazed, u_fogColor, smoothstep(0.82, 1.0, v_fog));
  } else {
    finalColor = mix(lit, u_fogColor, v_fog);
  }
  fragColor = vec4(finalColor, 1.0);
}
`;

// ============================================================
//  sky-dome.vert — полноэкранный треугольник купола неба/лимба
// ============================================================
export const SKY_DOME_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

out vec2 v_ndc;

void main() {
  // Полноэкранный треугольник без атрибутов и буферов (gl_VertexID 0..2).
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_ndc = p * 2.0 - 1.0;
  // z = 0.9999: купол рисуется с depthMask(false), рельеф всегда проходит тест.
  gl_Position = vec4(p * 2.0 - 1.0, 0.9999, 1.0);
}
`;

// ============================================================
//  sky-dome.frag — сферический горизонт, лимб атмосферы и солнечный ореол
// ============================================================
export const SKY_DOME_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_ndc;

uniform float u_camPitch;        // наклон камеры, рад
uniform float u_camYaw;          // азимут камеры, рад
uniform float u_fovY;            // вертикальный FOV, рад
uniform float u_aspect;          // ширина / высота
uniform float u_camHeightM;      // высота камеры над поверхностью, м
uniform float u_planetRadiusM;   // R_p, м
uniform vec3  u_lightDir;        // направление на солнце, нормализовано
uniform vec3  u_fogColor;        // плотная дымка планетарного диска
uniform vec3  u_horizonColor;    // светящийся атмосферный лимб

out vec4 fragColor;

void main() {
  float tanHalfY = tan(u_fovY * 0.5);

  // Базис камеры совпадает с localViewProjection планетарной страницы.
  vec3 forward = normalize(vec3(
    -cos(u_camPitch) * cos(u_camYaw),
    -cos(u_camPitch) * sin(u_camYaw),
    -sin(u_camPitch)
  ));
  vec3 right = vec3(-sin(u_camYaw), cos(u_camYaw), 0.0);
  vec3 up = vec3(
    -sin(u_camPitch) * cos(u_camYaw),
    -sin(u_camPitch) * sin(u_camYaw),
     cos(u_camPitch)
  );
  vec3 ray = normalize(
    forward
    + right * (v_ndc.x * tanHalfY * u_aspect)
    + up * (v_ndc.y * tanHalfY)
  );

  // Физический угол депрессии сферического горизонта: θ = −acos(R/(R+h)).
  float horizonCos = clamp(
    u_planetRadiusM / (u_planetRadiusM + max(1.0, u_camHeightM)),
    0.0, 1.0
  );
  float horizonAngle = -acos(horizonCos);
  float beta = asin(clamp(ray.z, -1.0, 1.0));

  // Небо: глубокий космос в зените → светящийся атмосферный лимб у горизонта.
  vec3 deepSpace = u_fogColor * 0.55;
  float skyT = smoothstep(horizonAngle, horizonAngle + 0.95, beta);
  vec3 sky = mix(u_horizonColor, deepSpace, skyT);

  // Мягкий солнечный ореол по u_lightDir.
  float sunDot = max(dot(ray, normalize(u_lightDir)), 0.0);
  float halo = pow(sunDot, 18.0) * 0.5 + pow(sunDot, 90.0) * 0.9;
  sky += vec3(1.0, 0.86, 0.62) * halo;

  // Диск планеты ниже линии горизонта: плотная дымка, в неё без шва
  // уходит внешнее (6-е) кольцо гексов.
  float diskT = smoothstep(horizonAngle - 0.28, horizonAngle, beta);
  vec3 disk = mix(u_fogColor, u_horizonColor, diskT);
  float above = smoothstep(horizonAngle - 0.015, horizonAngle + 0.015, beta);

  vec3 color = mix(disk, sky, above);
  fragColor = vec4(color, 1.0);
}
`;

/* LocalMapShaders — GLSL ES 3.00 шейдеры локальной карты (Этапы 8/9, CR-01 PR 5;
   Stage-8 Planetary Horizon: кривизна планеты, оптический блюр горизонта,
   атмосферная дымка и купол неба.
   Stage-8.2: выделение только активного центрального гекса тонкой тактической
   кромкой, бесшовный простирающийся сферический горизонт с 3-каскадными
   процедурными текстурами рельефа, плавным ухудшением видимости от границы
   гекса к лимбу и непрозрачным куполом неба со звёздами.
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

/**
 * Гексагональная метрика правильного шестиугольника: hexMetric2D(p) = 1 —
 * граница гекса с апофемой 1 (плоские стороны смотрят на 30°, 90°, 150°…),
 * вершины лежат на 0°, 60°, 120°…
 */
float hexMetric2D(vec2 p) {
  vec2 a = abs(p);
  return max(a.x * 0.8660254 + a.y * 0.5, a.y);
}

/** Компактный детерминированный 2D-хеш без sin()-артефактов точности. */
float terrainHash2D(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Плавный 2D value-шум с эрмитовой интерполяцией в диапазоне [0, 1]. */
float terrainValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = terrainHash2D(i);
  float b = terrainHash2D(i + vec2(1.0, 0.0));
  float c = terrainHash2D(i + vec2(0.0, 1.0));
  float d = terrainHash2D(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  float dist = length(v_worldPos.xy);
  // Апофема активного центрального гекса и гексагональная метрика (ориентация clusterHexMetric: yx).
  float hexApothem = u_focusRadiusM * 0.8054;
  float centerHexDist = hexMetric2D(v_worldPos.yx);

  // Центральный участок обрезается строгим правильным шестиугольником:
  // 6 прямых сторон активного гекса (с микрозапасом 1.003 для бесшовного
  // перекрытия с воротником юбки) и страховочное круговое отсечение 0.935·R_patch.
  if (u_isSkirt < 0.5 && u_focusRadiusM > 1.0 && dist > u_focusRadiusM * 0.935) {
    discard;
  }
  if (u_isSkirt < 0.5 && u_focusRadiusM > 1.0 && centerHexDist > hexApothem * 1.003) {
    discard;
  }

  // Юбка не наследует краевые тексели карт центрального участка.
  uint zone = 0u;
  float terraformBlend = 0.0;
  if (u_isSkirt < 0.5) {
    uvec4 zoneData = texture(u_zoning_map, v_uv);
    zone = zoneData.r;
    terraformBlend = texture(u_terraform_map, v_uv).r;
  }

  // Внутри активного гекса (centerHexDist <= hexApothem) оптическое размытие
  // строго нулевое (blur = 0.0), а за его пределами плавно нарастает к горизонту.
  float blur = (u_focusRadiusM > 1.0 && u_fogEnd * 0.88 > hexApothem)
    ? smoothstep(hexApothem, u_fogEnd * 0.88, centerHexDist)
    : ((u_focusRadiusM > 1.0 && centerHexDist > hexApothem) ? 1.0 : 0.0);

  // Признак горизонтального водного зеркала: у воды/озера (зона 0) нормаль
  // строго вертикальна, поэтому xy-составляющая нормали равна нулю. Такой
  // фрагмент не получает ни сухопутной текстуры, ни изолиний — иначе на
  // континентальном озере выше seaLevel (z > 0) рисовались бы полосатые
  // кольца и «каменные» склоны.
  float normalHoriz = length(v_normal.xy);
  bool isFlatWaterMirror = (zone == 0u) && (normalHoriz < 0.0015);

  // Гипсометрия и изолинии рельефа: низины зеленее, склоны и гребни каменистее.
  float hNorm = clamp((v_worldPos.z - 15.0) / 140.0, 0.0, 1.0);
  vec3 lowlandColor  = vec3(0.31, 0.39, 0.30);
  vec3 highlandColor = vec3(0.57, 0.53, 0.47);
  vec3 naturalColor  = mix(lowlandColor, ZONE_COLORS[0], smoothstep(0.0, 0.45, hNorm));
  naturalColor       = mix(naturalColor, highlandColor, smoothstep(0.45, 1.0, hNorm));

  // Тонкие изолинии каждые 16 м остаются только внутри активного гекса:
  // плавно затухают до границы hexApothem и полностью погашены на юбке.
  float contourPhase = abs(fract(v_worldPos.z / 16.0) - 0.5);
  float contourFade  = (u_focusRadiusM > 1.0)
    ? (1.0 - smoothstep(hexApothem * 0.72, hexApothem * 0.96, centerHexDist))
    : 1.0;
  float contourLine  = isFlatWaterMirror
    ? 0.0
    : (1.0 - smoothstep(0.0, 0.045, contourPhase)) * contourFade * (1.0 - u_isSkirt);
  naturalColor      *= (1.0 - 0.12 * contourLine);

  // 3 каскада процедурной текстуры поверхности суши (v_worldPos.z > 0.0)
  // в нормированных мировых координатах (единое поле для центра и юбки).
  // Ровное водное зеркало (в том числе озеро выше seaLevel) сухопутной
  // текстуры не получает вовсе.
  if (v_worldPos.z > 0.0 && !isFlatWaterMirror) {
    vec2 surfCoord = v_worldPos.xy / max(u_focusRadiusM, 1.0);
    const mat2 OCTAVE_ROT = mat2(0.80, 0.60, -0.60, 0.80);

    // 1. Ближняя микротекстура породы/грунта (внутри гекса и у его кромки).
    float microFade = 1.0 - smoothstep(0.0, 0.35, blur);
    float microGrain = terrainValueNoise(surfCoord * 44.0) * 0.62
      + terrainValueNoise((OCTAVE_ROT * surfCoord) * 96.0 + vec2(13.7, 7.9)) * 0.38;
    vec3 gritTint = mix(vec3(0.90, 0.89, 0.87), vec3(1.11, 1.09, 1.06), microGrain);
    naturalColor *= mix(vec3(1.0), gritTint, microFade * 0.85);

    // 2. Среднемасштабная пятнистость биома и непериодическое затенение
    //    крутых склонов. Периодическая стратификация по высоте (fract(z / 30))
    //    убрана: она рисовала концентрические «зебровые» кольца каждые 30 м
    //    на склонах. Теперь тон склонов задаёт их крутизна (slopeSteep /
    //    slopeRock) в сочетании с 2D-шумом mesoPatch — без периодичности.
    float mesoFade = 1.0 - smoothstep(0.15, 0.78, blur);
    float mesoPatch = terrainValueNoise(surfCoord * 7.5 + vec2(4.2, -9.1)) * 0.60
      + terrainValueNoise((OCTAVE_ROT * surfCoord) * 17.5 + vec2(-6.4, 15.3)) * 0.40;
    float slopeSteep = clamp(1.0 - normalize(v_normal).z, 0.0, 1.0);
    float slopeRock = smoothstep(0.02, 0.28, slopeSteep);
    vec3 biomeMottle = mix(vec3(0.28, 0.37, 0.28), vec3(0.55, 0.50, 0.43), mesoPatch);
    vec3 slopeRockTone = mix(vec3(0.30, 0.28, 0.25), vec3(0.50, 0.46, 0.41), mesoPatch);
    naturalColor = mix(naturalColor, biomeMottle, mesoFade * 0.26);
    naturalColor = mix(naturalColor, slopeRockTone, slopeRock * 0.38 * mesoFade);
    naturalColor *= 1.0 - 0.18 * slopeRock * (0.45 + 0.55 * mesoPatch) * mesoFade;

    // 3. Дальние макро-тона вершин и ложбин, читаемые вплоть до дымки горизонта.
    float macroBasin = terrainValueNoise(surfCoord * 1.35 + vec2(-11.2, 5.8)) * 0.65
      + terrainValueNoise((OCTAVE_ROT * surfCoord) * 3.10 + vec2(8.6, -14.4)) * 0.35;
    float ridgeFactor = clamp(hNorm * 0.58 + macroBasin * 0.42, 0.0, 1.0);
    vec3 valleyMacroTone = vec3(0.26, 0.35, 0.30);
    vec3 ridgeMacroTone  = vec3(0.60, 0.55, 0.47);
    vec3 macroColor = mix(valleyMacroTone, ridgeMacroTone, smoothstep(0.12, 0.88, ridgeFactor));
    naturalColor = mix(naturalColor, macroColor, mix(0.22, 0.48, blur));
  }

  vec3 zoneColor    = (zone < 5u) ? ZONE_COLORS[zone] : naturalColor;
  if (zone > 0u && zone < 5u) {
    vec2 gridCell = abs(fract(v_uv * 64.0) - 0.5);
    float padGrid = (1.0 - smoothstep(0.44, 0.49, max(gridCell.x, gridCell.y)))
      * (1.0 - blur * 0.9);
    zoneColor *= (0.92 + 0.08 * padGrid);
  }
  vec3 baseColor    = mix(naturalColor, zoneColor, terraformBlend * 0.72);

  // И-3.2/И-3.3: плавное тонирование водных низин и речных русел. Зеркало
  // океана канонической ячейки лежит ровно на уровне seaLevel (z == 0), врез
  // речного русла уходит ниже — условие z <= 0. Континентальные озёра выше
  // seaLevel держат зенит ровной горизонтальной площадки (isFlatWaterMirror)
  // и тонируются тем же водным градиентом SHALLOW_WATER_COLOR /
  // DEEP_WATER_COLOR, что и океан.
  if (zone == 0u && (v_worldPos.z <= 0.0 || isFlatWaterMirror)) {
    float depthBelowZero = max(0.0, -v_worldPos.z);
    float waterBlend = isFlatWaterMirror ? 1.0 : smoothstep(0.0, 3.0, depthBelowZero);
    vec3 waterColor = mix(SHALLOW_WATER_COLOR, DEEP_WATER_COLOR, smoothstep(0.0, 24.0, depthBelowZero));
    baseColor = mix(baseColor, waterColor, waterBlend * 0.92);
  }

  // Тонкая тактическая кромка ТОЛЬКО вдоль границы активного центрального гекса:
  // без широких фасок соседей, без FACET_BASE_COLOR и без 6-кольцевой сетки.
  float hexGlow = 0.0;
  float hexCoreLine = 0.0;
  if (u_focusRadiusM > 1.0) {
    hexGlow = smoothstep(hexApothem * 0.955, hexApothem * 0.996, centerHexDist)
      * (1.0 - smoothstep(hexApothem * 0.996, hexApothem * 1.045, centerHexDist));
    hexCoreLine = smoothstep(hexApothem * 0.986, hexApothem * 0.998, centerHexDist)
      * (1.0 - smoothstep(hexApothem * 0.998, hexApothem * 1.012, centerHexDist));
  }

  // Нормаль плавно сглаживается к вертикали по мере роста blur; лёгкий разворот
  // нормали (hexGlow * 0.28) действует только на тонкой кромке центрального гекса.
  vec3 N = normalize(mix(normalize(v_normal), vec3(0.0, 0.0, 1.0), blur * 0.82));
  if (u_focusRadiusM > 1.0) {
    vec3 rimNormal = normalize(vec3((v_worldPos.xy / max(dist, 1e-4)) * 0.74, 0.67));
    N = normalize(mix(N, rimNormal, hexGlow * 0.28));
  }
  float NdL = max(dot(N, u_lightDir), 0.0);
  vec3 lit  = baseColor * (u_ambientColor + vec3(NdL * 0.8));

  if (u_focusRadiusM > 1.0) {
    vec3 hexRimColor = mix(vec3(0.32, 0.78, 0.86), vec3(0.58, 0.94, 0.98), hexCoreLine);
    float hexRimWeight = clamp(hexGlow * 0.26 + hexCoreLine * 0.48, 0.0, 0.62);
    lit = mix(lit, hexRimColor, hexRimWeight);
  }

  // Воздушная дымка и туман начинаются только за пределами активного гекса;
  // рельеф рендерится непрозрачно (alpha = 1.0) встык с куполом неба.
  float outsideHex = (u_focusRadiusM > 1.0)
    ? smoothstep(hexApothem * 0.98, hexApothem * 1.15, centerHexDist)
    : 1.0;
  vec3 finalColor;
  if (u_focusRadiusM > 1.0) {
    float haze = smoothstep(0.0, 0.72, v_fog) * 0.68 * outsideHex;
    vec3 hazed = mix(lit, u_horizonColor, haze);
    finalColor = mix(hazed, u_fogColor, smoothstep(0.35, 0.98, v_fog) * outsideHex);
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
uniform float u_skyAlpha;        // 1 — непрозрачный купол (по умолчанию)

out vec4 fragColor;

float skyHash2D(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Тонкое звёздное поле в мировых координатах луча (проекция на грани куба). */
float skyStars(vec3 dir) {
  vec3 a = abs(dir);
  vec2 uv;
  float face;
  if (a.z >= a.x && a.z >= a.y) {
    uv = dir.xy / max(a.z, 1e-4);
    face = dir.z >= 0.0 ? 1.0 : 2.0;
  } else if (a.x >= a.y) {
    uv = dir.yz / max(a.x, 1e-4);
    face = dir.x >= 0.0 ? 3.0 : 4.0;
  } else {
    uv = dir.xz / max(a.y, 1e-4);
    face = dir.y >= 0.0 ? 5.0 : 6.0;
  }
  vec2 grid = uv * 46.0 + face * 37.0;
  vec2 cell = floor(grid);
  vec2 f = fract(grid);
  float h1 = skyHash2D(cell);
  if (h1 < 0.915) return 0.0;
  float h2 = skyHash2D(cell + vec2(19.7, 41.3));
  vec2 starCenter = vec2(0.24, 0.24) + 0.52 * vec2(fract(h1 * 31.7), h2);
  float d = length(f - starCenter);
  float brightness = smoothstep(0.915, 0.998, h1);
  return (1.0 - smoothstep(0.02, 0.14, d)) * (0.35 + 0.65 * brightness);
}

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

  // Небо: глубокий синий космос в зените → атмосферный лимб у горизонта.
  vec3 deepSpace = u_fogColor * 0.55;
  float skyT = smoothstep(horizonAngle, horizonAngle + 0.85, beta);
  vec3 sky = mix(u_horizonColor, deepSpace, skyT);

  // Мягкий солнечный ореол по u_lightDir и звёзды в высоком зените.
  float sunDot = max(dot(ray, normalize(u_lightDir)), 0.0);
  float halo = pow(sunDot, 18.0) * 0.5 + pow(sunDot, 90.0) * 0.9;
  float starMask = skyT * skyT * (1.0 - smoothstep(0.35, 0.85, sunDot));
  sky += vec3(0.84, 0.91, 1.0) * (skyStars(ray) * starMask * 0.85);
  sky += vec3(1.0, 0.86, 0.62) * halo;

  // Диск планеты ниже линии горизонта: плотная дымка, в которую без шва
  // уходит сферическая юбка горизонта рельефа.
  float diskT = smoothstep(horizonAngle - 0.12, horizonAngle, beta);
  vec3 disk = mix(u_fogColor, u_horizonColor, diskT);
  float above = smoothstep(horizonAngle - 0.12, horizonAngle + 0.08, beta);

  vec3 color = mix(disk, sky, above);
  fragColor = vec4(color, clamp(u_skyAlpha, 0.0, 1.0));
}
`;

/* Planet spike — сцена тестовой страницы /planet-test/ (Этап 1).
   WebGL2-глобус поверх GeodesicGrid + PlanetNoise: вращение, пикинг ячейки,
   каскадная анимация сборки (uBuild в вершинном шейдере), статистика полей
   и замеры. Боевой код сайта этот файл не использует.
   Правила мыши — как у карт сайта: тащат левая кнопка и колесо,
   при event.button > 1 обработчики выходят. */
(function () {
  'use strict';

  var GeodesicGrid = window.GeodesicGrid;
  var PlanetNoise = window.PlanetNoise;
  var PlanetGeometry = window.PlanetGeometry;
  var canvas = document.getElementById('globe');
  var statsBox = document.getElementById('statsBox');
  var statusLine = document.getElementById('statusLine');
  var cellInfo = document.getElementById('cellInfo');
  var fpsEl = document.getElementById('fps');
  var cellsEl = document.getElementById('cells');
  var trisEl = document.getElementById('tris');
  var lodHudEl = document.getElementById('lodHud');
  var renderScaleEl = document.getElementById('renderScale');

  var gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) {
    statusLine.textContent = 'WebGL2 недоступен в этом браузере — спайк требует WebGL2 (fallback будет отдельной задачей).';
    statsBox.textContent = 'WebGL2: нет';
    return;
  }

  /* ------------------------------------------------------------ шейдеры */

  var VS = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'layout(location=1) in vec3 aColor;',
    'layout(location=2) in float aCenterW;',
    'layout(location=3) in vec3 aCenter;',
    'layout(location=4) in float aBirth;',
    // Байтовый vec4 полей ячейки: relief / влажность / температура / хэш.
    // Нужен только render-кастомизации и не влияет на географию.
    'layout(location=7) in vec4 aField;',
    'uniform mat4 uMvp;',
    'uniform mat4 uModel;',
    'uniform float uScale;',
    'uniform float uBuild;',
    'layout(location=5) in float aShard;',
    'uniform sampler2D uShardTex;',
    'uniform float uSep;',
    'uniform float uHide;',
    'uniform float uCenterGrow;',
    'uniform float uShardMode;',
    // Трансформ осколка на GPU: строки текстуры — pivot / ось / дрейф /
    // (spin, a, b), где фактический разлёт осколка sepEff = uSep*a + b
    // (потерянные: a=1.35, b=0.75). Разлёт — юниформ: анимация без пересборки.
    'vec3 shardTransform(vec3 p, float sf) {',
    '  int si = int(sf + 0.5);',
    '  vec3 pivot = texelFetch(uShardTex, ivec2(si, 0), 0).xyz;',
    '  vec3 axis = texelFetch(uShardTex, ivec2(si, 1), 0).xyz;',
    '  vec3 drift = texelFetch(uShardTex, ivec2(si, 2), 0).xyz;',
    '  vec3 par = texelFetch(uShardTex, ivec2(si, 3), 0).xyz;',
    '  float sepEff = uSep * par.y + par.z;',
    '  float ang = min(sepEff, 1.2) * par.x;',
    '  float ca = cos(ang);',
    '  float sa = sin(ang);',
    '  vec3 v = p - pivot;',
    '  vec3 r = v * ca + cross(axis, v) * sa + axis * dot(axis, v) * (1.0 - ca);',
    '  return pivot + r + drift * sepEff;',
    '}',
    'out vec3 vColor;',
    'out vec3 vNormal;',
    'out float vCenterW;',
    'out float vFlash;',
    'out vec3 vObj;',
    'out vec4 vField;',
    'void main() {',
    // Каскадная сборка: aBirth — момент старта ячейки (0 у северного полюса),
    // посадка одной ячейки длится 0.22 от всей анимации. При uBuild=1 — покой.
    '  float t = clamp((uBuild - aBirth) / 0.22, 0.0, 1.0);',
    '  float inv = 1.0 - t;',
    '  float ease = 1.0 - inv * inv * inv;',
    // Лёгкий overshoot масштаба («щёлк» детали конструктора): 0 → ~1.03 → 1.
    '  float cellScale = 1.0 - 2.0 * inv * inv * inv + inv * inv;',
    '  float lift = (1.0 - ease) * 0.38;',
    '  vec3 base = aCenter * (1.0 + lift) + (aPos - aCenter) * cellScale;',
    // Уходящий слой при подмене прокси финалом: та же волна рождения сжимает
    // ячейку в её центр (финал под ней к этому моменту уже сел).
    '  if (uHide > 0.0) {',
    '    float th = clamp((uHide - aBirth) / 0.22, 0.0, 1.0);',
    '    base = aCenter + (base - aCenter) * (1.0 - th * th);',
    '  }',
    // Подмена прокси финалом: финал не спускается снаружи (точки взлёта
    // x1.38), а выходит из центра планеты. Берём финальную позу вершины,
    // применяем трансформ осколка и уже результат гомотетично тянем из
    // начала координат по той же волне birth: плитка стартует точкой в
    // центре и садится ровно на место уходящей плитки прокси.
    '  if (uCenterGrow > 0.5) base = aPos;',
    '  vec3 bp = base;',
    '  if (uShardMode > 0.5) bp = shardTransform(base, aShard);',
    '  if (uCenterGrow > 0.5) bp *= ease;',
    '  vec3 p = bp * uScale;',
    '  vNormal = normalize(mat3(uModel) * normalize(aPos));',
    '  vColor = aColor;',
    '  vCenterW = aCenterW;',
    '  vFlash = 1.0 - ease;',
    '  vObj = normalize(aPos);',
    '  vField = aField;',
    '  gl_Position = uMvp * vec4(p, 1.0);',
    '}'
  ].join('\n');

  var FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vColor;',
    'in vec3 vNormal;',
    'in float vCenterW;',
    'in float vFlash;',
    'in vec3 vObj;',
    'in vec4 vField;',
    'uniform vec3 uSunDir;',
    'uniform float uBorder;',
    'uniform float uHighlight;',
    'uniform float uShardMode;',
    'uniform float uPalette;',
    'uniform float uTexMode;',
    'uniform float uTexAmount;',
    'uniform float uTexScale;',
    'uniform float uHueShift;',
    'uniform vec3 uTexSeed;',
    'out vec4 fragColor;',
    // Декоративный GPU-шум только для фактуры поверхности. Он не является
    // источником географии: берег, биом и адрес ячейки задают CPU-поля.
    'float hash13(vec3 p) {',
    '  p = fract(p * 0.1031);',
    '  p += dot(p, p.zyx + 31.32);',
    '  return fract((p.x + p.y) * p.z);',
    '}',
    'float vnoise(vec3 p) {',
    '  vec3 i = floor(p);',
    '  vec3 f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float n000 = hash13(i);',
    '  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));',
    '  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));',
    '  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));',
    '  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));',
    '  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));',
    '  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));',
    '  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));',
    '  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),',
    '             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);',
    '}',
    'float fbm3(vec3 p) {',
    '  return vnoise(p) * 0.55 + vnoise(p * 2.13) * 0.30 + vnoise(p * 4.41) * 0.15;',
    '}',
    'vec3 hueRotate(vec3 c, float a) {',
    '  if (abs(a) < 0.001) return c;',
    '  vec3 k = vec3(0.577350269);',
    '  float ca = cos(a);',
    '  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);',
    '}',
    'vec3 paletteColor(vec3 base, vec4 f) {',
    '  if (uPalette < 0.5) return base;',
    '  float relief = f.x * 2.0 - 1.0;',
    '  float depth = clamp(-relief, 0.0, 1.0);',
    '  float landH = clamp(relief, 0.0, 1.0);',
    '  float moist = f.y;',
    '  float temp = f.z;',
    '  bool ocean = relief < 0.0;',
    '  if (uPalette < 1.5) {',
    '    vec3 oc = mix(vec3(0.05, 0.30, 0.33), vec3(0.01, 0.07, 0.16), smoothstep(0.04, 0.82, depth));',
    '    vec3 land = mix(vec3(0.80, 0.62, 0.31), vec3(0.56, 0.34, 0.19), smoothstep(0.22, 0.88, landH));',
    '    land = mix(land, vec3(0.40, 0.48, 0.21), smoothstep(0.62, 0.92, moist) * 0.55);',
    '    land = mix(land, vec3(0.90, 0.84, 0.69), smoothstep(0.86, 1.0, landH));',
    '    land = mix(land, vec3(0.93, 0.91, 0.83), (1.0 - smoothstep(0.05, 0.18, temp)) * 0.65);',
    '    return ocean ? oc : land;',
    '  }',
    '  if (uPalette < 2.5) {',
    '    vec3 oc = mix(vec3(0.10, 0.55, 0.72), vec3(0.01, 0.10, 0.28), smoothstep(0.03, 0.80, depth));',
    '    oc = mix(oc, vec3(0.88, 0.95, 1.0), (1.0 - smoothstep(0.06, 0.20, temp)) * 0.82);',
    '    vec3 land = mix(vec3(0.68, 0.82, 0.92), vec3(0.96, 0.99, 1.0), smoothstep(0.15, 0.95, landH));',
    '    land = mix(land, vec3(0.36, 0.55, 0.62), smoothstep(0.55, 0.95, moist) * 0.35);',
    '    land = mix(land, vec3(1.0), (1.0 - smoothstep(0.10, 0.30, temp)) * 0.55);',
    '    return ocean ? oc : land;',
    '  }',
    '  if (uPalette < 3.5) {',
    '    vec3 oc = mix(vec3(0.10, 0.05, 0.06), vec3(0.015, 0.012, 0.025), smoothstep(0.03, 0.82, depth));',
    '    vec3 land = mix(vec3(0.16, 0.10, 0.09), vec3(0.48, 0.18, 0.09), smoothstep(0.18, 0.92, landH));',
    '    land = mix(land, vec3(0.85, 0.32, 0.07), smoothstep(0.55, 0.92, temp) * 0.55);',
    '    land = mix(land, vec3(0.40, 0.37, 0.34), smoothstep(0.78, 1.0, landH) * 0.55);',
    '    return ocean ? oc : land;',
    '  }',
    '  if (uPalette < 4.5) {',
    '    vec3 oc = mix(vec3(0.05, 0.65, 0.72), vec3(0.005, 0.16, 0.48), smoothstep(0.03, 0.82, depth));',
    '    vec3 land = mix(vec3(0.76, 0.68, 0.38), vec3(0.08, 0.52, 0.25), smoothstep(0.34, 0.78, moist));',
    '    land = mix(land, vec3(0.45, 0.43, 0.39), smoothstep(0.70, 0.95, landH) * 0.80);',
    '    land = mix(land, vec3(0.94, 0.97, 1.0), smoothstep(0.90, 1.0, landH));',
    '    return ocean ? oc : land;',
    '  }',
    '  if (uPalette < 5.5) {',
    '    vec3 oc = mix(vec3(0.35, 0.10, 0.65), vec3(0.03, 0.02, 0.22), smoothstep(0.03, 0.82, depth));',
    '    vec3 land = mix(vec3(0.10, 0.75, 0.65), vec3(0.85, 0.25, 0.90), smoothstep(0.20, 0.85, moist));',
    '    land = mix(land, vec3(0.95, 0.55, 0.20), smoothstep(0.62, 0.95, temp) * 0.45);',
    '    land = mix(land, vec3(0.90, 0.90, 1.0), smoothstep(0.82, 1.0, landH) * 0.70);',
    '    return ocean ? oc : land;',
    '  }',
    '  float lum = ocean ? (0.10 + 0.20 * (1.0 - depth)) : (0.24 + 0.58 * landH);',
    '  vec3 holo = mix(vec3(0.01, 0.10, 0.16), vec3(0.10, 0.95, 0.78), lum);',
    '  holo = mix(holo, vec3(0.75, 1.0, 0.98), (1.0 - smoothstep(0.05, 0.20, temp)) * 0.45);',
    '  return holo;',
    '}',
    'void main() {',
    '  vec3 n = normalize(vNormal);',
    '  vec3 dir = normalize(vObj);',
    '  float diff = 0.38 + 0.62 * max(dot(n, normalize(uSunDir)), 0.0);',
    '  vec3 albedo = hueRotate(paletteColor(vColor, vField), uHueShift);',
    '  float relief = vField.x * 2.0 - 1.0;',
    '  float landMask = smoothstep(-0.015, 0.015, relief);',
    '  float oceanMask = 1.0 - landMask;',
    '  vec3 emissive = vec3(0.0);',
    '  float amount = clamp(uTexAmount, 0.0, 1.0);',
    '  if (amount > 0.001 && uTexMode > 0.5) {',
    '    vec3 p = dir * max(uTexScale, 0.1) + uTexSeed;',
    '    float n1 = fbm3(p);',
    '    float n2 = vnoise(p * 3.7 + uTexSeed * 1.31 + vec3(17.7, 9.2, 4.3));',
    '    float cellTone = 0.96 + 0.08 * vField.w;',
    '    if (uTexMode < 1.5) {',
    '      float grain = mix(0.80, 1.20, n1) * mix(0.92, 1.08, n2) * cellTone;',
    '      albedo *= mix(1.0, grain, amount * (0.35 + 0.65 * landMask));',
    '      albedo = mix(albedo, albedo * vec3(1.05, 0.99, 0.90), amount * smoothstep(0.68, 0.96, n2) * landMask * 0.35);',
    '    } else if (uTexMode < 2.5) {',
    '      float bands = 0.5 + 0.5 * sin((dir.x * 1.7 - dir.y * 2.3 + dir.z * 1.1) * uTexScale * 2.2 + n1 * 9.0);',
    '      float dry = landMask * (1.0 - smoothstep(0.34, 0.74, vField.y));',
    '      float duneMask = max(dry, oceanMask * 0.32);',
    '      albedo *= mix(1.0, mix(0.86, 1.16, bands), amount * duneMask);',
    '      albedo = mix(albedo, albedo * vec3(1.09, 1.02, 0.84), amount * dry * smoothstep(0.72, 0.98, bands) * 0.45);',
    '    } else if (uTexMode < 3.5) {',
    '      float ridge = 1.0 - abs(n1 * 2.0 - 1.0);',
    '      float line = smoothstep(0.86, 0.995, ridge) * (0.55 + 0.45 * n2);',
    '      float hot = smoothstep(0.54, 0.86, vField.z);',
    '      float cold = 1.0 - smoothstep(0.16, 0.38, vField.z);',
    '      vec3 crackCol = mix(vec3(0.045, 0.032, 0.026), vec3(1.0, 0.36, 0.05), hot);',
    '      crackCol = mix(crackCol, vec3(0.72, 0.90, 1.0), cold * 0.82);',
    '      float crackMask = max(landMask, cold * oceanMask * 0.85);',
    '      albedo = mix(albedo, crackCol, clamp(amount * line * crackMask, 0.0, 0.92));',
    '      emissive += vec3(1.0, 0.34, 0.04) * line * amount * hot * landMask * 0.90;',
    '    } else if (uTexMode < 4.5) {',
    '      float patchMask = smoothstep(0.60, 0.84, n1);',
    '      float spark = smoothstep(0.93, 0.995, n2);',
    '      vec3 accent = (uPalette > 4.5 && uPalette < 5.5) ? vec3(0.95, 0.35, 1.0) : vec3(0.22, 0.95, 0.78);',
    '      albedo = mix(albedo, accent, amount * patchMask * landMask * 0.38);',
    '      albedo += accent * spark * amount * landMask * 0.38;',
    '    } else {',
    '      float lat = 0.5 + 0.5 * sin(dir.y * uTexScale * 6.28318 + n1 * 2.0);',
    '      float tri = max(max(abs(sin(dir.x * uTexScale * 2.0)), abs(sin(dir.y * uTexScale * 2.0))), abs(sin(dir.z * uTexScale * 2.0)));',
    '      float gridLine = max(smoothstep(0.965, 1.0, lat), smoothstep(0.985, 1.0, tri));',
    '      float scan = 0.94 + 0.06 * sin(dir.y * uTexScale * 24.0);',
    '      albedo *= mix(1.0, scan, amount * 0.45);',
    '      albedo = mix(albedo, vec3(0.32, 1.0, 0.90), amount * gridLine * 0.55);',
    '    }',
    '  }',
    '  albedo = clamp(albedo, vec3(0.0), vec3(1.4));',
    '  vec3 col = albedo * diff + emissive;',
    // vCenterW = 1 в центре ячейки и 0 на внешнем ребре веера.
    '  float edge = 1.0 - smoothstep(0.02, 0.14, vCenterW);',
    '  col = mix(col, vec3(0.45, 1.0, 0.88), edge * uBorder * 0.28);',
    // Изнанка осколка: тёмная порода со светящейся кромкой разлома.
    '  if (!gl_FrontFacing && uShardMode > 0.5) {',
    '    float diffB = 0.35 + 0.65 * max(dot(-n, normalize(uSunDir)), 0.0);',
    '    col = vec3(0.16, 0.09, 0.06) * diffB + vec3(0.85, 0.32, 0.06) * edge * 0.55;',
    '  }',
    // Голографическая вспышка, пока ячейка садится на сферу.
    '  col = mix(col, vec3(0.55, 1.0, 0.92), vFlash * 0.38);',
    '  col = mix(col, vec3(1.0), uHighlight * 0.55);',
    '  fragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');
  var VS_ATMO = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'uniform mat4 uMvp;',
    'uniform mat4 uModel;',
    'uniform float uScale;',
    'out vec3 vNormal;',
    'out vec3 vWorldPos;',
    'void main() {',
    '  vec4 wp = uModel * vec4(aPos * uScale, 1.0);',
    '  vWorldPos = wp.xyz;',
    '  vNormal = normalize(mat3(uModel) * normalize(aPos));',
    '  gl_Position = uMvp * vec4(aPos * uScale, 1.0);',
    '}'
  ].join('\n');

  var FS_ATMO = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vNormal;',
    'in vec3 vWorldPos;',
    'uniform vec3 uCamPos;',
    'uniform float uBuild;',
    'uniform float uFade;',
    'out vec4 fragColor;',
    'void main() {',
    '  vec3 viewDir = normalize(uCamPos - vWorldPos);',
    '  float fres = pow(1.0 - abs(dot(normalize(vNormal), viewDir)), 3.0);',
    // Атмосфера включается в конце сборки планеты.
    '  float on = smoothstep(0.7, 1.0, uBuild);',
    '  fragColor = vec4(vec3(0.15, 0.75, 0.85) * fres * 0.9 * on * uFade, fres * 0.85 * on * uFade);',
    '}'
  ].join('\n');

  var VS_CORE = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'uniform mat4 uMvp;',
    'uniform mat4 uModel;',
    'uniform float uScale;',
    'out vec3 vNormal;',
    'out vec3 vObj;',
    'void main() {',
    '  vObj = aPos;',
    '  vNormal = normalize(mat3(uModel) * normalize(aPos));',
    '  gl_Position = uMvp * vec4(aPos * uScale, 1.0);',
    '}'
  ].join('\n');

  var FS_CORE = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vNormal;',
    'in vec3 vObj;',
    'uniform vec3 uSunDir;',
    'out vec4 fragColor;',
    // Декоративный GPU-шум только для вида лавовых трещин ядра (не авторитетный).
    'float hash13(vec3 p) {',
    '  p = fract(p * 0.1031);',
    '  p += dot(p, p.zyx + 31.32);',
    '  return fract((p.x + p.y) * p.z);',
    '}',
    'float vnoise(vec3 p) {',
    '  vec3 i = floor(p);',
    '  vec3 f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float n000 = hash13(i);',
    '  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));',
    '  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));',
    '  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));',
    '  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));',
    '  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));',
    '  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));',
    '  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));',
    '  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),',
    '             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);',
    '}',
    'void main() {',
    '  vec3 dir = normalize(vObj);',
    '  float n = vnoise(dir * 7.0) * 0.65 + vnoise(dir * 15.0) * 0.35;',
    '  float crack = 1.0 - smoothstep(0.0, 0.16, abs(n - 0.5));',
    '  float diff = 0.35 + 0.65 * max(dot(normalize(vNormal), normalize(uSunDir)), 0.0);',
    '  vec3 rock = vec3(0.10, 0.06, 0.05) * diff;',
    '  vec3 lava = mix(vec3(0.85, 0.25, 0.03), vec3(1.0, 0.72, 0.25), crack);',
    '  fragColor = vec4(rock + lava * crack * 1.6, 1.0);',
    '}'
  ].join('\n');

  var VS_VOLUME = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'layout(location=1) in vec3 aColor;',
    'layout(location=2) in float aEmissive;',
    'layout(location=3) in vec3 aCenter;',
    'layout(location=4) in float aBirth;',
    'layout(location=6) in float aKind;', // 0 — стена разлома, 1 — нижняя оболочка
    'uniform mat4 uMvp;',
    'uniform mat4 uModel;',
    'uniform float uScale;',
    'uniform float uBuild;',
    'layout(location=5) in float aShard;',
    'uniform sampler2D uShardTex;',
    'uniform float uSep;',
    'uniform float uHide;',
    'uniform float uCenterGrow;',
    'uniform float uShardMode;',
    // Трансформ осколка на GPU: строки текстуры — pivot / ось / дрейф /
    // (spin, a, b), где фактический разлёт осколка sepEff = uSep*a + b
    // (потерянные: a=1.35, b=0.75). Разлёт — юниформ: анимация без пересборки.
    'vec3 shardTransform(vec3 p, float sf) {',
    '  int si = int(sf + 0.5);',
    '  vec3 pivot = texelFetch(uShardTex, ivec2(si, 0), 0).xyz;',
    '  vec3 axis = texelFetch(uShardTex, ivec2(si, 1), 0).xyz;',
    '  vec3 drift = texelFetch(uShardTex, ivec2(si, 2), 0).xyz;',
    '  vec3 par = texelFetch(uShardTex, ivec2(si, 3), 0).xyz;',
    '  float sepEff = uSep * par.y + par.z;',
    '  float ang = min(sepEff, 1.2) * par.x;',
    '  float ca = cos(ang);',
    '  float sa = sin(ang);',
    '  vec3 v = p - pivot;',
    '  vec3 r = v * ca + cross(axis, v) * sa + axis * dot(axis, v) * (1.0 - ca);',
    '  return pivot + r + drift * sepEff;',
    '}',
    'out vec3 vColor;',
    'out float vEmissive;',
    'out float vFlash;',
    'out vec3 vWorldPos;',
    'out float vBirth;',
    'out float vKind;',
    'void main() {',
    // Каскад — та же математика, что у поверхности: объём садится вместе со своей ячейкой.
    '  float t = clamp((uBuild - aBirth) / 0.22, 0.0, 1.0);',
    '  float inv = 1.0 - t;',
    '  float ease = 1.0 - inv * inv * inv;',
    '  float cellScale = 1.0 - 2.0 * inv * inv * inv + inv * inv;',
    '  float lift = (1.0 - ease) * 0.38;',
    '  vec3 base = aCenter * (1.0 + lift) + (aPos - aCenter) * cellScale;',
    // Уходящий слой при подмене прокси финалом: та же волна рождения сжимает
    // ячейку в её центр (финал под ней к этому моменту уже сел).
    '  if (uHide > 0.0) {',
    '    float th = clamp((uHide - aBirth) / 0.22, 0.0, 1.0);',
    '    base = aCenter + (base - aCenter) * (1.0 - th * th);',
    '  }',
    // Подмена прокси финалом: финал не спускается снаружи (точки взлёта
    // x1.38), а выходит из центра планеты. Берём финальную позу вершины,
    // применяем трансформ осколка и уже результат гомотетично тянем из
    // начала координат по той же волне birth: плитка стартует точкой в
    // центре и садится ровно на место уходящей плитки прокси.
    '  if (uCenterGrow > 0.5) base = aPos;',
    '  vec3 bp = base;',
    '  if (uShardMode > 0.5) bp = shardTransform(base, aShard);',
    '  if (uCenterGrow > 0.5) bp *= ease;',
    '  vec3 p = bp * uScale;',
    '  vColor = aColor;',
    '  vEmissive = aEmissive;',
    '  vFlash = 1.0 - ease;',
    '  vBirth = aBirth;',
    '  vKind = aKind;',
    '  vWorldPos = (uModel * vec4(p, 1.0)).xyz;',
    '  gl_Position = uMvp * vec4(p, 1.0);',
    '}'
  ].join('\n');

  var FS_VOLUME = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vColor;',
    'in float vEmissive;',
    'in float vFlash;',
    'in vec3 vWorldPos;',
    'in float vBirth;',
    'in float vKind;',
    'uniform vec3 uSunDir;',
    'uniform float uBuild;',
    'uniform float uHide;',
    'out vec4 fragColor;',
    'void main() {',
    // Нижняя оболочка связывает центры РАЗНЫХ ячеек. До своей волны её
    // вершины стоят в точках взлёта (центры x1.38), и связная оболочка
    // натягивается в «призрачную сферу» вокруг ещё не собранной планеты.
    // Поэтому низ не летит отдельными плитками, а проявляется по волне:
    // фрагмент виден только там, где ячейки уже сели (birth + 0.22).
    // Стены принадлежат одной ячейке и честно летят с ней — их не режем.
    '  if (vKind > 0.5 && uBuild < vBirth + 0.22) discard;',
    '  if (vKind > 0.5 && uHide > vBirth + 0.11) discard;',
    // Плоская нормаль из производных мировой позиции — гранёная порода без атрибутов нормалей.
    '  vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));',
    '  if (!gl_FrontFacing) n = -n;',
    '  float diff = 0.32 + 0.68 * max(dot(n, normalize(uSunDir)), 0.0);',
    '  vec3 lava = mix(vec3(0.55, 0.08, 0.01), vec3(1.0, 0.55, 0.12), clamp(vEmissive, 0.0, 1.0));',
    '  lava += vec3(0.35, 0.30, 0.10) * max(vEmissive - 1.0, 0.0);',
    '  vec3 col = vColor * diff + lava * vEmissive;',
    '  col = mix(col, vec3(0.55, 1.0, 0.92), vFlash * 0.30);',
    '  fragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function program(vs, fs) {
    var pr = gl.createProgram();
    gl.attachShader(pr, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
      throw new Error('Program: ' + gl.getProgramInfoLog(pr));
    }
    return pr;
  }

  var prog = program(VS, FS);
  var progAtmo = program(VS_ATMO, FS_ATMO);
  var progCore = program(VS_CORE, FS_CORE);
  var progVol = program(VS_VOLUME, FS_VOLUME);
  var U = {
    mvp: gl.getUniformLocation(prog, 'uMvp'),
    model: gl.getUniformLocation(prog, 'uModel'),
    scale: gl.getUniformLocation(prog, 'uScale'),
    sun: gl.getUniformLocation(prog, 'uSunDir'),
    border: gl.getUniformLocation(prog, 'uBorder'),
    highlight: gl.getUniformLocation(prog, 'uHighlight'),
    build: gl.getUniformLocation(prog, 'uBuild'),
    shardMode: gl.getUniformLocation(prog, 'uShardMode'),
    sep: gl.getUniformLocation(prog, 'uSep'),
    hide: gl.getUniformLocation(prog, 'uHide'),
    centerGrow: gl.getUniformLocation(prog, 'uCenterGrow'),
    palette: gl.getUniformLocation(prog, 'uPalette'),
    texMode: gl.getUniformLocation(prog, 'uTexMode'),
    texAmount: gl.getUniformLocation(prog, 'uTexAmount'),
    texScale: gl.getUniformLocation(prog, 'uTexScale'),
    hueShift: gl.getUniformLocation(prog, 'uHueShift'),
    texSeed: gl.getUniformLocation(prog, 'uTexSeed'),
    shardTex: gl.getUniformLocation(prog, 'uShardTex')
  };
  var UA = {
    mvp: gl.getUniformLocation(progAtmo, 'uMvp'),
    model: gl.getUniformLocation(progAtmo, 'uModel'),
    scale: gl.getUniformLocation(progAtmo, 'uScale'),
    camPos: gl.getUniformLocation(progAtmo, 'uCamPos'),
    build: gl.getUniformLocation(progAtmo, 'uBuild'),
    fade: gl.getUniformLocation(progAtmo, 'uFade')
  };
  var UC = {
    mvp: gl.getUniformLocation(progCore, 'uMvp'),
    model: gl.getUniformLocation(progCore, 'uModel'),
    scale: gl.getUniformLocation(progCore, 'uScale'),
    sun: gl.getUniformLocation(progCore, 'uSunDir')
  };
  var UV = {
    mvp: gl.getUniformLocation(progVol, 'uMvp'),
    model: gl.getUniformLocation(progVol, 'uModel'),
    scale: gl.getUniformLocation(progVol, 'uScale'),
    build: gl.getUniformLocation(progVol, 'uBuild'),
    sun: gl.getUniformLocation(progVol, 'uSunDir'),
    shardMode: gl.getUniformLocation(progVol, 'uShardMode'),
    sep: gl.getUniformLocation(progVol, 'uSep'),
    hide: gl.getUniformLocation(progVol, 'uHide'),
    centerGrow: gl.getUniformLocation(progVol, 'uCenterGrow'),
    shardTex: gl.getUniformLocation(progVol, 'uShardTex')
  };

  /* ------------------------------------------------------------ математика вида */

  function mat4Perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    var out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }

  function mat4Multiply(a, b) {
    var out = new Float32Array(16);
    for (var col = 0; col < 4; col++) {
      for (var row = 0; row < 4; row++) {
        var sum = 0;
        for (var k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
        out[col * 4 + row] = sum;
      }
    }
    return out;
  }

  function mat4TranslateZ(z) {
    var out = new Float32Array(16);
    out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1; out[14] = z;
    return out;
  }

  function quatFromAxisAngle(ax, ay, az, angle) {
    var len = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    var s = Math.sin(angle / 2);
    return [(ax / len) * s, (ay / len) * s, (az / len) * s, Math.cos(angle / 2)];
  }

  function quatMultiply(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }

  function quatNormalize(q) {
    var len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
    return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
  }

  function quatRotateVec(q, v) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var ix = w * v[0] + y * v[2] - z * v[1];
    var iy = w * v[1] + z * v[0] - x * v[2];
    var iz = w * v[2] + x * v[1] - y * v[0];
    var iw = -x * v[0] - y * v[1] - z * v[2];
    return [
      ix * w + iw * -x + iy * -z - iz * -y,
      iy * w + iw * -y + iz * -x - ix * -z,
      iz * w + iw * -z + ix * -y - iy * -x
    ];
  }

  function quatToMat4(q) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2;
    var yy = y * y2, yz = y * z2, zz = z * z2;
    var wx = w * x2, wy = w * y2, wz = w * z2;
    var out = new Float32Array(16);
    out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
    out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
    out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  }

  /* ------------------------------------------------------------ состояние */

  var coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  var renderScaleBase = Math.min(window.devicePixelRatio || 1, 1.75);
  var initialRenderScale = Math.min(renderScaleBase, coarsePointer ? 1.5 : 1.75);

  var state = {
    grid: null,
    elev: null,
    moist: null,
    temp: null,
    sea: 0,
    vao: null,
    vaoAtmo: null,
    buffers: [],
    indexCount: 0,
    cellIndexStart: null,
    selected: -1,
    quat: [0, 0, 0, 1],
    dist: 3.1,
    borders: true,
    spin: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    buildAnim: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    buildStart: -1,
    buildDur: 2400,
    colors: null,
    geomBundle: null,
    fieldParams: null,
    statsArgs: null,
    shardInfo: null,
    shardSep: 0,
    shardMode: 0,
    coreScale: 0.55,
    coreVisible: false,
    shardTex: null,
    shardMaxB: 0,
    prev: null,
    swapStart: -1,
    swapDur: 1500,
    isProxy: false,
    vaoVol: null,
    volIndexCount: 0,
    atmoFade: 1,
    fieldCells: null,
    palette: 0,
    texMode: 1,
    texAmount: 0.35,
    texScale: 24,
    hueShift: 0,
    texSeed: [0, 0, 0],
    renderV: 0,
    maxV: 0,
    renderScale: initialRenderScale,
    renderScaleBase: renderScaleBase
  };
  var gridCache = new Map();
  var geomToken = 0; // инвалидация отложенного построения объёма осколков

  /* Генерация в воркере: главный поток не блокируется, и каскадная сборка
     прокси-планеты идёт во время фактической загрузки полной плотности.
     genToken отсекает устаревшие ответы воркера при быстрых изменениях. */
  var PROXY_V = 32;
  var genToken = 0;
  var workerPending = false;
  var worker = null;

  /* LOD-пирамида детализации: выбранная в панели v — потолок, а фактический
     рендер выбирается по экранному размеру гекса. Поля планеты непрерывны и
     от v не зависят, поэтому уровни — одна и та же планета на разной сетке.
     Это оптимизация рендера спайка, а не будущая каноническая плотность:
     её зафиксирует Этап 3/выбор владельца, адреса ниже — адреса текущего
     рендер-уровня. */
  var LOD_LEVELS = [16, 24, 34, 48, 64, 80, 100, 128, 160, 192];
  var lodSel = document.getElementById('lodSel');
  var lodOut = document.getElementById('lodV');
  var activeParams = null; // параметры планеты; params.v здесь — максимум
  var pendingParams = null;
  var pendingShowOpts = null;
  var lodQueuedV = 0;
  var lodQueuedOpts = null;
  var lodTimer = 0;
  var fieldCache = new Map();
  var fieldCacheCells = 0;
  var FIELD_CACHE_MAX_CELLS = 1200000;
  try {
    worker = new Worker('planet-worker.js?v=planet-spike-8');
    worker.onmessage = onWorkerMessage;
    worker.onerror = function () {
      worker = null;
      if (workerPending) {
        workerPending = false;
        try {
          var fallback = pendingParams || readParams();
          generateSync(fallback, pendingShowOpts || null);
        } catch (err) {
          statusLine.textContent = 'Ошибка генерации: ' + err.message;
        }
      }
    };
  } catch (err) {
    worker = null;
  }

  /* Каскадная сборка: прогресс 0..1 по времени; buildStart < 0 — анимации нет. */
  function buildProgress(tNow) {
    if (state.buildStart < 0) return 1;
    var p = (tNow - state.buildStart) / state.buildDur;
    if (p >= 1) { state.buildStart = -1; return 1; }
    return p < 0 ? 0 : p;
  }
  function playBuild() { state.buildStart = performance.now(); }

  function now() { return performance.now(); }

  function getGrid(v) {
    var hit = gridCache.get(v);
    if (hit) return { grid: hit, ms: 0 };
    var t = now();
    var grid = GeodesicGrid.build(v);
    var ms = now() - t;
    gridCache.set(v, grid);
    idbPutGrid(v, grid);
    return { grid: grid, ms: ms };
  }

  function cloneParams(params, v) {
    var out = {};
    Object.keys(params).forEach(function (k) { out[k] = params[k]; });
    out.v = v;
    return out;
  }

  function fieldCacheKey(params) {
    return JSON.stringify([
      params.seedText, params.kind, params.freq, params.octaves,
      params.gain, params.warp, params.ocean, params.v
    ]);
  }

  function getCachedFields(params) {
    var key = fieldCacheKey(params);
    var hit = fieldCache.get(key);
    if (!hit) return null;
    // LRU: недавно использованный уровень переживает чистку дольше.
    fieldCache.delete(key);
    fieldCache.set(key, hit);
    return hit;
  }

  function cacheFields(params, d) {
    if (!params || !d || !d.elev) return;
    var key = fieldCacheKey(params);
    var old = fieldCache.get(key);
    if (old) fieldCacheCells -= old.elev.length;
    fieldCache.set(key, d);
    fieldCacheCells += d.elev.length;
    while (fieldCacheCells > FIELD_CACHE_MAX_CELLS && fieldCache.size > 1) {
      var oldestKey = fieldCache.keys().next().value;
      var oldest = fieldCache.get(oldestKey);
      fieldCache.delete(oldestKey);
      if (oldest && oldest.elev) fieldCacheCells -= oldest.elev.length;
    }
  }

  function lodEnabled() {
    return !lodSel || lodSel.value === 'auto';
  }

  function lodLevelsFor(maxV) {
    var levels = LOD_LEVELS.filter(function (v) { return v <= maxV; });
    if (!levels.length || levels[levels.length - 1] !== maxV) levels.push(maxV);
    return levels;
  }

  function cellPixelsApprox(v) {
    var h = canvas.clientHeight || window.innerHeight || 600;
    var surfaceDist = Math.max(0.55, state.dist - 1);
    // Среднее угловое расстояние центров GP(v,0) ≈ 1.107/v; пикселей на
    // радиан у ближайшей точки сферы ≈ 1.207*h/(dist-1) при FOV 45°.
    return 1.337 * h / (surfaceDist * Math.max(1, v));
  }

  function desiredRenderV(maxV) {
    if (!lodEnabled()) return maxV;
    var levels = lodLevelsFor(maxV);
    var current = state.renderV;
    if (current && levels.indexOf(current) >= 0) {
      var px = cellPixelsApprox(current);
      // Широкий гистерезис вокруг цели 11 px: уровень не должен прыгать
      // туда-сюда от мелких движений колеса около одной границы.
      if (px >= 7.5 && px <= 16.5) return current;
    }
    var h = canvas.clientHeight || window.innerHeight || 600;
    var surfaceDist = Math.max(0.55, state.dist - 1);
    var raw = 1.337 * h / (surfaceDist * 11); // целевой размер гекса ≈ 11 CSS px
    for (var i = 0; i < levels.length; i++) {
      if (levels[i] >= raw * 0.9) return levels[i];
    }
    return maxV;
  }

  function lodNote(v) {
    if (!lodEnabled() || !activeParams) return '';
    return 'рендер-LOD: v=' + v + ' из макс. v=' + activeParams.v +
      ' · поля те же, меняется только детализация гексов';
  }

  function syncLodHud(targetV) {
    var shown = state.renderV || targetV || 0;
    var lodText = shown
      ? ('v=' + shown + (activeParams ? '/' + activeParams.v : ''))
      : '—';
    var shortText = shown ? ('v=' + shown) : '';
    var scaleText = state.renderScale.toFixed(2) + '×';
    if (lodHudEl && lodHudEl.textContent !== lodText) lodHudEl.textContent = lodText;
    if (lodOut && lodOut.textContent !== shortText) lodOut.textContent = shortText;
    if (renderScaleEl && renderScaleEl.textContent !== scaleText) renderScaleEl.textContent = scaleText;
  }

  /* IndexedDB-кэш сеток: сетка зависит только от v, поэтому повторные
     визиты не перестраивают её (v=192 — минус ~2.2 с). Та же база и префикс
     формата, что в воркере; воркер — основной читатель, здесь кэш греет
     прокси/синхронный путь и флаг haveGrid (не гонять сетку postMessage'м). */
  var GRID_CACHE_PREFIX = 'gp-v0:';
  var idbPromise = null;
  function openGridDb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var req = window.indexedDB.open('planet-spike-cache', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('grids'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return idbPromise;
  }
  function idbGetGrid(v) {
    return openGridDb().then(function (db) {
      return new Promise(function (resolve) {
        var req = db.transaction('grids', 'readonly').objectStore('grids').get(GRID_CACHE_PREFIX + v);
        req.onsuccess = function () {
          var g = req.result;
          resolve(g && g.v === v && g.cellCount === 10 * v * v + 2 && g.centers ? g : null);
        };
        req.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }
  function idbPutGrid(v, grid) {
    openGridDb().then(function (db) {
      try {
        db.transaction('grids', 'readwrite').objectStore('grids').put(grid, GRID_CACHE_PREFIX + v);
      } catch (err) { /* квота/приватный режим — работаем без кэша */ }
    }).catch(function () {});
  }
  /* Фоновая подгрузка сетки из IndexedDB в память: дёшево, никому не мешает,
     а последующий getGrid/воркер-запрос этого v становится мгновенным. */
  function prefetchGrid(v) {
    if (gridCache.has(v)) return;
    idbGetGrid(v).then(function (g) { if (g && !gridCache.has(v)) gridCache.set(v, g); });
  }

  function weightedQuantile(values, weights, q) {
    var idx = new Array(values.length);
    var i;
    for (i = 0; i < idx.length; i++) idx[i] = i;
    idx.sort(function (a, b) { return values[a] - values[b]; });
    var total = 0;
    for (i = 0; i < weights.length; i++) total += weights[i];
    var target = total * q;
    var acc = 0;
    for (i = 0; i < idx.length; i++) {
      acc += weights[idx[i]];
      if (acc >= target) return values[idx[i]];
    }
    return values[idx[idx.length - 1]];
  }

  function landmassStats(grid, elev, sea) {
    var F = grid.cellCount;
    var visited = new Uint8Array(F);
    var sizes = [];
    var landCells = 0;
    var stack = [];
    for (var c = 0; c < F; c++) {
      if (visited[c] || elev[c] <= sea) continue;
      var size = 0;
      stack.length = 0;
      stack.push(c);
      visited[c] = 1;
      while (stack.length) {
        var u = stack.pop();
        size++;
        landCells++;
        for (var n = 0; n < grid.neighborCount[u]; n++) {
          var v = grid.neighbors[u * 6 + n];
          if (!visited[v] && elev[v] > sea) { visited[v] = 1; stack.push(v); }
        }
      }
      sizes.push(size);
    }
    sizes.sort(function (a, b) { return a - b; });
    function pct(p) { return sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] : 0; }
    return {
      count: sizes.length,
      landCells: landCells,
      median: pct(0.5),
      p90: pct(0.9),
      max: sizes.length ? sizes[sizes.length - 1] : 0
    };
  }

  function fieldsHash(elev) {
    var h = 0x811c9dc5;
    for (var i = 0; i < elev.length; i++) {
      h ^= (Math.round(elev[i] * 1e5) & 0xffff);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  function biomeName(e, sea, minE, maxE, moist, temp) {
    if (e <= sea) {
      if (temp < 0.14) return 'морской лёд';
      return (sea - e) / Math.max(1e-6, sea - minE) < 0.15 ? 'шельф' : 'океан';
    }
    var landH = clamp01((e - sea) / Math.max(1e-6, maxE - sea));
    if (temp < 0.14 || landH > 0.93) return 'лёд/снег';
    if (landH > 0.72) return 'горы';
    if (temp < 0.3) return 'тундра';
    if (moist < 0.34) return 'пустыня';
    if (moist > 0.62) return 'лес';
    return 'равнина';
  }

  /* ------------------------------------------------------------ геометрия GPU */

  /* Геометрия живёт бандлами VAO/буферов. Новый бандл можно собрать и
     залить рядом с текущим, не трогая кадр на экране; commit — мгновенная
     смена указателей и только тогда старт волны перекрытия. Неактивные
     бандлы последних планет/LOD держим в маленьком LRU-кэше: частые
     переходы туда-сюда не должны пересобирать одни и те же вершины. */
  var geometryCache = new Map();
  var geometryCacheBytes = 0;
  var GEOMETRY_CACHE_MAX_BYTES = (coarsePointer ? 72 : 128) * 1048576;

  function disposeBundle(bundle) {
    if (!bundle) return;
    if (bundle.key && geometryCache.get(bundle.key) === bundle) {
      geometryCache.delete(bundle.key);
      geometryCacheBytes -= bundle.gpuBytes || 0;
    }
    bundle.buffers.forEach(function (b) { gl.deleteBuffer(b); });
    bundle.buffers = [];
    if (bundle.vao) gl.deleteVertexArray(bundle.vao);
    if (bundle.vaoAtmo) gl.deleteVertexArray(bundle.vaoAtmo);
    if (bundle.vaoVol) gl.deleteVertexArray(bundle.vaoVol);
    bundle.vao = null;
    bundle.vaoAtmo = null;
    bundle.vaoVol = null;
    if (bundle.shardTex) { gl.deleteTexture(bundle.shardTex); bundle.shardTex = null; }
    bundle.uploadJobs = [];
  }

  function stashGeometry(bundle) {
    if (!bundle) return;
    if (!bundle.key || !bundle.complete || (bundle.gpuBytes || 0) > GEOMETRY_CACHE_MAX_BYTES) {
      disposeBundle(bundle);
      return;
    }
    var existing = geometryCache.get(bundle.key);
    if (existing === bundle) return;
    if (existing) {
      geometryCache.delete(bundle.key);
      geometryCacheBytes -= existing.gpuBytes || 0;
      disposeBundle(existing);
    }
    geometryCache.set(bundle.key, bundle);
    geometryCacheBytes += bundle.gpuBytes || 0;
    while (geometryCacheBytes > GEOMETRY_CACHE_MAX_BYTES && geometryCache.size > 1) {
      var oldestKey = geometryCache.keys().next().value;
      var oldest = geometryCache.get(oldestKey);
      geometryCache.delete(oldestKey);
      geometryCacheBytes -= (oldest && oldest.gpuBytes) || 0;
      disposeBundle(oldest);
    }
  }

  function releaseBundle(bundle, allowCache) {
    if (!bundle) return;
    if (allowCache) stashGeometry(bundle);
    else disposeBundle(bundle);
  }

  function releasePrev() {
    var pv = state.prev;
    if (!pv) return;
    state.prev = null;
    releaseBundle(pv, true);
  }

  function peekCachedGeometry(key) {
    if (!key) return null;
    var hit = geometryCache.get(key);
    if (!hit) return null;
    geometryCache.delete(key);
    geometryCache.set(key, hit);
    return hit;
  }

  function removeCachedGeometry(bundle) {
    if (!bundle || !bundle.key) return;
    if (geometryCache.get(bundle.key) !== bundle) return;
    geometryCache.delete(bundle.key);
    geometryCacheBytes -= bundle.gpuBytes || 0;
  }

  function geometryCacheKey(params, sp) {
    if (!params || !sp) return '';
    return fieldCacheKey(params) + '|planet-geom-1|' + JSON.stringify([
      sp.count, sp.dist, sp.thick, sp.jag, sp.loss, sp.seedText
    ]);
  }

  function readShardParams() {
    var countEl = document.getElementById('shards');
    var distEl = document.getElementById('shardDist');
    var sepEl = document.getElementById('shardSep');
    var seedEl = document.getElementById('seedText');
    var thickEl = document.getElementById('shardThick');
    var jagEl = document.getElementById('shardJag');
    var lossEl = document.getElementById('shardLoss');
    return {
      count: countEl ? parseInt(countEl.value, 10) : 1,
      dist: distEl ? distEl.value : 'power',
      sep: sepEl ? parseFloat(sepEl.value) : 0,
      thick: thickEl ? parseFloat(thickEl.value) : 0.14,
      jag: jagEl ? parseFloat(jagEl.value) : 0.5,
      loss: lossEl ? parseFloat(lossEl.value) : 0,
      seedText: seedEl ? seedEl.value : 'planet'
    };
  }

  function allocateBundleBuffer(bundle, target, data, vao) {
    var buf = gl.createBuffer();
    bundle.buffers.push(buf);
    if (vao) gl.bindVertexArray(vao);
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data.byteLength, gl.STATIC_DRAW);
    bundle.uploadJobs.push({
      target: target, buffer: buf, data: data, offset: 0, vao: vao || null
    });
    bundle.uploadDone = false;
    return buf;
  }

  function bundleAttr(bundle, location, size, data, type, normalized) {
    var buf = allocateBundleBuffer(bundle, gl.ARRAY_BUFFER, data, null);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, type || gl.FLOAT, !!normalized, 0, 0);
    return buf;
  }

  function uploadBundleSlice(bundle, byteBudget) {
    var spent = 0;
    while (bundle.uploadJobs.length) {
      if (byteBudget !== Infinity && spent >= byteBudget) break;
      var job = bundle.uploadJobs[0];
      var bpe = job.data.BYTES_PER_ELEMENT || 1;
      var remaining = job.data.length - job.offset;
      var count = remaining;
      if (byteBudget !== Infinity) {
        count = Math.min(remaining, Math.max(1, Math.floor((byteBudget - spent) / bpe)));
      }
      if (job.target === gl.ELEMENT_ARRAY_BUFFER) gl.bindVertexArray(job.vao);
      else gl.bindVertexArray(null);
      gl.bindBuffer(job.target, job.buffer);
      gl.bufferSubData(
        job.target,
        job.offset * bpe,
        job.data.subarray(job.offset, job.offset + count)
      );
      job.offset += count;
      spent += count * bpe;
      if (job.offset >= job.data.length) bundle.uploadJobs.shift();
    }
    gl.bindVertexArray(null);
    bundle.uploadDone = bundle.uploadJobs.length === 0;
    return bundle.uploadDone;
  }

  function finishBundleUpload(bundle) {
    uploadBundleSlice(bundle, Infinity);
  }

  function addVolumeToBundle(bundle, volume) {
    if (!volume) return;
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    bundleAttr(bundle, 0, 3, volume.positions);
    bundleAttr(bundle, 1, 3, volume.colors);
    bundleAttr(bundle, 2, 1, volume.emissive);
    bundleAttr(bundle, 3, 3, volume.centers);
    bundleAttr(bundle, 4, 1, volume.birth);
    bundleAttr(bundle, 5, 1, volume.shard);
    bundleAttr(bundle, 6, 1, volume.kind);
    allocateBundleBuffer(bundle, gl.ELEMENT_ARRAY_BUFFER, volume.indices, vao);
    gl.bindVertexArray(null);
    bundle.vaoVol = vao;
    bundle.volIndexCount = volume.indexCount;
    bundle.gpuBytes += volume.positions.byteLength + volume.colors.byteLength +
      volume.emissive.byteLength + volume.centers.byteLength + volume.birth.byteLength +
      volume.shard.byteLength + volume.kind.byteLength + volume.indices.byteLength;
  }

  function createGeometryBundle(grid, payload, sp, key) {
    var s = payload.surface;
    var bundle = {
      key: key || '',
      buffers: [],
      vao: null,
      vaoAtmo: null,
      vaoVol: null,
      shardTex: null,
      indexCount: s.indexCount,
      volIndexCount: 0,
      cellIndexStart: s.cellIndexStart,
      vertexCount: s.vertexCount,
      gpuBytes: 0,
      shardMode: payload.shardMode,
      shardInfo: payload.shardInfo,
      shardMaxB: payload.shardMaxB,
      cellData: payload.cellData,
      complete: !payload.layout || !!payload.volume,
      uploadJobs: [],
      uploadDone: false,
      uploadMs: 0,
      volumeBuild: null
    };
    if (payload.layout && !payload.volume) {
      bundle.volumeBuild = {
        layout: payload.layout,
        sp: sp,
        positions: s.positions,
        birth: s.birth
      };
    }

    if (payload.shardTexData) {
      bundle.shardTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, bundle.shardTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 64, 4, 0, gl.RGBA, gl.FLOAT, payload.shardTexData);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    bundle.vao = gl.createVertexArray();
    gl.bindVertexArray(bundle.vao);
    bundleAttr(bundle, 0, 3, s.positions);
    bundleAttr(bundle, 1, 3, s.colors);
    bundleAttr(bundle, 2, 1, s.centerW);
    bundleAttr(bundle, 3, 3, s.centers);
    bundleAttr(bundle, 4, 1, s.birth);
    bundleAttr(bundle, 5, 1, s.shard);
    bundleAttr(bundle, 7, 4, s.field, gl.UNSIGNED_BYTE, true);
    allocateBundleBuffer(bundle, gl.ELEMENT_ARRAY_BUFFER, s.indices, bundle.vao);
    gl.bindVertexArray(null);

    bundle.vaoAtmo = gl.createVertexArray();
    gl.bindVertexArray(bundle.vaoAtmo);
    bundleAttr(bundle, 0, 3, grid.centers);
    allocateBundleBuffer(bundle, gl.ELEMENT_ARRAY_BUFFER, grid.triangles, bundle.vaoAtmo);
    gl.bindVertexArray(null);

    bundle.gpuBytes = s.positions.byteLength + s.colors.byteLength + s.centerW.byteLength +
      s.centers.byteLength + s.birth.byteLength + s.shard.byteLength + s.field.byteLength +
      s.indices.byteLength + grid.centers.byteLength + grid.triangles.byteLength;
    if (payload.volume) addVolumeToBundle(bundle, payload.volume);
    return bundle;
  }

  function applyGeometryBundle(bundle) {
    state.geomBundle = bundle;
    state.vao = bundle.vao;
    state.vaoAtmo = bundle.vaoAtmo;
    state.vaoVol = bundle.vaoVol;
    state.buffers = bundle.buffers;
    state.indexCount = bundle.indexCount;
    state.volIndexCount = bundle.volIndexCount;
    state.cellIndexStart = bundle.cellIndexStart;
    state.vertexCount = bundle.vertexCount;
    state.gpuBytes = bundle.gpuBytes;
    state.shardTex = bundle.shardTex;
    state.shardMode = bundle.shardMode;
    state.shardInfo = bundle.shardInfo;
    state.shardMaxB = bundle.shardMaxB;

    var sp = readShardParams();
    state.shardSep = sp.sep;
    state.atmoFade = bundle.shardMode ? Math.max(0, 1 - sp.sep * 2.2) : 1;
    var coreEl = document.getElementById('coreScale');
    state.coreScale = coreEl ? parseFloat(coreEl.value) : 0.55;
    state.coreVisible = bundle.shardMode === 1 && (sp.sep > 0.01 || bundle.shardMaxB > 0.01);
    trisEl.textContent = (bundle.indexCount / 3).toLocaleString('ru-RU');
  }

  function commitGeometryBundle(bundle, doSwap, cacheOld) {
    removeCachedGeometry(bundle);
    var old = state.geomBundle;
    if (state.prev && state.prev !== old) releasePrev();
    geomToken++;
    if (doSwap && old && old !== bundle) {
      state.prev = old;
      state.swapStart = performance.now();
    } else {
      state.prev = null;
      state.swapStart = -1;
      if (old && old !== bundle) releaseBundle(old, cacheOld !== false);
    }
    applyGeometryBundle(bundle);
  }

  function scheduleBundleVolume(bundle) {
    if (!bundle.volumeBuild) return;
    var token = ++geomToken;
    var buildVol = function () {
      if (token !== geomToken || state.geomBundle !== bundle || !state.grid) return;
      var info = bundle.volumeBuild;
      var volume = PlanetGeometry.buildVolumeArrays(
        state.grid, info.layout, info.sp, info.positions, info.birth, PlanetNoise);
      if (volume) addVolumeToBundle(bundle, volume);
      finishBundleUpload(bundle);
      bundle.volumeBuild = null;
      bundle.complete = true;
      applyGeometryBundle(bundle);
      if (state.statsArgs && state.statsArgs.grid === state.grid) {
        renderStats(state.lastMsGeom || 0);
      }
    };
    if (window.requestIdleCallback) window.requestIdleCallback(buildVol, { timeout: 300 });
    else window.setTimeout(buildVol, 30);
  }

  /* ------------------------------------------------------------ генерация */

  var ui = {};
  ['seedText', 'vSel', 'noiseSel', 'freq', 'oct', 'gain', 'warp', 'ocean'].forEach(function (id) {
    ui[id] = document.getElementById(id);
  });

  function readParams() {
    return {
      seedText: ui.seedText.value || 'planet',
      v: parseInt(ui.vSel.value, 10),
      kind: ui.noiseSel.value,
      freq: parseFloat(ui.freq.value),
      octaves: parseInt(ui.oct.value, 10),
      gain: parseFloat(ui.gain.value),
      warp: parseFloat(ui.warp.value),
      ocean: parseFloat(ui.ocean.value)
    };
  }

  /* Поля планеты на главном потоке — для прокси и синхронного fallback. */
  function computeFields(grid, params) {
    var t = now();
    var sampler = PlanetNoise.createSampler({
      seedText: params.seedText,
      kind: params.kind,
      freq: params.freq,
      octaves: params.octaves,
      gain: params.gain,
      warp: params.warp
    });
    var F = grid.cellCount;
    var elev = new Float32Array(F);
    var moist = new Float32Array(F);
    var temp = new Float32Array(F);
    var out = [0, 0, 0];
    var minE = Infinity, maxE = -Infinity;
    for (var c = 0; c < F; c++) {
      sampler.sample(grid.centers[c * 3], grid.centers[c * 3 + 1], grid.centers[c * 3 + 2], out);
      elev[c] = out[0]; moist[c] = out[1]; temp[c] = out[2];
      if (out[0] < minE) minE = out[0];
      if (out[0] > maxE) maxE = out[0];
    }
    return {
      elev: elev, moist: moist, temp: temp,
      sea: weightedQuantile(elev, grid.areas, params.ocean / 100),
      minE: minE, maxE: maxE, masterSeed: sampler.masterSeed,
      msFields: now() - t
    };
  }

  function withStats(grid, d) {
    var t = now();
    d.stats = landmassStats(grid, d.elev, d.sea);
    d.msStats = now() - t;
    return d;
  }

  /* Показать готовую планету: прокси, финал из воркера или синхронный путь. */
  function showPlanet(grid, d, gridLabel, note, proxyFlag, opts) {
    opts = opts || {};
    var sp = opts.shardParams || readShardParams();
    opts.shardParams = sp;
    var params = opts.params || null;
    var key = opts.geometryKey || geometryCacheKey(params, sp);
    opts.geometryKey = key;

    // Бесшовная подмена прокси финалом: прежний бандл остаётся prev-слоем,
    // новый выходит из центра планеты той же широтной волной рождения,
    // а prev следом сжимается в центры своих ячеек. Важно: commit и старт
    // волны происходят только после того, как новый бандл уже собран и
    // залит в GPU; иначе таймер перекрытия сгорал внутри синхронной
    // подготовки геометрии и на телефоне пользователь видел просто фриз.
    var doSwap = opts.swap
      ? (!!state.geomBundle && !!state.grid && state.grid !== grid)
      : (!proxyFlag && state.isProxy && !!state.geomBundle && !!state.grid && state.grid !== grid);
    var animateBuild = state.buildAnim && !opts.noBuild;

    var bundle = opts.geometryBundle || null;
    var payload = opts.geometryPayload || null;
    if (!bundle && key) {
      bundle = peekCachedGeometry(key);
      if (bundle) opts.geometryCacheHit = true;
    }

    var t = now();
    if (!bundle) {
      if (!payload) {
        payload = PlanetGeometry.buildGeometry(grid, d, sp, PlanetNoise, {
          // LOD-подмена теперь мгновенная, без волны из центров ячеек,
          // но синхронный fallback всё равно не должен блокировать первый
          // кадр объёмом осколков: он достроится сразу после commit.
          includeVolume: !(animateBuild || doSwap || opts.lod)
        });
      }
      bundle = createGeometryBundle(grid, payload, sp, key);
      finishBundleUpload(bundle);
      bundle.uploadMs = now() - t;
    } else if (!bundle.uploadDone) {
      finishBundleUpload(bundle);
    }

    var cellData = bundle.cellData || (payload && payload.cellData);
    state.isProxy = !!proxyFlag;
    state.grid = grid;
    state.renderV = grid.v;
    state.maxV = activeParams ? activeParams.v : grid.v;
    state.selected = -1;
    state.fieldParams = params;
    state.fieldCells = cellData.fieldCells;
    state.texSeed = cellData.texSeed;
    state.colors = cellData.colors;
    state.statsArgs = {
      grid: grid,
      d: d,
      gridLabel: gridLabel,
      note: note,
      msGeometryBuild: opts.msGeometryBuild,
      geometryCacheHit: !!opts.geometryCacheHit
    };

    state.swapDur = opts.swapMs || 1500;
    commitGeometryBundle(bundle, doSwap, opts.cacheOld);
    if (bundle.volumeBuild) scheduleBundleVolume(bundle);

    var msGeom = bundle.uploadMs || (now() - t);
    state.lastMsGeom = msGeom;
    if (doSwap) state.buildStart = -1; // рост финала ведёт волна подмены, не каскад
    else if (animateBuild) playBuild(); else state.buildStart = -1;

    state.elev = d.elev;
    state.moist = d.moist;
    state.temp = d.temp;
    state.sea = d.sea;
    state.minE = d.minE;
    state.maxE = d.maxE;

    cellsEl.textContent = grid.cellCount.toLocaleString('ru-RU');
    syncLodHud(grid.v);
    renderStats(msGeom);
  }

  function renderStats(msGeom) {
    var a = state.statsArgs;
    if (!a) return;
    var grid = a.grid, d = a.d, F = grid.cellCount;
    var stats = d.stats;
    var landPct = (stats.landCells / F * 100).toFixed(1);
    var maxShare = stats.landCells ? (stats.max / stats.landCells * 100).toFixed(0) : '0';
    var shardLine = '';
    if (state.shardInfo) {
      var nz = [];
      for (var i = 0; i < state.shardInfo.counts.length; i++) {
        if (state.shardInfo.counts[i] > 0) nz.push(state.shardInfo.counts[i]);
      }
      nz.sort(function (x, y) { return x - y; });
      shardLine = 'осколки: непустых ' + nz.length + ' из ' + state.shardInfo.count +
        ' · размер: мин ' + nz[0] + ' · медиана ' + nz[Math.floor(nz.length / 2)] +
        ' · макс ' + nz[nz.length - 1] + ' ячеек' +
        (state.shardInfo.lost ? ' · потеряно ' + state.shardInfo.lost : '');
    }
    var geomText;
    if (a.geometryCacheHit) geomText = 'GPU-кэш';
    else if (a.msGeometryBuild != null) {
      geomText = 'воркер ' + a.msGeometryBuild.toFixed(0) +
        ' + заливка ' + msGeom.toFixed(0) + ' мс';
    } else {
      geomText = msGeom.toFixed(0) + ' мс';
    }
    statsBox.textContent =
      (a.note ? a.note + '\n' : '') +
      'сетка: ' + a.gridLabel +
      ' · поля: ' + d.msFields.toFixed(0) + ' мс · геометрия: ' + geomText + '\n' +
      'master seed: 0x' + d.masterSeed.toString(16) + ' · хэш полей: ' + fieldsHash(d.elev) + '\n' +
      'суша: ' + landPct + '% · массивов: ' + stats.count + '\n' +
      'размер массива: медиана ' + stats.median + ' · P90 ' + stats.p90 + ' · макс ' + stats.max +
      ' (' + maxShare + '% суши)\n' +
      'геометрия: вершин ' + state.vertexCount.toLocaleString('ru-RU') +
      ' · буферы GPU ≈ ' + (state.gpuBytes / 1048576).toFixed(1) + ' МБ' +
      ' · ребро ячейки (Земля) ≈ ' + Math.sqrt(2 * (510064472 / F) / (3 * Math.sqrt(3))).toFixed(1) + ' км\n' +
      'статистика массивов: ' + d.msStats.toFixed(0) + ' мс · пятиугольников: ' + grid.pentagons +
      (shardLine ? '\n' + shardLine : '');
  }

  /* Перезаливка только геометрии (осколки): поля и цвета не пересчитываются. */
  var geomTimer = 0;
  function scheduleGeometry() {
    window.clearTimeout(geomTimer);
    geomTimer = window.setTimeout(function () {
      if (!state.grid || !state.colors || !state.statsArgs) return;
      state.selected = -1;
      var sp = readShardParams();
      var key = geometryCacheKey(state.fieldParams, sp);
      var bundle = peekCachedGeometry(key);
      var cacheHit = !!bundle;
      var t = now();
      if (!bundle) {
        var payload = PlanetGeometry.buildGeometry(state.grid, null, sp, PlanetNoise, {
          cellData: {
            colors: state.colors,
            fieldCells: state.fieldCells,
            texSeed: state.texSeed
          },
          includeVolume: true
        });
        bundle = createGeometryBundle(state.grid, payload, sp, key);
        finishBundleUpload(bundle);
        bundle.uploadMs = now() - t;
      }
      state.statsArgs.msGeometryBuild = null;
      state.statsArgs.geometryCacheHit = cacheHit;
      commitGeometryBundle(bundle, false, false);
      state.lastMsGeom = bundle.uploadMs || 0;
      renderStats(state.lastMsGeom);
    }, 120);
  }

  /* Синхронный путь без воркера: старое поведение, вкладка подвисает. */
  function generateSync(params, opts) {
    opts = opts || {};
    opts.params = params;
    if (!opts.shardParams) opts.shardParams = readShardParams();
    if (!opts.geometryKey) opts.geometryKey = geometryCacheKey(params, opts.shardParams);
    var got = getGrid(params.v);
    var d = getCachedFields(params);
    if (!d) {
      d = withStats(got.grid, computeFields(got.grid, params));
      cacheFields(params, d);
    }
    var proxyFlag = Object.prototype.hasOwnProperty.call(opts, 'proxyFlag')
      ? opts.proxyFlag
      : !!(activeParams && params.v < activeParams.v);
    showPlanet(
      got.grid,
      d,
      got.ms ? got.ms.toFixed(0) + ' мс' : 'кэш',
      opts.note || lodNote(params.v),
      proxyFlag,
      opts
    );
    statusLine.textContent = '';
  }

  function processQueuedLod(doneV) {
    if (!lodQueuedV) return;
    lodQueuedV = 0;
    lodQueuedOpts = null;
    if (!activeParams || !lodEnabled()) return;
    // Очередь — только сигнал «пока готовился уровень, камера могла уйти».
    // Сам queued-уровень к моменту commit уже может устареть, поэтому
    // цель пересчитываем от текущего renderV и дистанции, а не слепо
    // запускаем ещё одну подмену ради давно поставленного запроса.
    var desired = desiredRenderV(activeParams.v);
    if (desired !== state.renderV && desired !== doneV) {
      requestRenderV(desired);
    }
  }

  /* Воркер уже посчитал поля и массивы геометрии. Осталось залить буферы,
     но и это делаем порциями в скрытом бандле: текущий глобус/прокси и
     каскад загрузки продолжают рисоваться, а commit происходит только
     когда новый VAO полностью готов. */
  function stageWorkerPlanet(grid, fieldData, msg, gridLabel, proxyFlag, opts) {
    var bundle;
    try {
      bundle = createGeometryBundle(grid, msg.geometry, opts.shardParams, opts.geometryKey);
    } catch (err) {
      workerPending = false;
      pendingParams = null;
      pendingShowOpts = null;
      statusLine.textContent = 'Ошибка подготовки геометрии: ' + err.message;
      return;
    }
    var token = msg.token;
    var started = now();
    statusLine.textContent = (opts.lod ? 'LOD: ' : 'воркер: ') +
      'заливка геометрии v=' + msg.v + '…';

    function step() {
      if (token !== genToken) {
        disposeBundle(bundle);
        return;
      }
      var done = false;
      try {
        // Не одна порция на кадр, а временной бюджет главного потока:
        // на быстром GPU успеваем несколько мегабайт, на медленном —
        // останавливаемся после первой дорогой порции. При интерактивном
        // LOD-зуме сначала бережём кадр (6 мс); при загрузке планеты под
        // прокси/каскадом важнее общее ожидание, поэтому бюджет шире
        // (12 мс). Если заливка уже затянулась, расширяем бюджет: короткая
        // просадка под явной загрузкой лучше нескольких секунд ожидания.
        var elapsed = now() - started;
        var budgetMs = opts.lod
          ? (elapsed > 600 ? 16 : 6)
          : (elapsed > 600 ? 24 : 12);
        var deadline = now() + budgetMs;
        while (!done && now() < deadline) {
          done = uploadBundleSlice(bundle, 524288);
        }
      } catch (err) {
        disposeBundle(bundle);
        workerPending = false;
        pendingParams = null;
        pendingShowOpts = null;
        statusLine.textContent = 'Ошибка заливки геометрии: ' + err.message;
        return;
      }
      if (!done) {
        // Пока кадры идут нормально, заливаем перед следующим кадром.
        // Если рендер уже редкий/тяжёлый, таймер позволяет продолжить
        // между кадрами и не растягивать ожидание только из-за vsync.
        if (now() - started > 600) window.setTimeout(step, 16);
        else window.requestAnimationFrame(step);
        return;
      }

      bundle.uploadMs = now() - started;
      workerPending = false;
      pendingParams = null;
      pendingShowOpts = null;
      opts.geometryBundle = bundle;
      showPlanet(grid, fieldData, gridLabel, opts.note || lodNote(msg.v), proxyFlag, opts);
      statusLine.textContent = '';
      if (geometryCacheKey(opts.params, readShardParams()) !== bundle.key) {
        scheduleGeometry();
      }
      processQueuedLod(msg.v);
    }
    window.requestAnimationFrame(step);
  }

  function onWorkerMessage(e) {
    var msg = e.data;
    if (msg.type === 'progress') {
      if (msg.token !== genToken) return;
      var prefix = pendingShowOpts && pendingShowOpts.lod ? 'LOD-воркер: ' : 'воркер: ';
      if (msg.stage === 'grid') {
        statusLine.textContent = prefix + 'сетка v=' + msg.v + '…';
      } else if (msg.stage === 'geometry') {
        var phaseName = msg.phase === 'volume' ? 'объём осколков'
          : msg.phase === 'surface' ? 'поверхность' : 'ячейки';
        statusLine.textContent = prefix + 'геометрия: ' + phaseName + '…';
      } else {
        statusLine.textContent = prefix + 'поля ' + msg.pct + '%…';
      }
      return;
    }
    if (msg.type === 'error') {
      if (msg.token !== genToken) return;
      workerPending = false;
      worker = null;
      try {
        generateSync(pendingParams || readParams(), pendingShowOpts || null);
      } catch (err) {
        statusLine.textContent = 'Ошибка генерации: ' + err.message;
      }
      return;
    }
    if (msg.grid) gridCache.set(msg.v, msg.grid);
    if (msg.token !== genToken) return;
    var params = pendingParams;
    var opts = pendingShowOpts || {};
    var grid = gridCache.get(msg.v);
    if (!grid) {
      workerPending = false;
      pendingParams = null;
      pendingShowOpts = null;
      return;
    }

    var fresh = {};
    Object.keys(msg).forEach(function (k) {
      if (k !== 'geometry' && k !== 'grid' && k !== 'type') fresh[k] = msg[k];
    });
    var fieldData = opts.cachedFields || fresh;
    if (params && fresh.elev) {
      var cacheData = {};
      Object.keys(fresh).forEach(function (k) {
        if (k !== 'msGeometry') cacheData[k] = fresh[k];
      });
      cacheFields(params, cacheData);
      fieldData = fresh;
    }
    if (!fieldData || !fieldData.elev) {
      workerPending = false;
      pendingParams = null;
      pendingShowOpts = null;
      statusLine.textContent = 'Ошибка генерации: воркер не вернул поля';
      return;
    }

    var gridLabel = msg.gridSource === 'built' ? msg.msGrid.toFixed(0) + ' мс (воркер)'
      : msg.gridSource === 'idb' ? 'IndexedDB-кэш' : 'кэш';
    var proxyFlag = Object.prototype.hasOwnProperty.call(opts, 'proxyFlag')
      ? opts.proxyFlag
      : !!(activeParams && msg.v < activeParams.v);
    opts.params = params;
    opts.msGeometryBuild = msg.msGeometry;

    var cachedBundle = peekCachedGeometry(opts.geometryKey);
    if (cachedBundle) {
      workerPending = false;
      pendingParams = null;
      pendingShowOpts = null;
      opts.geometryBundle = cachedBundle;
      opts.geometryCacheHit = true;
      showPlanet(grid, fieldData, gridLabel, opts.note || lodNote(msg.v), proxyFlag, opts);
      statusLine.textContent = '';
      processQueuedLod(msg.v);
      return;
    }

    if (msg.geometry) {
      stageWorkerPlanet(grid, fieldData, msg, gridLabel, proxyFlag, opts);
      return;
    }

    workerPending = false;
    pendingParams = null;
    pendingShowOpts = null;
    showPlanet(grid, fieldData, gridLabel, opts.note || lodNote(msg.v), proxyFlag, opts);
    statusLine.textContent = '';
    processQueuedLod(msg.v);
  }

  function requestPlanet(params, opts) {
    opts = opts || {};
    if (!Object.prototype.hasOwnProperty.call(opts, 'proxyFlag')) {
      opts.proxyFlag = !!(activeParams && params.v < activeParams.v);
    }
    opts.params = params;
    if (!opts.shardParams) opts.shardParams = readShardParams();
    if (!opts.geometryKey) opts.geometryKey = geometryCacheKey(params, opts.shardParams);

    var grid = gridCache.get(params.v);
    var cached = getCachedFields(params);
    opts.cachedFields = cached || null;
    var cachedBundle = peekCachedGeometry(opts.geometryKey);
    if (grid && cached && cachedBundle) {
      // Повторная планета/уровень: поля и готовый GPU-бандл уже есть,
      // поэтому переход — просто commit VAO без воркера и пересборки.
      genToken++;
      pendingParams = null;
      pendingShowOpts = null;
      workerPending = false;
      // Этот показ — самый свежий запрос; ранее поставленный в очередь
      // уровень уже устарел и не должен всплыть после следующего ответа.
      lodQueuedV = 0;
      lodQueuedOpts = null;
      opts.geometryBundle = cachedBundle;
      opts.geometryCacheHit = true;
      showPlanet(grid, cached, 'GPU-кэш', opts.note || lodNote(params.v), opts.proxyFlag, opts);
      statusLine.textContent = '';
      return;
    }

    if (!worker) { generateSync(params, opts); return; }
    if (workerPending && opts.lod) {
      lodQueuedV = params.v;
      lodQueuedOpts = opts;
      syncLodHud(params.v);
      return;
    }
    if (!opts.lod) { lodQueuedV = 0; lodQueuedOpts = null; }

    genToken++;
    pendingParams = params;
    pendingShowOpts = opts;

    if (opts.allowProxy) {
      // Прокси низкого разрешения: та же планета (поля не зависят от v).
      // Собирается каскадом немедленно, пока воркер считает целевую
      // плотность, — анимация и есть фактическая загрузка.
      var proxyV = params.v > 64 ? PROXY_V : 16;
      if (params.v > proxyV && (params.v > 64 || !gridCache.has(params.v))) {
        var proxyParams = cloneParams(params, proxyV);
        var got = getGrid(proxyV);
        var proxyData = getCachedFields(proxyParams);
        if (!proxyData) {
          proxyData = withStats(got.grid, computeFields(got.grid, proxyParams));
          cacheFields(proxyParams, proxyData);
        }
        showPlanet(got.grid, proxyData, 'прокси',
          'прокси v=' + proxyV + ' · ' +
          (lodEnabled() ? 'LOD v=' : 'полная v=') + params.v + ' строится в воркере…',
          true, {
            noBuild: false,
            swapMs: 1500,
            params: proxyParams,
            shardParams: opts.shardParams
          });
        // Цель LOD ниже максимума помечена proxyFlag, поэтому для неё
        // бесшовную подмену прокси включаем явно.
        opts.swap = true;
        opts.swapMs = 1500;
      }
    }

    prefetchGrid(params.v);
    statusLine.textContent = opts.lod
      ? 'LOD: подготовка v=' + params.v + '…'
      : 'воркер: запуск…';
    workerPending = true;
    worker.postMessage({
      token: genToken,
      v: params.v,
      haveGrid: gridCache.has(params.v),
      haveFields: !!cached,
      params: params,
      shardParams: opts.shardParams
    });
  }

  function requestRenderV(v, queuedOpts) {
    if (!activeParams) return;
    if (v === state.renderV && !workerPending) { syncLodHud(v); return; }
    if (workerPending && pendingParams && pendingParams.v === v) {
      syncLodHud(v);
      return;
    }
    var opts = queuedOpts || {
      lod: true,
      noBuild: true,
      note: lodNote(v)
    };
    // Обычный LOD не запускает волну «регенерации» из центров ячеек и не
    // держит второй полный глобус prev-слоем: при v=192 двойной рендер сам
    // становится спайком. Двухслойный swap сохранён только для замены
    // загрузочного прокси финалом, где он осознанно нужен как анимация
    // загрузки; showPlanet включит его по состоянию isProxy.
    opts.lod = true;
    opts.noBuild = true;
    opts.swap = false;
    opts.swapMs = 0;
    if (!opts.note) opts.note = lodNote(v);
    syncLodHud(v);
    statusLine.textContent = 'LOD: подготовка v=' + v + '…';
    requestPlanet(cloneParams(activeParams, v), opts);
  }

  function scheduleLodUpdate(delay) {
    if (!lodEnabled() || !activeParams) return;
    window.clearTimeout(lodTimer);
    lodTimer = window.setTimeout(function () {
      lodTimer = 0;
      if (!activeParams || !lodEnabled()) return;
      // Не подменяем уровень посреди жеста. Для будущего chunk-LOD
      // непрерывная переоценка экранной ошибки останется нужна, но
      // дорогая глобальная перестройка в спайке должна дождаться settle.
      if (dragging || pointers.size > 0) {
        scheduleLodUpdate(220);
        return;
      }
      var desired = desiredRenderV(activeParams.v);
      syncLodHud(desired);
      if (desired !== state.renderV) requestRenderV(desired);
    }, delay == null ? 260 : delay);
  }

  /* Периодический watchdog из frame() не должен сбрасывать уже идущий
     debounce колеса/pinch нулевой задержкой. Он лишь ставит мягкую
     перепроверку, если никакого LOD-таймера сейчас нет. */
  function scheduleLodRecheck() {
    if (lodTimer) return;
    scheduleLodUpdate(350);
  }

  function generate() {
    var maxParams = readParams();
    activeParams = maxParams;
    lodQueuedV = 0;
    lodQueuedOpts = null;
    state.selected = -1;
    cellInfo.textContent = 'ячейка не выбрана — кликните по глобусу';
    var targetV = desiredRenderV(maxParams.v);
    requestPlanet(cloneParams(maxParams, targetV), {
      allowProxy: true,
      swapMs: 1500,
      note: lodNote(targetV)
    });
  }

  var regenTimer = 0;
  function scheduleGenerate() {
    statusLine.textContent = 'генерация…';
    window.clearTimeout(regenTimer);
    regenTimer = window.setTimeout(function () {
      try {
        generate();
      } catch (err) {
        statusLine.textContent = 'Ошибка генерации: ' + err.message;
      }
    }, 60);
  }

  /* ------------------------------------------------------------ рендер */

  var lastTime = performance.now();
  var fpsAccum = 0, fpsFrames = 0, fpsShown = performance.now();
  var perfAccum = 0, perfFrames = 0, perfShown = performance.now();
  var qualityCooldownUntil = 0;
  var qualityGoodSamples = 0;

  function resize() {
    var dpr = state.renderScale || initialRenderScale;
    var w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    var h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    syncLodHud(state.renderV);
  }

  /* Адаптивный внутренний масштаб: фрагментный шейдер с процедурной
     текстурой на телефоне часто дороже вершин, поэтому при просадке сначала
     уменьшаем число реально рисуемых пикселей. CSS-размер канваса и пикинг
     не меняются. Подъём обратно — только после нескольких стабильных
     секунд, чтобы качество не дёргалось туда-сюда. */
  function adaptRenderScale(measuredFps, tNow) {
    if (!lodEnabled() || !state.vao) {
      qualityGoodSamples = 0;
      return;
    }
    // Во время подготовки нового бандла/подмены подъём качества запрещён,
    // а вот снижение полезно сразу двум вещам: текущий кадр дешевеет и
    // порционная заливка получает больше шансов выполниться между кадрами.
    var busy = workerPending || !!state.prev || state.buildStart >= 0;
    if (busy) qualityGoodSamples = 0;
    if (tNow < qualityCooldownUntil) return;
    var minScale = 0.6;
    if (measuredFps < 38 && state.renderScale > minScale) {
      state.renderScale = Math.max(minScale, state.renderScale * (busy ? 0.72 : 0.82));
      qualityCooldownUntil = tNow + (busy ? 900 : 1800);
      qualityGoodSamples = 0;
      syncLodHud(state.renderV);
      return;
    }
    if (busy) return;
    if (measuredFps > 57 && state.renderScale < state.renderScaleBase) {
      qualityGoodSamples++;
      if (qualityGoodSamples >= 4) {
        state.renderScale = Math.min(state.renderScaleBase, state.renderScale * 1.12);
        qualityCooldownUntil = tNow + 1800;
        qualityGoodSamples = 0;
        syncLodHud(state.renderV);
      }
    } else {
      qualityGoodSamples = 0;
    }
  }

  function frame(tNow) {
    requestAnimationFrame(frame);
    var rawDt = Math.min(0.25, Math.max(0, (tNow - lastTime) / 1000));
    var dt = Math.min(0.05, rawDt);
    lastTime = tNow;
    fpsAccum += dt;
    fpsFrames++;
    perfAccum += rawDt;
    perfFrames++;
    if (tNow - fpsShown > 500) {
      fpsEl.textContent = fpsFrames ? Math.round(fpsFrames / Math.max(fpsAccum, 1e-6)) : '—';
      fpsAccum = 0; fpsFrames = 0; fpsShown = tNow;
    }
    if (tNow - perfShown > 1000) {
      var measuredFps = perfFrames / Math.max(perfAccum, 1e-6);
      perfAccum = 0; perfFrames = 0; perfShown = tNow;
      adaptRenderScale(measuredFps, tNow);
      scheduleLodRecheck();
    }
    if (!state.vao) return;
    if (state.spin && !dragging) {
      state.quat = quatNormalize(quatMultiply(quatFromAxisAngle(0, 1, 0, dt * 0.12), state.quat));
    }
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.008, 0.02, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    var aspect = canvas.width / canvas.height;
    var model = quatToMat4(state.quat);
    var mvp = mat4Multiply(
      mat4Perspective(Math.PI / 4, aspect, 0.1, 100),
      mat4Multiply(mat4TranslateZ(-state.dist), model));

    var buildP = buildProgress(tNow);
    // Волна бесшовной подмены: финал выходит из центра планеты по swapP
    // (uCenterGrow в шейдерах), прокси прячется с отставанием 0.15 —
    // плитка финала успевает долететь до поверхности и сесть ровно на
    // место сжимающейся плитки прокси.
    var swapP = -1, hideP = 0;
    if (state.prev) {
      swapP = (tNow - state.swapStart) / state.swapDur;
      if (swapP >= 1) { releasePrev(); swapP = -1; }
      else hideP = Math.max(0, Math.min(1, (swapP - 0.15) / 0.85));
    }
    var effBuild = swapP >= 0 ? swapP : buildP;
    gl.useProgram(prog);
    gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(U.mvp, false, mvp);
    gl.uniformMatrix4fv(U.model, false, model);
    gl.uniform1f(U.scale, 1.0);
    gl.uniform3f(U.sun, -0.55, 0.35, 0.75);
    gl.uniform1f(U.border, state.borders ? 1 : 0);
    gl.uniform1f(U.highlight, 0);
    gl.uniform1f(U.build, effBuild);
    gl.uniform1f(U.hide, 0);
    gl.uniform1f(U.centerGrow, swapP >= 0 ? 1 : 0);
    gl.uniform1f(U.shardMode, state.shardMode);
    gl.uniform1f(U.sep, state.shardSep);
    gl.uniform1f(U.palette, state.palette);
    gl.uniform1f(U.texMode, state.texMode);
    gl.uniform1f(U.texAmount, state.texAmount);
    gl.uniform1f(U.texScale, state.texScale);
    gl.uniform1f(U.hueShift, state.hueShift);
    gl.uniform3f(U.texSeed, state.texSeed[0], state.texSeed[1], state.texSeed[2]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.shardTex);
    gl.uniform1i(U.shardTex, 0);
    gl.bindVertexArray(state.vao);
    gl.drawElements(gl.TRIANGLES, state.indexCount, gl.UNSIGNED_INT, 0);

    if (state.selected >= 0 && state.cellIndexStart) {
      var start = state.cellIndexStart[state.selected];
      var count = state.cellIndexStart[state.selected + 1] - start;
      gl.uniform1f(U.scale, 1.004);
      gl.uniform1f(U.highlight, 1);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, start * 4);
      gl.uniform1f(U.highlight, 0);
      gl.uniform1f(U.scale, 1.0);
    }
    gl.bindVertexArray(null);

    var volumeVisible = state.shardSep > 0.0001 || state.shardMaxB > 0.0001;
    if (volumeVisible && state.vaoVol && state.volIndexCount > 0) {
      gl.useProgram(progVol);
      gl.disable(gl.CULL_FACE);
      gl.uniformMatrix4fv(UV.mvp, false, mvp);
      gl.uniformMatrix4fv(UV.model, false, model);
      gl.uniform1f(UV.scale, 1.0);
      gl.uniform1f(UV.build, effBuild);
      gl.uniform1f(UV.hide, 0);
      gl.uniform1f(UV.centerGrow, swapP >= 0 ? 1 : 0);
      gl.uniform1f(UV.shardMode, state.shardMode);
      gl.uniform1f(UV.sep, state.shardSep);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, state.shardTex);
      gl.uniform1i(UV.shardTex, 0);
      gl.uniform3f(UV.sun, -0.55, 0.35, 0.75);
      gl.bindVertexArray(state.vaoVol);
      gl.drawElements(gl.TRIANGLES, state.volIndexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }

    if (state.prev && swapP >= 0) {
      // Уходящий прокси поверх прорастающего финала: чуть выше по радиусу
      // (1.0015), чтобы до сжатия выигрывать глубину без z-файтинга.
      var pv = state.prev;
      gl.useProgram(prog);
      gl.disable(gl.CULL_FACE);
      gl.uniformMatrix4fv(U.mvp, false, mvp);
      gl.uniformMatrix4fv(U.model, false, model);
      gl.uniform1f(U.scale, 1.0015);
      gl.uniform3f(U.sun, -0.55, 0.35, 0.75);
      gl.uniform1f(U.border, state.borders ? 1 : 0);
      gl.uniform1f(U.highlight, 0);
      gl.uniform1f(U.build, 1);
      gl.uniform1f(U.hide, hideP);
      gl.uniform1f(U.centerGrow, 0);
      gl.uniform1f(U.shardMode, pv.shardMode);
      gl.uniform1f(U.sep, state.shardSep);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, pv.shardTex);
      gl.uniform1i(U.shardTex, 0);
      gl.bindVertexArray(pv.vao);
      gl.drawElements(gl.TRIANGLES, pv.indexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      gl.uniform1f(U.hide, 0);
      gl.uniform1f(U.scale, 1.0);
      if ((state.shardSep > 0.0001 || pv.shardMaxB > 0.0001) && pv.vaoVol && pv.volIndexCount > 0) {
        gl.useProgram(progVol);
        gl.disable(gl.CULL_FACE);
        gl.uniformMatrix4fv(UV.mvp, false, mvp);
        gl.uniformMatrix4fv(UV.model, false, model);
        gl.uniform1f(UV.scale, 1.0015);
        gl.uniform1f(UV.build, 1);
        gl.uniform1f(UV.hide, hideP);
        gl.uniform1f(UV.centerGrow, 0);
        gl.uniform1f(UV.shardMode, pv.shardMode);
        gl.uniform1f(UV.sep, state.shardSep);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pv.shardTex);
        gl.uniform1i(UV.shardTex, 0);
        gl.uniform3f(UV.sun, -0.55, 0.35, 0.75);
        gl.bindVertexArray(pv.vaoVol);
        gl.drawElements(gl.TRIANGLES, pv.volIndexCount, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
        gl.uniform1f(UV.hide, 0);
        gl.uniform1f(UV.scale, 1.0);
      }
    }

    if (state.shardInfo && state.coreVisible) {
      // Светящийся остаток ядра между осколками: та же первичная триангуляция.
      gl.useProgram(progCore);
      gl.disable(gl.CULL_FACE);
      gl.uniformMatrix4fv(UC.mvp, false, mvp);
      gl.uniformMatrix4fv(UC.model, false, model);
      gl.uniform1f(UC.scale, state.coreScale);
      gl.uniform3f(UC.sun, -0.55, 0.35, 0.75);
      gl.bindVertexArray(state.vaoAtmo);
      gl.drawElements(gl.TRIANGLES, state.grid.triangleCount * 3, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }

    gl.useProgram(progAtmo);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.uniformMatrix4fv(UA.mvp, false, mvp);
    gl.uniformMatrix4fv(UA.model, false, model);
    gl.uniform1f(UA.scale, 1.05);
    gl.uniform3f(UA.camPos, 0, 0, state.dist);
    gl.uniform1f(UA.build, buildP);
    gl.uniform1f(UA.fade, state.atmoFade);
    gl.bindVertexArray(state.vaoAtmo);
    gl.drawElements(gl.TRIANGLES, state.grid.triangleCount * 3, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
  }

  /* ------------------------------------------------------------ управление и пикинг */

  var dragging = false;
  var dragMoved = 0;
  var lastX = 0, lastY = 0;
  var pointers = new Map();
  var pinchDist = 0;

  function pickAt(clientX, clientY) {
    if (!state.grid || !state.elev) return;
    var rect = canvas.getBoundingClientRect();
    var ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    var ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    var aspect = rect.width / rect.height;
    var tanF = Math.tan(Math.PI / 8);
    var dir = [ndcX * tanF * aspect, ndcY * tanF, -1];
    var dl = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    dir = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    var inv = [-state.quat[0], -state.quat[1], -state.quat[2], state.quat[3]];
    var origin = quatRotateVec(inv, [0, 0, state.dist]);
    var d = quatRotateVec(inv, dir);
    var b = origin[0] * d[0] + origin[1] * d[1] + origin[2] * d[2];
    var cc = origin[0] * origin[0] + origin[1] * origin[1] + origin[2] * origin[2] - 1;
    var disc = b * b - cc;
    if (disc < 0) { state.selected = -1; cellInfo.textContent = 'мимо планеты'; return; }
    var tHit = -b - Math.sqrt(disc);
    var p = [origin[0] + d[0] * tHit, origin[1] + d[1] * tHit, origin[2] + d[2] * tHit];
    var pl = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) || 1;
    var cell = GeodesicGrid.pick(state.grid, [p[0] / pl, p[1] / pl, p[2] / pl]);
    state.selected = cell;
    cellInfo.textContent =
      GeodesicGrid.addressOf(state.grid, cell) +
      ' · ' + biomeName(state.elev[cell], state.sea, state.minE, state.maxE, state.moist[cell], state.temp[cell]) +
      ' · высота ' + state.elev[cell].toFixed(3) +
      ' · соседей ' + state.grid.neighborCount[cell];
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (e.button > 1) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
    dragging = true;
    dragMoved = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchDist > 0 && d > 0) {
        var nextPinchDist = Math.min(7, Math.max(1.7, state.dist * (pinchDist / d)));
        if (nextPinchDist !== state.dist) {
          state.dist = nextPinchDist;
          scheduleLodUpdate(260);
        }
      }
      pinchDist = d;
      return;
    }
    if (!dragging) return;
    var dx = e.clientX - lastX;
    var dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    var angle = Math.hypot(dx, dy) * 0.005;
    if (angle > 0) {
      state.quat = quatNormalize(quatMultiply(quatFromAxisAngle(dy, dx, 0, angle), state.quat));
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      if (dragging && dragMoved < 5 && e.button === 0) pickAt(e.clientX, e.clientY);
      dragging = false;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var nextDist = Math.min(7, Math.max(1.7, state.dist * Math.exp(e.deltaY * 0.001)));
    // На упоре зума колесо не должно снова и снова будить LOD-планировщик.
    if (nextDist === state.dist) return;
    state.dist = nextDist;
    scheduleLodUpdate(260);
  }, { passive: false });

  window.addEventListener('resize', function () { scheduleLodUpdate(260); });

  /* ------------------------------------------------------------ панель */

  function syncOutputs() {
    document.getElementById('freqV').textContent = parseFloat(ui.freq.value).toFixed(2);
    document.getElementById('octV').textContent = ui.oct.value;
    document.getElementById('gainV').textContent = parseFloat(ui.gain.value).toFixed(2);
    document.getElementById('warpV').textContent = parseFloat(ui.warp.value).toFixed(2);
    document.getElementById('oceanV').textContent = ui.ocean.value + '%';
  }

  Object.keys(ui).forEach(function (id) {
    ui[id].addEventListener('input', function () { syncOutputs(); scheduleGenerate(); });
    ui[id].addEventListener('change', function () { syncOutputs(); scheduleGenerate(); });
  });
  if (lodSel) {
    lodSel.addEventListener('change', function () {
      window.clearTimeout(lodTimer);
      if (!activeParams) return;
      if (lodEnabled()) {
        scheduleLodUpdate(0);
      } else {
        // Фиксированный режим — честный полный рендер выбранной v без
        // динамического масштаба, чтобы замеры плотности оставались чистыми.
        state.renderScale = state.renderScaleBase;
        syncLodHud(activeParams.v);
        requestRenderV(activeParams.v, {
          swap: false, swapMs: 0, noBuild: true, note: ''
        });
      }
    });
  }
  document.getElementById('regenBtn').addEventListener('click', scheduleGenerate);
  document.getElementById('seedBtn').addEventListener('click', function () {
    ui.seedText.value = 'planet-' + Math.floor(Math.random() * 1e9).toString(36);
    scheduleGenerate();
  });
  var bordersBtn = document.getElementById('bordersBtn');
  bordersBtn.addEventListener('click', function () {
    state.borders = !state.borders;
    bordersBtn.setAttribute('aria-pressed', String(state.borders));
  });
  var spinBtn = document.getElementById('spinBtn');
  spinBtn.setAttribute('aria-pressed', String(state.spin));
  function toggleSpin() {
    state.spin = !state.spin;
    spinBtn.setAttribute('aria-pressed', String(state.spin));
  }
  spinBtn.addEventListener('click', toggleSpin);
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' || e.repeat) return;
    var t = e.target;
    var textInput = t && t.tagName === 'INPUT' && /^(text|search|number|password|email|url|tel)$/.test(t.type || 'text');
    if (textInput || (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))) return;
    e.preventDefault();
    toggleSpin();
  });

  var buildAnimBtn = document.getElementById('buildAnimBtn');
  buildAnimBtn.setAttribute('aria-pressed', String(state.buildAnim));
  buildAnimBtn.addEventListener('click', function () {
    state.buildAnim = !state.buildAnim;
    buildAnimBtn.setAttribute('aria-pressed', String(state.buildAnim));
    if (!state.buildAnim) state.buildStart = -1;
  });
  document.getElementById('buildBtn').addEventListener('click', playBuild);
  var buildSec = document.getElementById('buildSec');
  var buildSecV = document.getElementById('buildSecV');
  function syncBuildSec() {
    state.buildDur = parseFloat(buildSec.value) * 1000;
    buildSecV.textContent = parseFloat(buildSec.value).toFixed(1) + ' с';
  }
  buildSec.addEventListener('input', syncBuildSec);
  syncBuildSec();

  var shardsEl = document.getElementById('shards');
  var shardsV = document.getElementById('shardsV');
  var shardDistEl = document.getElementById('shardDist');
  var shardSepEl = document.getElementById('shardSep');
  var shardSepV = document.getElementById('shardSepV');
  var shardThickEl = document.getElementById('shardThick');
  var shardThickV = document.getElementById('shardThickV');
  var shardJagEl = document.getElementById('shardJag');
  var shardJagV = document.getElementById('shardJagV');
  var shardLossEl = document.getElementById('shardLoss');
  var shardLossV = document.getElementById('shardLossV');
  function syncShards() {
    shardsV.textContent = shardsEl.value;
    shardSepV.textContent = parseFloat(shardSepEl.value).toFixed(2);
    shardThickV.textContent = parseFloat(shardThickEl.value).toFixed(2);
    shardJagV.textContent = parseFloat(shardJagEl.value).toFixed(2);
    shardLossV.textContent = parseFloat(shardLossEl.value).toFixed(2);
  }
  [shardsEl, shardThickEl, shardJagEl, shardLossEl].forEach(function (el) {
    el.addEventListener('input', function () { syncShards(); scheduleGeometry(); });
  });
  // Разлёт — юниформ вершинного шейдера: движение ползунка мгновенное и
  // плавное, геометрия не пересобирается. Функция общая с анимацией взрыва.
  function applySepLive() {
    state.shardSep = parseFloat(shardSepEl.value);
    state.atmoFade = state.shardMode ? Math.max(0, 1 - state.shardSep * 2.2) : 1;
    state.coreVisible = state.shardMode === 1 && (state.shardSep > 0.01 || state.shardMaxB > 0.01);
  }
  shardSepEl.addEventListener('input', function () { syncShards(); applySepLive(); });
  shardDistEl.addEventListener('change', scheduleGeometry);
  var coreEl = document.getElementById('coreScale');
  var coreV = document.getElementById('coreScaleV');
  function syncCore() {
    state.coreScale = parseFloat(coreEl.value);
    coreV.textContent = state.coreScale.toFixed(2);
  }
  coreEl.addEventListener('input', syncCore);
  syncCore();

  /* Взрыв/сброс: разлёт анимируется юниформом uSep на GPU — плавно, без
     пересборки геометрии; рваность и толщину ведём ползунками параллельно,
     объём пересобирается шагами ~4 раза/сек. Повторное нажатие (или нажатие
     при большом разлёте) возвращает затронутые ползунки к стандартным
     значениям. Нажатие во время анимации или ручной ползунок — стоп. */
  var BOOM_DEFAULTS = { sep: 0.3, jag: 0.5, thick: 0.14 };
  var BOOM_TARGET = { sep: 2.1, jag: 0.95, thick: 0.05 };
  var boomRaf = 0;
  var boomBtn = document.getElementById('shardBoom');
  function boomLabel() {
    boomBtn.textContent = parseFloat(shardSepEl.value) >= 1.0 ? '↩ собрать (сброс)' : '💥 взрыв';
  }
  function cancelBoom() {
    if (boomRaf) { cancelAnimationFrame(boomRaf); boomRaf = 0; }
    boomLabel();
  }
  boomBtn.addEventListener('click', function () {
    if (boomRaf) { cancelBoom(); statusLine.textContent = 'анимация остановлена'; return; }
    if (parseInt(shardsEl.value, 10) < 2) { shardsEl.value = '14'; syncShards(); scheduleGeometry(); }
    var reset = parseFloat(shardSepEl.value) >= 1.0;
    var from = {
      sep: parseFloat(shardSepEl.value),
      jag: parseFloat(shardJagEl.value),
      thick: parseFloat(shardThickEl.value)
    };
    var to = reset ? BOOM_DEFAULTS : BOOM_TARGET;
    var t0 = performance.now();
    var dur = reset ? 1500 : 2400;
    var lastGeom = 0;
    statusLine.textContent = reset ? 'сброс: ползунки возвращаются к стандартным…' : 'взрыв: разлёт и рваность растут, толщина падает…';
    boomBtn.textContent = '⏹ стоп';
    function step(ts) {
      var t = Math.min(1, (ts - t0) / dur);
      var e = reset
        ? (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
        : 1 - Math.pow(1 - t, 3); // взрыв: резкий выброс, затем затухание
      shardSepEl.value = String(from.sep + (to.sep - from.sep) * e);
      shardJagEl.value = String(from.jag + (to.jag - from.jag) * e);
      shardThickEl.value = String(from.thick + (to.thick - from.thick) * e);
      syncShards();
      applySepLive();
      if (ts - lastGeom > 250) { lastGeom = ts; scheduleGeometry(); }
      if (t < 1) {
        boomRaf = requestAnimationFrame(step);
      } else {
        boomRaf = 0;
        scheduleGeometry();
        boomLabel();
        statusLine.textContent = reset
          ? 'сброс завершён: стандартные разлёт/рваность/толщина'
          : 'взрыв завершён — повторное нажатие соберёт планету обратно';
      }
    }
    boomRaf = requestAnimationFrame(step);
  });
  [shardsEl, shardSepEl, shardThickEl, shardJagEl, shardLossEl].forEach(function (el) {
    el.addEventListener('input', function () { if (boomRaf) cancelBoom(); });
  });
  var paletteSel = document.getElementById('paletteSel');
  var textureSel = document.getElementById('textureSel');
  var texAmtEl = document.getElementById('texAmt');
  var texAmtV = document.getElementById('texAmtV');
  var texScaleEl = document.getElementById('texScale');
  var texScaleV = document.getElementById('texScaleV');
  var hueEl = document.getElementById('hueShift');
  var hueV = document.getElementById('hueShiftV');
  function syncCustom() {
    state.palette = paletteSel ? parseFloat(paletteSel.value) : 0;
    state.texMode = textureSel ? parseFloat(textureSel.value) : 1;
    state.texAmount = texAmtEl ? parseFloat(texAmtEl.value) : 0.35;
    state.texScale = texScaleEl ? parseFloat(texScaleEl.value) : 24;
    state.hueShift = hueEl ? parseFloat(hueEl.value) * Math.PI / 180 : 0;
    if (texAmtV) texAmtV.textContent = state.texAmount.toFixed(2);
    if (texScaleV) texScaleV.textContent = String(Math.round(state.texScale));
    if (hueV) hueV.textContent = hueEl ? hueEl.value + '°' : '0°';
  }
  [paletteSel, textureSel, texAmtEl, texScaleEl, hueEl].forEach(function (el) {
    if (el) el.addEventListener('input', syncCustom);
    if (el) el.addEventListener('change', syncCustom);
  });
  var themeSeedBtn = document.getElementById('themeSeedBtn');
  if (themeSeedBtn) themeSeedBtn.addEventListener('click', function () {
    var base = state.statsArgs && state.statsArgs.d
      ? (state.statsArgs.d.masterSeed >>> 0)
      : PlanetNoise.stringSeed(ui.seedText.value || 'planet');
    function rnd(n) {
      return PlanetNoise.hash32((base ^ Math.imul(n + 1, 0x85EBCA6B)) >>> 0) / 4294967296;
    }
    if (paletteSel) paletteSel.value = String(1 + Math.floor(rnd(1) * 6));
    if (textureSel) textureSel.value = String(1 + Math.floor(rnd(2) * 5));
    if (texAmtEl) texAmtEl.value = (0.30 + rnd(3) * 0.45).toFixed(2);
    if (texScaleEl) texScaleEl.value = String(12 + Math.floor(rnd(4) * 37));
    if (hueEl) hueEl.value = String(Math.round((rnd(5) - 0.5) * 70));
    syncCustom();
    statusLine.textContent = 'тема поверхности собрана из текущего seed (только рендер)';
  });
  syncCustom();

  boomLabel();
  syncShards();
  syncOutputs();
  prefetchGrid(parseInt(ui.vSel.value, 10));
  prefetchGrid(16);
  try {
    generate();
  } catch (err) {
    statusLine.textContent = 'Ошибка генерации: ' + err.message;
  }
  requestAnimationFrame(frame);
})();

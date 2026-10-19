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
  var canvas = document.getElementById('globe');
  var statsBox = document.getElementById('statsBox');
  var statusLine = document.getElementById('statusLine');
  var cellInfo = document.getElementById('cellInfo');
  var fpsEl = document.getElementById('fps');
  var cellsEl = document.getElementById('cells');
  var trisEl = document.getElementById('tris');

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
    'uniform mat4 uMvp;',
    'uniform mat4 uModel;',
    'uniform float uScale;',
    'uniform float uBuild;',
    'layout(location=5) in float aShard;',
    'uniform sampler2D uShardTex;',
    'uniform float uSep;',
    'uniform float uHide;',
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
    '  vec3 bp = base;',
    '  if (uShardMode > 0.5) bp = shardTransform(base, aShard);',
    '  vec3 p = bp * uScale;',
    '  vNormal = normalize(mat3(uModel) * normalize(aPos));',
    '  vColor = aColor;',
    '  vCenterW = aCenterW;',
    '  vFlash = 1.0 - ease;',
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
    'uniform vec3 uSunDir;',
    'uniform float uBorder;',
    'uniform float uHighlight;',
    'uniform float uShardMode;',
    'out vec4 fragColor;',
    'void main() {',
    '  vec3 n = normalize(vNormal);',
    '  float diff = 0.38 + 0.62 * max(dot(n, normalize(uSunDir)), 0.0);',
    '  vec3 col = vColor * diff;',
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
    '  vec3 bp = base;',
    '  if (uShardMode > 0.5) bp = shardTransform(base, aShard);',
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
    atmoFade: 1
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
  try {
    worker = new Worker('planet-worker.js?v=planet-spike-7');
    worker.onmessage = onWorkerMessage;
    worker.onerror = function () {
      worker = null;
      if (workerPending) {
        workerPending = false;
        try { generateSync(readParams()); } catch (err) {
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

  /* ------------------------------------------------------------ цвета биомов (спайк) */

  function mix3(a, b, t, out) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function smooth(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  var COL = {
    deepOcean: [0.008, 0.05, 0.16],
    shelf: [0.06, 0.42, 0.52],
    coast: [0.12, 0.58, 0.62],
    ice: [0.84, 0.91, 0.96],
    tundra: [0.52, 0.58, 0.52],
    desert: [0.74, 0.59, 0.30],
    plains: [0.44, 0.56, 0.24],
    forest: [0.10, 0.42, 0.20],
    rock: [0.43, 0.41, 0.39],
    snow: [0.95, 0.97, 1.0]
  };

  function biomeColor(e, sea, minE, maxE, moist, temp, out) {
    if (e <= sea) {
      var depth = clamp01((sea - e) / Math.max(1e-6, sea - minE));
      mix3(COL.coast, COL.shelf, smooth(0, 0.15, depth), out);
      mix3(out, COL.deepOcean, smooth(0.12, 0.75, depth), out);
      if (temp < 0.14) mix3(out, COL.ice, (0.14 - temp) / 0.14 * 0.85, out);
      return out;
    }
    var landH = clamp01((e - sea) / Math.max(1e-6, maxE - sea));
    // База: пустыня → равнина → лес по влажности.
    mix3(COL.desert, COL.plains, smooth(0.28, 0.48, moist), out);
    mix3(out, COL.forest, smooth(0.55, 0.78, moist), out);
    // Холод: тундра и лёд.
    mix3(out, COL.tundra, smooth(0.38, 0.22, temp), out);
    mix3(out, COL.ice, smooth(0.20, 0.08, temp), out);
    // Высота: скалы и снег.
    mix3(out, COL.rock, smooth(0.68, 0.9, landH) * 0.85, out);
    mix3(out, COL.snow, smooth(0.9, 1.0, landH), out);
    return out;
  }

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

  function disposeGeometry() {
    state.buffers.forEach(function (b) { gl.deleteBuffer(b); });
    state.buffers = [];
    if (state.vao) gl.deleteVertexArray(state.vao);
    if (state.vaoAtmo) gl.deleteVertexArray(state.vaoAtmo);
    if (state.vaoVol) gl.deleteVertexArray(state.vaoVol);
    state.vao = null;
    state.vaoAtmo = null;
    state.vaoVol = null;
    if (state.shardTex) { gl.deleteTexture(state.shardTex); state.shardTex = null; }
  }

  /* Утилизация уходящего слоя бесшовной подмены прокси -> финал. */
  function disposePrev() {
    var pv = state.prev;
    if (!pv) return;
    pv.buffers.forEach(function (b) { gl.deleteBuffer(b); });
    if (pv.vao) gl.deleteVertexArray(pv.vao);
    if (pv.vaoVol) gl.deleteVertexArray(pv.vaoVol);
    if (pv.shardTex) gl.deleteTexture(pv.shardTex);
    state.prev = null;
  }

  /* Момент старта сборки ячейки: волна идёт от северного полюса к южному,
     небольшой детерминированный джиттер убирает «строчку развёртки». */
  function cellBirth(centerY, cellIndex) {
    var lat01 = (1 - centerY) / 2;
    var h = Math.sin(cellIndex * 127.1) * 43758.5453;
    var jitter = (h - Math.floor(h) - 0.5) * 0.07;
    var b = lat01 * 0.74 + jitter;
    return b < 0 ? 0 : b > 0.78 ? 0.78 : b;
  }

  /* ------------------------------------------------------------ осколки: тест разломанной планеты */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
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

  var shardCache = { key: '', layout: null };

  /* Раскладка осколков: сферический Вороной по центрам; размер осколка
     задаётся угловым радиусом ρ из выбранного распределения, метрика
     (1-dot)/ρ². Раскладка детерминирована seed-ом планеты и кэшируется;
     разлёт в ключ не входит — трансформы применяются при заливке геометрии. */
  function computeShardLayout(grid, sp) {
    if (!(sp.count > 1)) return null;
    var key = grid.v + '|' + sp.count + '|' + sp.dist + '|' + sp.seedText;
    if (shardCache.key === key) return shardCache.layout;
    var K = sp.count;
    var rnd = mulberry32(PlanetNoise.stringSeed(sp.seedText + ':shards'));
    var centers = new Float32Array(K * 3);
    var sizes = new Float32Array(K);
    var i;
    if (sp.dist === 'equal') {
      var golden = Math.PI * (3 - Math.sqrt(5));
      for (i = 0; i < K; i++) {
        var y = K === 1 ? 0 : 1 - (i / (K - 1)) * 2;
        var r = Math.sqrt(Math.max(0, 1 - y * y));
        var th = golden * i;
        centers[i * 3] = Math.cos(th) * r;
        centers[i * 3 + 1] = y;
        centers[i * 3 + 2] = Math.sin(th) * r;
        sizes[i] = 1;
      }
    } else {
      for (i = 0; i < K; i++) {
        var z = rnd() * 2 - 1;
        var ph = rnd() * Math.PI * 2;
        var rr = Math.sqrt(Math.max(0, 1 - z * z));
        centers[i * 3] = Math.cos(ph) * rr;
        centers[i * 3 + 1] = z;
        centers[i * 3 + 2] = Math.sin(ph) * rr;
        if (sp.dist === 'power') {
          // Парето, α=1.3: пара крупных осколков и много мелочи — как при дроблении.
          sizes[i] = Math.pow(1 - rnd() * 0.999, -1 / 1.3);
        } else {
          // Логнормальная, σ=0.8: плавный разброс без тяжёлого хвоста.
          var g = Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(rnd() * Math.PI * 2);
          sizes[i] = Math.exp(0.8 * g);
        }
      }
    }
    var sum = 0;
    for (i = 0; i < K; i++) sum += sizes[i];
    var rho2 = new Float32Array(K);
    for (i = 0; i < K; i++) {
      var frac = Math.min(0.9, sizes[i] / sum);
      var rho = Math.acos(1 - 2 * frac);
      rho2[i] = Math.max(1e-8, rho * rho);
    }
    var F = grid.cellCount;
    var shardOf = new Uint16Array(F);
    var counts = new Uint32Array(K);
    var cent = new Float64Array(K * 3);
    for (var c = 0; c < F; c++) {
      var cx = grid.centers[c * 3], cy = grid.centers[c * 3 + 1], cz = grid.centers[c * 3 + 2];
      var best = 0, bestScore = Infinity;
      for (i = 0; i < K; i++) {
        var dot = cx * centers[i * 3] + cy * centers[i * 3 + 1] + cz * centers[i * 3 + 2];
        var score = (1 - dot) / rho2[i];
        if (score < bestScore) { bestScore = score; best = i; }
      }
      shardOf[c] = best;
      counts[best]++;
      cent[best * 3] += cx; cent[best * 3 + 1] += cy; cent[best * 3 + 2] += cz;
    }
    var pivots = new Float32Array(K * 3);
    var axes = new Float32Array(K * 3);
    var driftVec = new Float32Array(K * 3);
    var spin = new Float32Array(K);
    var nonEmpty = 0;
    for (i = 0; i < K; i++) {
      spin[i] = (rnd() * 2 - 1) * 0.7;
      var px = cent[i * 3], py = cent[i * 3 + 1], pz = cent[i * 3 + 2];
      var pl = Math.sqrt(px * px + py * py + pz * pz);
      if (counts[i] > 0 && pl > 1e-9) {
        nonEmpty++;
        pivots[i * 3] = px / pl; pivots[i * 3 + 1] = py / pl; pivots[i * 3 + 2] = pz / pl;
      } else {
        pivots[i * 3] = centers[i * 3]; pivots[i * 3 + 1] = centers[i * 3 + 1]; pivots[i * 3 + 2] = centers[i * 3 + 2];
      }
      var ax = rnd() * 2 - 1, ay = rnd() * 2 - 1, az = rnd() * 2 - 1;
      var gx = pivots[i * 3 + 1] * az - pivots[i * 3 + 2] * ay;
      var gy = pivots[i * 3 + 2] * ax - pivots[i * 3] * az;
      var gz = pivots[i * 3] * ay - pivots[i * 3 + 1] * ax;
      var gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (gl < 1e-6) { gx = 1; gy = 0; gz = 0; gl = 1; }
      axes[i * 3] = gx / gl; axes[i * 3 + 1] = gy / gl; axes[i * 3 + 2] = gz / gl;
      var actualFrac = counts[i] / F;
      var sizeFactor = actualFrac > 0
        ? Math.min(1.9, Math.max(0.7, Math.pow((1 / K) / actualFrac, 0.18))) : 1.5;
      var radial = (0.5 + rnd() * 0.9) * sizeFactor;
      var tx = rnd() * 2 - 1, ty = rnd() * 2 - 1, tz = rnd() * 2 - 1;
      var tdot = tx * pivots[i * 3] + ty * pivots[i * 3 + 1] + tz * pivots[i * 3 + 2];
      tx -= tdot * pivots[i * 3]; ty -= tdot * pivots[i * 3 + 1]; tz -= tdot * pivots[i * 3 + 2];
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      var tang = 0.35 * rnd() * sizeFactor;
      driftVec[i * 3] = pivots[i * 3] * radial + (tx / tl) * tang;
      driftVec[i * 3 + 1] = pivots[i * 3 + 1] * radial + (ty / tl) * tang;
      driftVec[i * 3 + 2] = pivots[i * 3 + 2] * radial + (tz / tl) * tang;
    }
    var layout = {
      shardOf: shardOf, counts: counts, pivots: pivots, axes: axes,
      driftVec: driftVec, spin: spin, count: K, nonEmpty: nonEmpty
    };
    shardCache.key = key;
    shardCache.layout = layout;
    return layout;
  }

  /* Сосед ячейки c через сторону между углами t1,t2: общая вершина двух
     треугольников первичной триангуляции, отличная от c (угол = треугольник). */
  function sideNeighbor(grid, c, t1, t2) {
    var other = -1;
    for (var i = 0; i < 3; i++) {
      var a = grid.triangles[t1 * 3 + i];
      for (var j = 0; j < 3; j++) {
        if (a === grid.triangles[t2 * 3 + j] && a !== c) other = a;
      }
    }
    return other;
  }

  /* Объём осколков: стены по периметрам шардов + закрытая нижняя оболочка.
     Вся геометрия — функция исходных (неразломанных) координат, поэтому при
     разлёте 0 стены соседних осколков совпадают и уходят внутрь планеты:
     реконструкция точная. Толщина и рваность — шум по исходной позиции,
     одинаковый для обеих сторон общей стены.

     Низ специально НЕ сводится в один апекс на осколок: такой веер на крупных
     плитах давал длинные треугольники через весь шард и читался как зонт.
     Внутри шарда нижняя оболочка идёт по первичной триангуляции центров
     ячеек; у границы смешанные треугольники доводятся через угол ячейки, а
     каждая граничная сторона закрывается локальным веером центр ячейки ->
     нижняя кромка стены. Получается плита примерно постоянной толщины. */
  function buildShardVolume(grid, layout, sp, surfPos, birthArr) {
    state.vaoVol = null;
    state.volIndexCount = 0;
    if (!layout) return;
    var F = grid.cellCount;
    var thickEff = sp.thick * (1 - 0.45 * sp.loss);
    var fracNoise = PlanetNoise.makeNoise('simplex',
      PlanetNoise.hash32(PlanetNoise.stringSeed(sp.seedText + ':fracture')));
    var pos = [], col = [], emi = [], cen = [], bir = [], shr = [], kind = [], idx = [];
    var c, n, k;

    var isBoundary = new Uint8Array(F);
    for (c = 0; c < F; c++) {
      for (n = 0; n < grid.neighborCount[c]; n++) {
        if (layout.shardOf[grid.neighbors[c * 6 + n]] !== layout.shardOf[c]) { isBoundary[c] = 1; break; }
      }
    }

    function shadeAt(x, y, z) {
      return 0.85 + 0.3 * (0.5 + 0.5 * fracNoise(x * 21 - 3.7, y * 21 + 8.9, z * 21 + 1.3));
    }

    // Единая глубина нижней поверхности для стены, центров и углов: одинаковая
    // функция исходного направления не даёт щелей между кусками оболочки.
    // bottomNoise01 переиспользуется для оттенка/нагрева низа, чтобы не
    // платить три вызова шума на каждую из десятков тысяч вершин оболочки.
    var bottomNoise01 = 0.5;
    function bottomRadius(x, y, z) {
      bottomNoise01 =
        0.5 + 0.5 * fracNoise(x * 9 + 1.9, y * 9 + 5.5, z * 9 - 6.2);
      return 1 - thickEff * (0.65 + 0.55 * bottomNoise01);
    }

    function pushVert(ox, oy, oz, s, cell, r, g, b, e, kindFlag) {
      var o = pos.length;
      pos.push(ox, oy, oz);
      col.push(r, g, b);
      emi.push(e);
      shr.push(s);
      kind.push(kindFlag || 0);
      cen.push(surfPos[cell * 3], surfPos[cell * 3 + 1], surfPos[cell * 3 + 2]);
      bir.push(birthArr[cell]);
      return o / 3;
    }

    function pushBottomVert(x, y, z, s, cell, knownRadius) {
      var rr = knownRadius === undefined ? bottomRadius(x, y, z) : knownRadius;
      var shade = 0.80 + 0.38 * bottomNoise01;
      // Низ — преимущественно тёмная порода с горячими пятнами, а не сплошная
      // лавовая плёнка: иначе эмиссия забивает гранёную геометрию. Глубже
      // участок оболочки — в среднем горячее.
      var heat = 0.08 + 0.30 * bottomNoise01 * bottomNoise01;
      return pushVert(x * rr, y * rr, z * rr, s, cell,
        0.105 * shade, 0.064 * shade, 0.048 * shade, heat, 1);
    }

    var bottomCenterIndex = new Int32Array(F).fill(-1);
    function bottomCenterOf(cell) {
      if (bottomCenterIndex[cell] >= 0) return bottomCenterIndex[cell];
      var vi = pushBottomVert(
        grid.centers[cell * 3], grid.centers[cell * 3 + 1], grid.centers[cell * 3 + 2],
        layout.shardOf[cell], cell);
      bottomCenterIndex[cell] = vi;
      return vi;
    }

    function bottomCornerOf(t, s, anchorCell) {
      return pushBottomVert(
        grid.corners[t * 3], grid.corners[t * 3 + 1], grid.corners[t * 3 + 2],
        s, anchorCell);
    }

    // Внутренняя часть низа: один треугольник центров на первичную ячейку
    // триангуляции. В смешанном треугольнике пара ячеек одного шарда
    // доводится до общего угла; оставшуюся приграничную часть закроют веера
    // граничных сторон ниже. Ориентация обратная верхней поверхности.
    for (var t = 0; t < grid.triangleCount; t++) {
      var ta = grid.triangles[t * 3];
      var tb = grid.triangles[t * 3 + 1];
      var tc = grid.triangles[t * 3 + 2];
      var sa = layout.shardOf[ta];
      var sb = layout.shardOf[tb];
      var sc = layout.shardOf[tc];
      if (sa === sb && sb === sc) {
        idx.push(bottomCenterOf(ta), bottomCenterOf(tc), bottomCenterOf(tb));
      } else {
        if (sa === sb) idx.push(bottomCenterOf(ta), bottomCornerOf(t, sa, ta), bottomCenterOf(tb));
        if (sb === sc) idx.push(bottomCenterOf(tb), bottomCornerOf(t, sb, tb), bottomCenterOf(tc));
        if (sc === sa) idx.push(bottomCenterOf(tc), bottomCornerOf(t, sc, tc), bottomCenterOf(ta));
      }
    }

    var SEG = 3;
    for (c = 0; c < F; c++) {
      if (!isBoundary[c]) continue;
      var s = layout.shardOf[c];
      var start = grid.cellCornerStart[c];
      var sides = grid.cellCornerStart[c + 1] - start;
      for (k = 0; k < sides; k++) {
        var t1 = grid.cellCorners[start + k];
        var t2 = grid.cellCorners[start + ((k + 1) % sides)];
        var nb = sideNeighbor(grid, c, t1, t2);
        if (nb < 0 || layout.shardOf[nb] === s) continue;
        var ax = grid.corners[t1 * 3], ay = grid.corners[t1 * 3 + 1], az = grid.corners[t1 * 3 + 2];
        var bx = grid.corners[t2 * 3], by = grid.corners[t2 * 3 + 1], bz = grid.corners[t2 * 3 + 2];
        var ex = bx - ax, ey = by - ay, ez = bz - az;
        var edgeLen = Math.sqrt(ex * ex + ey * ey + ez * ez);
        var prevTop = -1, prevBot = -1;
        var sideBottom = [];
        for (var j = 0; j <= SEG; j++) {
          var tt = j / SEG;
          var px = ax + ex * tt, py = ay + ey * tt, pz = az + ez * tt;
          var pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
          px /= pl; py /= pl; pz /= pl;
          if (j > 0 && j < SEG && sp.jag > 0) {
            var tx = py * ez - pz * ey, ty = pz * ex - px * ez, tz = px * ey - py * ex;
            var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
            var off = fracNoise(px * 13 + 7.3, py * 13 - 2.1, pz * 13 + 4.7) *
              sp.jag * Math.sin(Math.PI * tt) * edgeLen * 0.45;
            px += (tx / tl) * off; py += (ty / tl) * off; pz += (tz / tl) * off;
            pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
            px /= pl; py /= pl; pz /= pl;
          }
          var shade = shadeAt(px, py, pz);
          var rr2 = bottomRadius(px, py, pz);
          var topIdx = pushVert(px, py, pz, s, c, 0.23 * shade, 0.145 * shade, 0.09 * shade, 0.03);
          var botIdx = pushVert(px * rr2, py * rr2, pz * rr2, s, c,
            0.075 * shade, 0.05 * shade, 0.045 * shade, 0.85);
          sideBottom.push(pushBottomVert(px, py, pz, s, c, rr2));
          if (prevTop >= 0) {
            idx.push(prevTop, topIdx, botIdx, prevTop, botIdx, prevBot);
          }
          prevTop = topIdx; prevBot = botIdx;
        }
        // Локальное закрытие именно этой стороны: короткий веер в пределах
        // одной ячейки, без лучей через весь осколок.
        var bottomCenter = bottomCenterOf(c);
        for (j = 0; j < SEG; j++) {
          idx.push(bottomCenter, sideBottom[j + 1], sideBottom[j]);
        }
      }
    }
    if (!idx.length) return;

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    function attr(location, size, arr) {
      var buf = gl.createBuffer();
      state.buffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    }
    attr(0, 3, pos);
    attr(1, 3, col);
    attr(2, 1, emi);
    attr(3, 3, cen);
    attr(4, 1, bir);
    attr(5, 1, shr);
    attr(6, 1, kind);
    var ibo = gl.createBuffer();
    state.buffers.push(ibo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    state.vaoVol = vao;
    state.volIndexCount = idx.length;
    state.gpuBytes += (pos.length + col.length + cen.length + emi.length + bir.length + shr.length + kind.length + idx.length) * 4;
  }

  function uploadGeometry(grid, colors, deferVol) {
    disposeGeometry();
    var myGeomToken = ++geomToken;
    var F = grid.cellCount;
    var totalSides = grid.cellCorners.length;
    var vertexCount = F + totalSides;
    var positions = new Float32Array(vertexCount * 3);
    var colorArr = new Float32Array(vertexCount * 3);
    var centerW = new Float32Array(vertexCount);
    var centersAttr = new Float32Array(vertexCount * 3);
    var birthArr = new Float32Array(vertexCount);
    var shardAttr = new Float32Array(vertexCount);
    colorArr.set(colors, 0);
    var sp = readShardParams();
    var layout = computeShardLayout(grid, sp); // null при осколках <= 1; трансформ делает GPU
    state.shardSep = sp.sep;
    state.shardMode = layout ? 1 : 0;
    state.atmoFade = layout ? Math.max(0, 1 - sp.sep * 2.2) : 1;
    state.shardInfo = layout ? { count: layout.count, nonEmpty: layout.nonEmpty, counts: layout.counts, lost: 0 } : null;
    var coreEl = document.getElementById('coreScale');
    state.coreScale = coreEl ? parseFloat(coreEl.value) : 0.55;
    state.coreVisible = false;
    if (layout) {
      // Необратимость: самые мелкие осколки при потерях не возвращаются
      // (держат минимальный разлёт — на собранной планете остаются шрамы),
      // мелочь дополнительно разносит. Крупнейший осколок не теряем никогда.
      var lost = new Uint8Array(layout.count);
      if (sp.loss > 0) {
        var order = [];
        for (var oi = 0; oi < layout.count; oi++) if (layout.counts[oi] > 0) order.push(oi);
        order.sort(function (a, b) { return layout.counts[a] - layout.counts[b]; });
        var lostCount = Math.min(Math.max(0, order.length - 1), Math.round(order.length * sp.loss * 0.35));
        for (var li = 0; li < lostCount; li++) lost[order[li]] = 1;
        state.shardInfo.lost = lostCount;
      }
      // Параметры шардов -> дата-текстура 64x4 RGBA32F для вершинных шейдеров:
      // строки pivot / ось / дрейф / (spin, a, b); sepEff = uSep*a + b на GPU.
      // Потерянные (a=1.35, b=0.75) всегда впереди толпы и не возвращаются
      // даже при разлёте 0 — необратимость; мелочь <12 ячеек разносит сильнее.
      var texData = new Float32Array(64 * 4 * 4);
      state.shardMaxB = 0;
      for (var si = 0; si < layout.count; si++) {
        var pa = 1, pb = 0;
        if (lost[si]) { pa = 1.35; pb = 0.75; }
        else if (layout.counts[si] > 0 && layout.counts[si] < 12) pa = 1 + sp.loss * 0.8;
        if (pb > state.shardMaxB) state.shardMaxB = pb;
        texData.set([layout.pivots[si * 3], layout.pivots[si * 3 + 1], layout.pivots[si * 3 + 2], 0], si * 4);
        texData.set([layout.axes[si * 3], layout.axes[si * 3 + 1], layout.axes[si * 3 + 2], 0], (64 + si) * 4);
        texData.set([layout.driftVec[si * 3], layout.driftVec[si * 3 + 1], layout.driftVec[si * 3 + 2], 0], (128 + si) * 4);
        texData.set([layout.spin[si], pa, pb, 0], (192 + si) * 4);
      }
      if (!state.shardTex) state.shardTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, state.shardTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 64, 4, 0, gl.RGBA, gl.FLOAT, texData);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      state.coreVisible = sp.sep > 0.01 || state.shardMaxB > 0.01;
    }
    var c, k;
    for (c = 0; c < F; c++) {
      centerW[c] = 1;
      birthArr[c] = cellBirth(grid.centers[c * 3 + 1], c);
      positions[c * 3] = grid.centers[c * 3];
      positions[c * 3 + 1] = grid.centers[c * 3 + 1];
      positions[c * 3 + 2] = grid.centers[c * 3 + 2];
      shardAttr[c] = layout ? layout.shardOf[c] : 0;
      centersAttr[c * 3] = positions[c * 3];
      centersAttr[c * 3 + 1] = positions[c * 3 + 1];
      centersAttr[c * 3 + 2] = positions[c * 3 + 2];
    }
    var slot = F;
    for (c = 0; c < F; c++) {
      var start = grid.cellCornerStart[c];
      var count = grid.cellCornerStart[c + 1] - start;
      for (k = 0; k < count; k++) {
        var corner = grid.cellCorners[start + k];
        positions[slot * 3] = grid.corners[corner * 3];
        positions[slot * 3 + 1] = grid.corners[corner * 3 + 1];
        positions[slot * 3 + 2] = grid.corners[corner * 3 + 2];
        shardAttr[slot] = layout ? layout.shardOf[c] : 0;
        colorArr[slot * 3] = colors[c * 3];
        colorArr[slot * 3 + 1] = colors[c * 3 + 1];
        colorArr[slot * 3 + 2] = colors[c * 3 + 2];
        centersAttr[slot * 3] = positions[c * 3];
        centersAttr[slot * 3 + 1] = positions[c * 3 + 1];
        centersAttr[slot * 3 + 2] = positions[c * 3 + 2];
        birthArr[slot] = birthArr[c];
        slot++;
      }
    }
    var indices = new Uint32Array(totalSides * 3);
    var cellIndexStart = new Uint32Array(F + 1);
    var w = 0;
    slot = F;
    for (c = 0; c < F; c++) {
      cellIndexStart[c] = w;
      var sides = grid.cellCornerStart[c + 1] - grid.cellCornerStart[c];
      for (k = 0; k < sides; k++) {
        indices[w++] = c;
        indices[w++] = slot + k;
        indices[w++] = slot + ((k + 1) % sides);
      }
      slot += sides;
    }
    cellIndexStart[F] = w;

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    function attrBuffer(location, size, data) {
      var buf = gl.createBuffer();
      state.buffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    }
    attrBuffer(0, 3, positions);
    attrBuffer(1, 3, colorArr);
    attrBuffer(2, 1, centerW);
    attrBuffer(3, 3, centersAttr);
    attrBuffer(4, 1, birthArr);
    attrBuffer(5, 1, shardAttr);
    var ibo = gl.createBuffer();
    state.buffers.push(ibo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    var vaoAtmo = gl.createVertexArray();
    gl.bindVertexArray(vaoAtmo);
    var atmoPos = gl.createBuffer();
    state.buffers.push(atmoPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, atmoPos);
    gl.bufferData(gl.ARRAY_BUFFER, grid.centers, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    var atmoIbo = gl.createBuffer();
    state.buffers.push(atmoIbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, atmoIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grid.triangles, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    state.vao = vao;
    state.vaoAtmo = vaoAtmo;
    state.indexCount = indices.length;
    state.cellIndexStart = cellIndexStart;
    state.vertexCount = vertexCount;
    state.gpuBytes = positions.byteLength + colorArr.byteLength + centerW.byteLength +
      centersAttr.byteLength + birthArr.byteLength + shardAttr.byteLength + indices.byteLength +
      grid.centers.byteLength + grid.triangles.byteLength;
    trisEl.textContent = (indices.length / 3).toLocaleString('ru-RU');
    if (deferVol && layout) {
      // Объём осколков не блокирует первый кадр: достраивается в фоне, пока
      // идёт каскад (его ячейки садятся той же волной — шва не видно).
      var buildVol = function () {
        if (myGeomToken !== geomToken) return;
        buildShardVolume(grid, layout, sp, positions, birthArr);
        if (state.statsArgs && state.statsArgs.grid === grid) renderStats(state.lastMsGeom || 0);
      };
      if (window.requestIdleCallback) window.requestIdleCallback(buildVol, { timeout: 300 });
      else window.setTimeout(buildVol, 30);
    } else {
      buildShardVolume(grid, layout, sp, positions, birthArr);
    }
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
  function showPlanet(grid, d, gridLabel, note, proxyFlag) {
    // Бесшовная подмена прокси финалом: прежняя геометрия остаётся жить как
    // prev-слой, финал прорастает под ним той же широтной волной рождения
    // (birth зависит от широты, фронты совпадают), прокси следом сжимается
    // в центры своих ячеек. Каскад с полюса при этом не перезапускается.
    var doSwap = !proxyFlag && state.isProxy && !!state.vao && !!state.grid && state.grid !== grid;
    if (doSwap) {
      disposePrev();
      state.prev = {
        vao: state.vao, vaoVol: state.vaoVol,
        indexCount: state.indexCount, volIndexCount: state.volIndexCount,
        buffers: state.buffers, shardTex: state.shardTex, shardMode: state.shardMode
      };
      state.vao = null; state.vaoVol = null; state.buffers = []; state.shardTex = null;
      state.swapStart = performance.now();
    } else {
      disposePrev();
      state.swapStart = -1;
    }
    state.isProxy = !!proxyFlag;
    state.grid = grid;
    state.selected = -1;
    var F = grid.cellCount;
    var colors = new Float32Array(F * 3);
    var rgb = [0, 0, 0];
    for (var c = 0; c < F; c++) {
      biomeColor(d.elev[c], d.sea, d.minE, d.maxE, d.moist[c], d.temp[c], rgb);
      colors[c * 3] = rgb[0]; colors[c * 3 + 1] = rgb[1]; colors[c * 3 + 2] = rgb[2];
    }

    state.colors = colors;
    state.statsArgs = { grid: grid, d: d, gridLabel: gridLabel, note: note };

    var t = now();
    uploadGeometry(grid, colors, state.buildAnim);
    var msGeom = now() - t;
    state.lastMsGeom = msGeom;
    if (doSwap) state.buildStart = -1; // рост финала ведёт волна подмены, не каскад
    else if (state.buildAnim) playBuild(); else state.buildStart = -1;

    state.elev = d.elev;
    state.moist = d.moist;
    state.temp = d.temp;
    state.sea = d.sea;
    state.minE = d.minE;
    state.maxE = d.maxE;

    cellsEl.textContent = F.toLocaleString('ru-RU');
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
    statsBox.textContent =
      (a.note ? a.note + '\n' : '') +
      'сетка: ' + a.gridLabel +
      ' · поля: ' + d.msFields.toFixed(0) + ' мс · геометрия: ' + msGeom.toFixed(0) + ' мс\n' +
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
      var t = now();
      uploadGeometry(state.grid, state.colors);
      renderStats(now() - t);
    }, 120);
  }

  /* Синхронный путь без воркера: старое поведение, вкладка подвисает. */
  function generateSync(params) {
    var got = getGrid(params.v);
    var d = withStats(got.grid, computeFields(got.grid, params));
    showPlanet(got.grid, d, got.ms ? got.ms.toFixed(0) + ' мс' : 'кэш', '');
    statusLine.textContent = '';
  }

  function onWorkerMessage(e) {
    var msg = e.data;
    if (msg.type === 'progress') {
      if (msg.token !== genToken) return;
      statusLine.textContent = msg.stage === 'grid'
        ? 'воркер: сетка v=' + msg.v + '…'
        : 'воркер: поля ' + msg.pct + '%…';
      return;
    }
    if (msg.type === 'error') {
      if (msg.token !== genToken) return;
      workerPending = false;
      worker = null;
      try {
        generateSync(readParams());
      } catch (err) {
        statusLine.textContent = 'Ошибка генерации: ' + err.message;
      }
      return;
    }
    if (msg.grid) gridCache.set(msg.v, msg.grid);
    if (msg.token !== genToken) return;
    workerPending = false;
    var grid = gridCache.get(msg.v);
    if (!grid) return;
    var gridLabel = msg.gridSource === 'built' ? msg.msGrid.toFixed(0) + ' мс (воркер)'
      : msg.gridSource === 'idb' ? 'IndexedDB-кэш' : 'кэш';
    showPlanet(grid, msg, gridLabel, '');
    statusLine.textContent = '';
  }

  function generate() {
    var params = readParams();
    genToken++;
    state.selected = -1;
    cellInfo.textContent = 'ячейка не выбрана — кликните по глобусу';
    if (!worker) { generateSync(params); return; }

    // Прокси низкого разрешения: та же планета (поля не зависят от v).
    // Собирается каскадом немедленно, пока воркер считает полную плотность, —
    // анимация и есть фактическая загрузка. Показываем при высокой плотности
    // и при любом «холодном» v (сетки ещё нет в памяти: первый визит, новая
    // плотность) — первый кадр за десятки мс вместо пустого экрана; при
    // тёплом кэше воркер отвечает быстрее, чем прокси успел бы мигнуть.
    var proxyV = params.v > 64 ? PROXY_V : 16;
    if (params.v > proxyV && (params.v > 64 || !gridCache.has(params.v))) {
      var got = getGrid(proxyV);
      var d = withStats(got.grid, computeFields(got.grid, params));
      showPlanet(got.grid, d, 'прокси',
        'прокси v=' + proxyV + ' · полная v=' + params.v + ' строится в воркере…', true);
    }
    prefetchGrid(params.v);
    statusLine.textContent = 'воркер: запуск…';
    workerPending = true;
    worker.postMessage({
      token: genToken,
      v: params.v,
      haveGrid: gridCache.has(params.v),
      params: params
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

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    var w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    var h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function frame(tNow) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, (tNow - lastTime) / 1000);
    lastTime = tNow;
    fpsAccum += dt;
    fpsFrames++;
    if (tNow - fpsShown > 500) {
      fpsEl.textContent = fpsFrames ? Math.round(fpsFrames / Math.max(fpsAccum, 1e-6)) : '—';
      fpsAccum = 0; fpsFrames = 0; fpsShown = tNow;
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
    // Волна бесшовной подмены: финал рождается по swapP, прокси прячется с
    // отставанием 0.15 (ячейка финала успевает сесть до сжатия прокси).
    var swapP = -1, hideP = 0;
    if (state.prev) {
      swapP = (tNow - state.swapStart) / state.swapDur;
      if (swapP >= 1) { disposePrev(); swapP = -1; }
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
    gl.uniform1f(U.shardMode, state.shardMode);
    gl.uniform1f(U.sep, state.shardSep);
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

    if (state.vaoVol && state.volIndexCount > 0) {
      gl.useProgram(progVol);
      gl.disable(gl.CULL_FACE);
      gl.uniformMatrix4fv(UV.mvp, false, mvp);
      gl.uniformMatrix4fv(UV.model, false, model);
      gl.uniform1f(UV.scale, 1.0);
      gl.uniform1f(UV.build, effBuild);
      gl.uniform1f(UV.hide, 0);
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
      if (pv.vaoVol && pv.volIndexCount > 0) {
        gl.useProgram(progVol);
        gl.disable(gl.CULL_FACE);
        gl.uniformMatrix4fv(UV.mvp, false, mvp);
        gl.uniformMatrix4fv(UV.model, false, model);
        gl.uniform1f(UV.scale, 1.0015);
        gl.uniform1f(UV.build, 1);
        gl.uniform1f(UV.hide, hideP);
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
      if (pinchDist > 0) {
        state.dist = Math.min(7, Math.max(1.7, state.dist * (pinchDist / d)));
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
    state.dist = Math.min(7, Math.max(1.7, state.dist * Math.exp(e.deltaY * 0.001)));
  }, { passive: false });

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

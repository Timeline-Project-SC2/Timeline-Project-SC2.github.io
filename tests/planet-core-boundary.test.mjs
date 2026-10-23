/* Граница модулей Wasm-ядра (Stage-8.8.1, пункт A-3).
   -------------------------------------------------------------------------
   Доказывает три вещи про главный поток и убирает возможность регресса:

   1. ИМПОРТ НЕ СОЗДАЁТ ЯДРО. После импорта `src/planet/planet-core-host.ts`
      и всех модулей главного потока (`site/shared/planet-globe.ts`,
      `planet-geography.ts`, `planet-surface.ts`) счётчик созданий
      `getPlanetCoreCreationCounters()` равен `{ full: 0, noise: 0 }`:
      ни полной арены >= 24 МиБ, ни шумового ядра на импорте.

   2. ИМПОРТ НЕ КОМПИЛИРУЕТ WASM. В отдельном процессе `WebAssembly.Module`
      подменён на бросающую функцию: импорт модулей обязан пройти, а первое
      обращение `getSharedPlanetCore()` — упасть. Так проверяется именно
      отсутствие синхронной компиляции на уровне модуля, а не только счётчик.

   3. РЕНДЕРЕР НЕ МИРАЕТ ЯДРО. `createPlanetGlobe` на mock WebGL2 с
      worker-геометрией и pick по сетке не увеличивает счётчик `full`:
      главный поток рисует только то, что уже посчитал воркер.

   Плюс структурные проверки исходников: полную генерацию поверхности и
   упаковку геометрии вызывает только воркер, а страница `/planet-globe/`
   ничего не считает на главном потоке.

   На прежнем коде (top-level `const sharedPlanetCore = new PlanetCore()`)
   тест падает: счётчиков нет, а импорт компилирует Wasm.

   Запуск: node --test tests/planet-core-boundary.test.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/* --------------------------------------------------------- mock WebGL2 */

function makeMockGL() {
  const state = { drawElements: [], createdVaos: [], createdBuffers: [] };
  const gl = {
    COMPILE_STATUS: 'COMPILE_STATUS',
    LINK_STATUS: 'LINK_STATUS',
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    ARRAY_BUFFER: 34962,
    ELEMENT_ARRAY_BUFFER: 34963,
    STATIC_DRAW: 35044,
    DYNAMIC_DRAW: 35048,
    FLOAT: 5126,
    UNSIGNED_BYTE: 5121,
    SHORT: 5122,
    UNSIGNED_INT: 5125,
    TRIANGLES: 4,
    LINE_LOOP: 2,
    COLOR_BUFFER_BIT: 16384,
    DEPTH_BUFFER_BIT: 256,
    DEPTH_TEST: 2929,
    BLEND: 3042,
    CULL_FACE: 2884,
    BACK: 1029,
    FRONT: 1028,
    SRC_ALPHA: 770,
    ONE_MINUS_SRC_ALPHA: 771,
    createShader() { return { kind: 'shader' }; },
    shaderSource() {},
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ''; },
    createProgram() { return { kind: 'program' }; },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ''; },
    getUniformLocation(_program, name) { return { name: String(name) }; },
    createVertexArray() { const vao = { kind: 'vao' }; state.createdVaos.push(vao); return vao; },
    bindVertexArray() {},
    deleteVertexArray() {},
    createBuffer() { const buffer = { kind: 'buffer' }; state.createdBuffers.push(buffer); return buffer; },
    bindBuffer() {},
    bufferData() {},
    bufferSubData() {},
    deleteBuffer() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    viewport() {},
    clearColor() {},
    clear() {},
    enable() {},
    disable() {},
    depthMask() {},
    cullFace() {},
    blendFunc() {},
    useProgram() {},
    uniformMatrix4fv() {},
    uniform3f() {},
    uniform4f() {},
    uniform1f() {},
    drawElements(target, count) { state.drawElements.push({ count }); },
    drawArrays() {},
  };
  return { gl, state };
}

function makeMockCanvas(gl) {
  const listeners = new Map();
  return {
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    getContext(type) { return type === 'webgl2' ? gl : null; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
  };
}

/* ------------------------------------------- 1. импорт не создаёт ядро */

test('boundary: импорт хоста и модулей главного потока не создаёт Wasm-ядро', () => {
  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => { rafQueue.length = 0; };

  // Хост — источник истины по счётчикам и по base64-байтам ядер.
  const Host = require('../src/planet/planet-core-host.ts');
  assert.equal(typeof Host.getPlanetCoreCreationCounters, 'function',
    'хост обязан экспортировать счётчик созданий ядер (Stage-8.8.1, A-3)');
  assert.equal(typeof Host.peekSharedPlanetCore, 'function',
    'хост обязан отдавать уже созданный синглтон без побочного эффекта');

  const initial = Host.getPlanetCoreCreationCounters();
  assert.deepEqual({ full: initial.full, noise: initial.noise }, { full: 0, noise: 0 },
    'импорт planet-core-host.ts не должен создавать ядро');
  assert.equal(Host.peekSharedPlanetCore(), null, 'до первого обращения синглтона нет');

  // Модули главного потока: рендерер, география, поверхность, а также упаковщик.
  const PlanetGlobeModule = require('../site/shared/planet-globe.ts');
  const PlanetGlobe = PlanetGlobeModule.default;
  require('../site/shared/planet-globe-pack.ts');
  require('../site/shared/planet-geography.ts');
  require('../site/shared/planet-surface.ts');

  for (const moved of ['buildVertexColors', 'buildGlobeGeometry']) {
    assert.equal(moved in PlanetGlobeModule, false,
      `planet-globe.ts не должен реэкспортировать ${moved}`);
    assert.equal(moved in PlanetGlobe, false,
      `объект PlanetGlobe не должен содержать ${moved}`);
  }

  const afterImport = Host.getPlanetCoreCreationCounters();
  assert.equal(afterImport.full, 0,
    'импорт geography/surface/globe не должен создавать полное ядро (арена 24 МиБ)');
  assert.equal(afterImport.noise, 0,
    'импорт не должен создавать и шумовое ядро: оно тоже ленивое');
  assert.equal(Host.peekSharedPlanetCore(), null, 'после импорта синглтона всё ещё нет');

  /* ------------------------------------ 3. рендерер не поднимает арену */

  const { gl, state } = makeMockGL();
  const canvas = makeMockCanvas(gl);
  const handle = PlanetGlobe.createPlanetGlobe(canvas, {
    autoRotate: false, borders: false, atmosphere: false,
  });
  assert.ok(handle, 'глобус создаётся на mock WebGL2');

  // Геометрия в том виде, в котором её присылает воркер (transferable-срезы).
  const V = 8;
  const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
  const grid = GeodesicGrid.build(V);
  const cellCount = grid.cellCount;
  const vertexCount = cellCount + grid.cellCorners.length;
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = Math.sin(i * 0.01);
  const normals = new Int16Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) {
    normals[v * 4] = 0; normals[v * 4 + 1] = 0; normals[v * 4 + 2] = 32767;
  }
  const colors = new Uint8Array(vertexCount * 4).fill(200);
  const indices = new Uint32Array(grid.cellCorners.length * 3);
  for (let c = 0; c < cellCount; c++) {
    const start = grid.cellCornerStart[c];
    const sides = grid.cellCornerStart[c + 1] - start;
    for (let k = 0; k < sides; k++) {
      indices[(start + k) * 3] = c;
      indices[(start + k) * 3 + 1] = cellCount + start + k;
      indices[(start + k) * 3 + 2] = cellCount + start + ((k + 1) % sides);
    }
  }
  const workerGeometry = {
    version: 'planet-globe-v1',
    v: V,
    cellCount,
    vertexCount,
    triangleCount: grid.cellCorners.length,
    indexCount: indices.length,
    positions,
    normals,
    colors,
    indices,
    chunkRanges: [],
    reliefScale: 1,
    typedBytes: positions.byteLength + normals.byteLength + colors.byteLength + indices.byteLength,
  };

  handle.setGeometry(workerGeometry);
  handle.transitionGeometry(workerGeometry, 0.08);
  handle.setColors(colors);
  handle.setBuildProgress(1);
  const picked = handle.pickDirection(400, 300);
  assert.ok(picked === null || (picked.length === 3), 'pick отдаёт направление луча');
  for (const cb of rafQueue.splice(0)) cb(16);
  handle.dispose();
  assert.ok(state.createdVaos.length > 0, 'рендерер поднял VAO на worker-геометрии');
  assert.ok(state.createdBuffers.length > 0, 'рендерер загрузил буферы worker-геометрии');

  const afterRender = Host.getPlanetCoreCreationCounters();
  assert.equal(afterRender.full, 0,
    'рендер worker-геометрии на главном потоке не должен создавать полное ядро');
  assert.equal(afterRender.noise, 0,
    'рендер не должен создавать шумовое ядро: шум нужен только генерации в воркере');
  assert.equal(Host.peekSharedPlanetCore(), null, 'арена 24 МиБ не создана');

  /* -------------------- 4. поведение getSharedPlanetCore() не изменилось */

  const first = Host.getSharedPlanetCore();
  const second = Host.getSharedPlanetCore();
  assert.equal(first, second, 'getSharedPlanetCore() возвращает тот же экземпляр');
  assert.equal(Host.getPlanetCoreCreationCounters().full, 1,
    'полное ядро создаётся ровно один раз — по первому обращению');
  assert.equal(Host.peekSharedPlanetCore(), first, 'peek отдаёт тот же синглтон');
  assert.equal(typeof first.globePack, 'function', 'у синглтона полный набор методов');
});

/* ------------------- 2. импорт не компилирует Wasm (отдельный процесс) */

test('boundary: импорт не компилирует Wasm, ядро поднимается только по вызову', () => {
  const url = (rel) => pathToFileURL(`${repoRoot}${rel}`).href;
  const modules = [
    'src/planet/planet-core-host.ts',
    'site/shared/planet-geography.ts',
    'site/shared/planet-surface.ts',
    'site/shared/planet-globe.ts',
    'site/shared/planet-globe-pack.ts',
  ].map(url);

  // Отдельный процесс: считаем КАЖДУЮ компиляцию WebAssembly.Module и
  // сравниваем её размер с байтами ядер planet-core / planet-noise.
  // Обёртка включена ПОСЛЕ импорта байтовых констант, потому что Node
  // сам компилирует wasm-парсер TypeScript (amaro) при чтении .ts.
  const probe = [
    'const bytes = await import(' + JSON.stringify(url('src/planet/planet-core-bytes.ts')) + ');',
    'const modules = ' + JSON.stringify(modules) + ';',
    'const RealModule = WebAssembly.Module;',
    'const compiled = [];',
    'function TrackedModule(data) {',
    '  const size = data && (data.byteLength ?? data.length) || 0;',
    '  compiled.push(size);',
    '  return new RealModule(data);',
    '}',
    'WebAssembly.Module = TrackedModule;',
    'for (const spec of modules) await import(spec);',
    'const planetSizes = (list) => list.filter((n) => n === bytes.PLANET_CORE_SIZE || n === bytes.PLANET_NOISE_SIZE);',
    'if (planetSizes(compiled).length !== 0) {',
    "  throw new Error('ядро скомпилировано на импорте: ' + JSON.stringify(planetSizes(compiled)));",
    '}',
    'const Host = await import(modules[0]);',
    "if (Host.peekSharedPlanetCore() !== null) throw new Error('синглтон создан на импорте');",
    'const core = Host.getSharedPlanetCore();',
    'if (typeof core.globePack !== \'function\') throw new Error(\'ядро не создано по вызову\');',
    'if (!compiled.includes(bytes.PLANET_CORE_SIZE)) {',
    "  throw new Error('полное ядро не скомпилировалось по первому вызову: ' + JSON.stringify(compiled));",
    '}',
    'if (compiled.includes(bytes.PLANET_NOISE_SIZE)) {',
    "  throw new Error('шумовое ядро поднялось вместе с полным — граница размыта');",
    '}',
    "console.log('BOUNDARY_OK ' + bytes.PLANET_CORE_SIZE + '/' + bytes.PLANET_NOISE_SIZE);",
  ].join('\n');

  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(out, /BOUNDARY_OK/,
    'импорт обязан проходить без компиляции ядра, а ядро — компилироваться по вызову');
});

/* --------------------- структурные границы: кто вызывает полную генерацию */

test('boundary: полную генерацию и упаковку геометрии вызывает только воркер', () => {
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

  const worker = read('site/planet-globe/planet-globe-worker.ts');
  assert.ok(/PlanetSurface\.generateSurface/.test(worker), 'воркер обязан считать поверхность');
  assert.ok(/buildGlobeGeometry\(/.test(worker), 'воркер обязан упаковывать геометрию');
  assert.ok(/buildVertexColors\(/.test(worker), 'воркер обязан перекрашивать слои');

  // Страница главного потока: только рендер и локальная карта.
  const page = read('site/planet-globe/planet-globe.ts');
  assert.ok(/PlanetGlobe\.createPlanetGlobe/.test(page), 'страница создаёт рендерер');
  for (const forbidden of ['buildGlobeGeometry(', 'buildVertexColors(', 'generateSurface(',
    'generateSurfaceAsync(', 'generateGeography(', 'generateGeographyAsync(']) {
    assert.ok(!page.includes(forbidden),
      `страница /planet-globe/ не должна вызывать ${forbidden} на главном потоке`);
  }

  // Stage-8.10a (A-12a): в рендерере planet-globe.ts ядра и упаковщиков больше нет совсем.
  const globe = read('site/shared/planet-globe.ts');
  for (const forbidden of [
    'getSharedPlanetCore',
    'PlanetCore',
    'getCore',
    'planet-core-host',
    'planet-globe-pack',
    'buildVertexColors',
    'buildGlobeGeometry',
  ]) {
    assert.ok(!globe.includes(forbidden),
      `в site/shared/planet-globe.ts не должно быть ${forbidden}`);
  }

  // Упаковщик геометрии хранит единственную ленивую точку доступа к ядру для меша.
  const pack = read('site/shared/planet-globe-pack.ts');
  assert.equal((pack.match(/getSharedPlanetCore\(/g) || []).length, 1,
    'в planet-globe-pack.ts ровно одна точка доступа к ядру — внутри getCore()');
  assert.ok(/function getCore\(\): PlanetCore \{\n  return getSharedPlanetCore\(\);\n\}/.test(pack),
    'getCore() в planet-globe-pack.ts не должен кэшировать ядро на уровне модуля');

  assert.ok(/let sharedPlanetCore: PlanetCore \| null = null;/.test(
    read('src/planet/planet-core-host.ts')),
    'синглтон хоста объявлен как ленивый (без new PlanetCore() на верхнем уровне)');
  assert.ok(!/^const sharedPlanetCore = new PlanetCore\(\);$/m.test(
    read('src/planet/planet-core-host.ts')),
    'на верхнем уровне planet-core-host.ts не должно быть new PlanetCore()');
  for (const rel of ['site/shared/planet-geography.ts', 'site/shared/planet-surface.ts']) {
    const source = read(rel);
    assert.ok(!/^const sharedCore = getSharedPlanetCore\(\);$/m.test(source),
      `${rel}: верхнеуровневый getSharedPlanetCore() запрещён`);
  }
});

test('boundary (A-12a): planet-globe-pack.ts импортируется только воркером, тестами и бенчмарком', () => {
  function walkCodeFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walkCodeFiles(full));
      else if (/\.(?:ts|mts|js|mjs|html)$/.test(entry)) out.push(full);
    }
    return out;
  }

  const importers = [];
  for (const subdir of ['site', 'src', 'tests', 'tools']) {
    for (const full of walkCodeFiles(join(repoRoot, subdir))) {
      const rel = relative(repoRoot, full).split('\\').join('/');
      if (rel === 'site/shared/planet-globe-pack.ts') continue;
      const source = readFileSync(full, 'utf8');
      if (source.includes('planet-globe-pack')) importers.push(rel);
    }
  }

  assert.ok(importers.includes('site/planet-globe/planet-globe-worker.ts'),
    'воркер обязан импортировать planet-globe-pack.ts');
  assert.ok(importers.includes('tools/bench_planet_stage6.mjs'),
    'бенчмарк Stage 6 обязан импортировать planet-globe-pack.ts');
  for (const expectedTest of [
    'tests/planet-globe.test.mjs',
    'tests/planet-globe-fx.test.mjs',
    'tests/planet-stage7-worker.test.mjs',
  ]) {
    assert.ok(importers.includes(expectedTest), `${expectedTest} обязан импортировать planet-globe-pack.ts`);
  }

  for (const rel of importers) {
    const allowed =
      rel === 'site/planet-globe/planet-globe-worker.ts' ||
      rel === 'tools/bench_planet_stage6.mjs' ||
      /^tests\/[^/]+\.test\.mjs$/.test(rel);
    assert.ok(allowed,
      `недопустимый импорт planet-globe-pack.ts вне воркера/тестов/бенчмарка: ${rel}`);
  }
});

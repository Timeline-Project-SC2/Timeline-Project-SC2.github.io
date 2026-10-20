// Baseline performance benchmark for the planet spike.
//
// One command (after browser deps are installed somewhere):
//   PLANET_BENCH_NODE_MODULES=/path/to/node_modules \
//     node tools/bench_planet_baseline.mjs
//
// Without puppeteer-core/@sparticuz/chromium it still writes the CPU part
// (mesh build, pick, memory) and marks browser frame scenarios as unavailable.
// Output defaults to baseline-YYYY-MM-DD.json in the repository root.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.join(rootDir, 'site');
const GeodesicGrid = require('../site/shared/geodesic-grid.js');
const PlanetNoise = require('../site/shared/planet-noise.js');

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args.set(k, v ?? 'true');
  }
}

const VS = (args.get('v') || '64,128,192').split(',').map(Number).filter(Boolean);
const today = new Date().toISOString().slice(0, 10);
const outPath = path.resolve(rootDir, args.get('out') || `baseline-${today}.json`);
const cpuOnly = args.has('cpu-only');
const durationScale = Number(args.get('duration-scale') || 1);

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function frameStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    frames: sorted.length,
    meanMs: sorted.length ? sum / sorted.length : null,
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    over50Ms: sorted.filter((x) => x > 50).length,
    over100Ms: sorted.filter((x) => x > 100).length,
    worst5Ms: sorted.slice(-5).reverse(),
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function typedBytes(obj) {
  let sum = 0;
  for (const val of Object.values(obj || {})) {
    if (ArrayBuffer.isView(val)) sum += val.byteLength;
  }
  return sum;
}

function cpuBench(v) {
  const reps = Number(args.get('cpu-reps') || 3);
  const buildSamplesMs = [];
  let grid = null;
  let rssPeak = process.memoryUsage().rss;
  for (let r = 0; r < reps; r++) {
    const t0 = process.hrtime.bigint();
    grid = GeodesicGrid.build(v);
    buildSamplesMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
  const sortedBuild = [...buildSamplesMs].sort((a, b) => a - b);

  const sampler = PlanetNoise.createSampler({
    seedText: 'korhal-iv', kind: 'simplex', freq: 2.2, octaves: 5, gain: 0.5, warp: 0.35,
  });
  const out = [0, 0, 0];
  let acc = 0;
  const tf = process.hrtime.bigint();
  for (let c = 0; c < grid.cellCount; c++) {
    sampler.sample(grid.centers[c * 3], grid.centers[c * 3 + 1], grid.centers[c * 3 + 2], out);
    acc += out[0];
  }
  const fieldMs = Number(process.hrtime.bigint() - tf) / 1e6;
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);

  const rng = mulberry32(0xC0FFEE + v);
  const picks = [];
  for (let i = 0; i < 100; i++) {
    let x = rng() * 2 - 1;
    let y = rng() * 2 - 1;
    let z = rng() * 2 - 1;
    const len = Math.hypot(x, y, z) || 1;
    x /= len; y /= len; z /= len;
    const t0 = process.hrtime.bigint();
    acc += GeodesicGrid.pick(grid, [x, y, z]);
    picks.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const pick = frameStats(picks);
  const mem = process.memoryUsage();
  return {
    v,
    cellCount: grid.cellCount,
    triangleCount: grid.triangleCount,
    meshBuildMs: percentile(sortedBuild, 0.5),
    meshBuildSamplesMs: buildSamplesMs,
    fieldCalculationMs: fieldMs,
    peakMemoryBytes: rssPeak,
    peakMemoryMiB: rssPeak / 1048576,
    processMemoryAfterBytes: mem,
    gridTypedArrayBytes: typedBytes(grid),
    pick100RandomRays: {
      meanMs: pick.meanMs,
      p50Ms: pick.p50Ms,
      p95Ms: pick.p95Ms,
      p99Ms: pick.p99Ms,
      maxMs: pick.maxMs,
      checksum: acc,
    },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(siteDir, rel));
    if (!file.startsWith(siteDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const benchV = Number(url.searchParams.get('benchv') || 0);
    if (benchV && url.pathname === '/planet-test/') {
      // Benchmark-only HTML transform: set fixed LOD and the target v before
      // planet-test.js starts, so we do not waste time generating default v=64.
      let html = fs.readFileSync(file, 'utf8');
      html = html
        .replace('<option value="64" selected>', '<option value="64">')
        .replace(`<option value="${benchV}">`, `<option value="${benchV}" selected>`)
        .replace('<option value="auto" selected>', '<option value="auto">')
        .replace('<option value="fixed">', '<option value="fixed" selected>');
      if (benchV === 64) html = html.replace('<option value="64">', '<option value="64" selected>');
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function loadBrowserDeps() {
  const candidates = [];
  if (process.env.PLANET_BENCH_NODE_MODULES) candidates.push(process.env.PLANET_BENCH_NODE_MODULES);
  candidates.push(path.join(rootDir, 'node_modules'));
  candidates.push('/tmp/planet-bench/node_modules');
  for (const base of candidates) {
    try {
      // Resolve by package name from the parent of node_modules so package
      // "exports" maps are honoured (notably @sparticuz/chromium v153).
      const localRequire = createRequire(path.join(path.dirname(base), 'planet-bench-entry.cjs'));
      const puppeteer = localRequire('puppeteer-core');
      const chromiumMod = localRequire('@sparticuz/chromium');
      const chromium = chromiumMod.default || chromiumMod;
      if (puppeteer && chromium && typeof chromium.executablePath === 'function') {
        return { puppeteer, chromium, nodeModules: base };
      }
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

async function launchBrowser(deps) {
  const executablePath = await deps.chromium.executablePath();
  const env = { ...process.env };
  const extraLibs = ['/tmp/al2023/lib', '/tmp/al2023/usr/lib64', '/tmp/al2023/lib64']
    .filter((p) => fs.existsSync(p));
  if (extraLibs.length) {
    env.LD_LIBRARY_PATH = [...extraLibs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  // Do not use the Lambda-oriented chromium.args here: --single-process and
  // in-process GPU make local SwiftShader frame pacing meaningless.
  return deps.puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
    executablePath,
    headless: 'shell',
    env,
    defaultViewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    },
  });
}

async function waitForPlanet(page, v) {
  const expectedCells = 10 * v * v + 2;
  await page.waitForFunction((cells, vv) => {
    const cellsEl = document.getElementById('cells');
    const lodEl = document.getElementById('lodHud');
    const status = document.getElementById('statusLine');
    const stats = document.getElementById('statsBox');
    const got = Number((cellsEl?.textContent || '').replace(/[^0-9]/g, ''));
    return got === cells &&
      (lodEl?.textContent || '').includes(`v=${vv}/${vv}`) &&
      !(status?.textContent || '').trim() &&
      (stats?.textContent || '').includes('сетка:');
  }, { timeout: 180000, polling: 250 }, expectedCells, v);
  // Let the 2.4s build cascade finish so scenarios measure steady rendering.
  await new Promise((r) => setTimeout(r, 2800));
}

async function recordScenario(page, seconds) {
  await page.evaluate(() => {
    if (!window.__baselineRecorder) {
      const rec = { frames: [], active: false, last: 0 };
      window.__baselineRecorder = rec;
      function loop(ts) {
        if (rec.active && rec.last) rec.frames.push(ts - rec.last);
        if (rec.active) rec.last = ts;
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    }
    window.__baselineRecorder.frames.length = 0;
    window.__baselineRecorder.active = true;
    window.__baselineRecorder.last = 0;
  });
  await new Promise((r) => setTimeout(r, Math.round(seconds * 1000 * durationScale)));
  const frames = await page.evaluate(() => {
    window.__baselineRecorder.active = false;
    return window.__baselineRecorder.frames.slice();
  });
  return frameStats(frames);
}

async function browserBench(browser, baseUrl, v) {
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e?.message || e)));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(msg.text()); });

  await page.goto(`${baseUrl}/planet-test/?bench=baseline&benchv=${v}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#vSel');
  await page.evaluate(() => {
    const spin = document.getElementById('spinBtn');
    if (spin.getAttribute('aria-pressed') !== 'true') spin.click();
  });
  await waitForPlanet(page, v);

  const memorySamples = [];
  async function sampleMemory(label) {
    const m = await page.evaluate((name) => ({
      label: name,
      usedJSHeapSize: performance.memory?.usedJSHeapSize ?? null,
      totalJSHeapSize: performance.memory?.totalJSHeapSize ?? null,
      jsHeapSizeLimit: performance.memory?.jsHeapSizeLimit ?? null,
    }), label);
    memorySamples.push(m);
  }
  await sampleMemory('after-load');

  const rotation10s = await recordScenario(page, 10);
  await sampleMemory('after-rotation');

  const box = await (await page.$('#globe')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel({ deltaY: -1200 });
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 1800));
  const maxZoom5s = await recordScenario(page, 5);
  await sampleMemory('after-max-zoom');

  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel({ deltaY: 1200 });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 1500));

  await page.evaluate(() => {
    window.__baselineRecorder.frames.length = 0;
    window.__baselineRecorder.active = true;
    window.__baselineRecorder.last = 0;
    document.getElementById('shardBoom').click();
  });
  await new Promise((r) => setTimeout(r, Math.round(5000 * durationScale)));
  const explosionFrames = await page.evaluate(() => {
    window.__baselineRecorder.active = false;
    return window.__baselineRecorder.frames.slice();
  });
  const explosion5s = frameStats(explosionFrames);
  await sampleMemory('after-explosion');

  const hud = await page.evaluate(() => ({
    fpsText: document.getElementById('fps')?.textContent,
    cellsText: document.getElementById('cells')?.textContent,
    lodText: document.getElementById('lodHud')?.textContent,
    renderScaleText: document.getElementById('renderScale')?.textContent,
    frameP50Text: document.getElementById('frameP50')?.textContent ?? null,
    frameP95Text: document.getElementById('frameP95')?.textContent ?? null,
    frameP99Text: document.getElementById('frameP99')?.textContent ?? null,
    frameOver50Text: document.getElementById('frameOver50')?.textContent ?? null,
    frameOver100Text: document.getElementById('frameOver100')?.textContent ?? null,
    frameWorstText: document.getElementById('frameWorst')?.textContent ?? null,
    gpuTimeText: document.getElementById('gpuTime')?.textContent ?? null,
    statusText: document.getElementById('statusLine')?.textContent,
    userAgent: navigator.userAgent,
  }));

  await page.close();
  const peak = memorySamples.reduce((m, s) => Math.max(m, s.usedJSHeapSize || 0), 0) || null;
  return {
    available: true,
    renderer: 'headless Chromium SwiftShader (not a phone GPU)',
    peakBrowserJsHeapBytes: peak,
    memorySamples,
    rotation10s,
    maxZoom5s,
    explosion5s,
    hudAfter: hud,
    problems,
  };
}

GeodesicGrid.build(16); // JIT warm-up
const result = {
  schema: 'planet-performance-baseline/v1',
  generatedAt: new Date().toISOString(),
  date: today,
  command: 'node tools/bench_planet_baseline.mjs',
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  notes: [
    'CPU numbers are Node.js on the benchmark host.',
    'Browser frame numbers use headless Chromium SwiftShader and are a regression reference, not Redmi Note 10 FPS.',
    'Browser scenarios use fixed LOD so each requested v is actually rendered.',
  ],
  results: [],
};

for (const v of VS) {
  console.log(`CPU baseline v=${v}...`);
  result.results.push({ v, cpu: cpuBench(v), browser: { available: false, reason: 'not run' } });
}

if (!cpuOnly) {
  const deps = loadBrowserDeps();
  if (!deps) {
    for (const r of result.results) {
      r.browser = {
        available: false,
        reason: 'puppeteer-core/@sparticuz/chromium not found; set PLANET_BENCH_NODE_MODULES',
      };
    }
  } else {
    const server = await startServer();
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    let browser = null;
    try {
      browser = await launchBrowser(deps);
      result.browserDepsNodeModules = deps.nodeModules;
      for (const r of result.results) {
        console.log(`Browser baseline v=${r.v}...`);
        r.browser = await browserBench(browser, baseUrl, r.v);
      }
    } catch (err) {
      for (const r of result.results) {
        if (!r.browser?.available) r.browser = { available: false, reason: String(err?.stack || err) };
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
      server.close();
    }
  }
}

fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Wrote ${path.relative(rootDir, outPath)}`);
for (const r of result.results) {
  const b = r.browser;
  console.log(
    `v=${r.v}: mesh ${r.cpu.meshBuildMs?.toFixed(1)} ms, pick mean ${r.cpu.pick100RandomRays.meanMs?.toFixed(3)} ms, ` +
    (b.available
      ? `rot p95 ${b.rotation10s.p95Ms?.toFixed(1)} ms, zoom p95 ${b.maxZoom5s.p95Ms?.toFixed(1)} ms, boom p95 ${b.explosion5s.p95Ms?.toFixed(1)} ms`
      : `browser unavailable (${b.reason})`),
  );
}

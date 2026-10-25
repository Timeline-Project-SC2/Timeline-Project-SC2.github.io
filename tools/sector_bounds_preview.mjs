import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const data = JSON.parse(await readFile(new URL('../data/sector-bounds.json', import.meta.url), 'utf8'));
const mapPath = arg('--map');
const verify = has('--verify');
const out = resolve(arg('--out') ?? '/tmp/bounds.svg');

if (verify && !mapPath) {
  console.error('Ошибка: режим --verify требует путь к эталону: --map /tmp/koprulu.jpg');
  process.exit(1);
}

function brightness(r, g, b) {
  return Math.max(r, g, b);
}

function saturationHsl(r, g, b) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  if (d === 0) return 0;
  const l = (max + min) / 2;
  const denom = 1 - Math.abs(2 * l - 1);
  return denom === 0 ? 0 : (d / denom) * 100;
}

function hueDeg(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function isLinePixel(r, g, b) {
  return brightness(r, g, b) > 85 && saturationHsl(r, g, b) < 45;
}

function isOrangePixel(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 70) return false;
  const d = max - min;
  if (d < 18) return false;
  const s = (d / max) * 100;
  const h = hueDeg(r, g, b);
  return h >= 18 && h <= 58 && s >= 22;
}

function loadPpm(mapFile) {
  const buf = execFileSync('convert', [mapFile, '-depth', '8', 'ppm:-'], { maxBuffer: 400 * 1024 * 1024 });
  let offset = 0;
  const nextToken = () => {
    while (offset < buf.length) {
      const c = buf[offset];
      if (c === 0x23) {
        while (offset < buf.length && buf[offset] !== 0x0a) offset += 1;
        continue;
      }
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        offset += 1;
        continue;
      }
      break;
    }
    const start = offset;
    while (offset < buf.length && buf[offset] > 0x20) offset += 1;
    return buf.subarray(start, offset).toString('ascii');
  };
  const magic = nextToken();
  if (magic !== 'P6') throw new Error(`Некорректный PPM эталона: ${magic}`);
  const width = Number(nextToken());
  const height = Number(nextToken());
  const maxval = Number(nextToken());
  if (maxval !== 255) throw new Error('Эталон должен быть 8-битным.');
  if (buf[offset] === 0x0a || buf[offset] === 0x0d || buf[offset] === 0x20) offset += 1;
  const rgb = buf.subarray(offset);
  if (rgb.length < width * height * 3) throw new Error('Обрезанные пиксели эталона.');
  return { width, height, rgb };
}

function pixelAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  const i = (y * map.width + x) * 3;
  return [map.rgb[i], map.rgb[i + 1], map.rgb[i + 2]];
}

function nearestLine(map, x, y, kind, radius = 3) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  const pred = kind === 'nebula' ? isOrangePixel : isLinePixel;
  let best = null;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const p = pixelAt(map, xi + dx, yi + dy);
      if (!p) continue;
      if (!pred(p[0], p[1], p[2])) continue;
      const dist = Math.hypot(dx, dy);
      if (best === null || dist < best.dist) best = { dist, x: xi + dx, y: yi + dy };
    }
  }
  return best;
}

if (verify) {
  const map = loadPpm(resolve(mapPath));
  const rows = [];
  let missesTotal = 0;
  for (const b of data.bounds) {
    const dists = [];
    let miss = 0;
    for (let i = 0; i < b.points.length; i += 1) {
      const [x, y] = b.points[i];
      const hit = nearestLine(map, x, y, b.kind, 3);
      if (!hit) {
        miss += 1;
        dists.push(Infinity);
        console.log(`${b.id}[${i}] (${x}, ${y}): линия не найдена`);
      } else {
        dists.push(hit.dist);
        console.log(`${b.id}[${i}] (${x}, ${y}): найдена линия, ${hit.dist.toFixed(2)} px`);
      }
    }
    const finite = dists.filter((d) => Number.isFinite(d));
    const maxPx = finite.length ? Math.max(...finite) : Infinity;
    const meanPx = finite.length ? finite.reduce((a, d) => a + d, 0) / finite.length : Infinity;
    rows.push({
      id: b.id,
      n: b.points.length,
      max: maxPx,
      mean: meanPx,
      miss,
    });
    missesTotal += miss;
  }
  console.log('контур | вершин | max px | mean px | вершин без линии');
  for (const r of rows) {
    const max = Number.isFinite(r.max) ? r.max.toFixed(2) : '∞';
    const mean = Number.isFinite(r.mean) ? r.mean.toFixed(2) : '∞';
    console.log(`${r.id} | ${r.n} | ${max} | ${mean} | ${r.miss}`);
  }
  if (missesTotal > 0) {
    console.error(`Проверка не пройдена: ${missesTotal} вершин без линии.`);
    process.exit(1);
  }
}

let background = '';
if (mapPath) {
  const bytes = await readFile(resolve(mapPath));
  background = `<image href="data:image/jpeg;base64,${bytes.toString('base64')}" x="0" y="0" width="10000" height="10000" preserveAspectRatio="none"/>`;
}
const colors = { nebula: '#73d9ed', tactical: '#f3ca78' };
const shapes = data.bounds.map((b) => `<polyline points="${b.points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${colors[b.style.color]}" stroke-width="${b.style.strokeWidth * 10}" stroke-dasharray="${b.style.dash.map((v) => v * 10).join(' ')}"/><text x="${b.points[0][0]}" y="${b.points[0][1]}" fill="white" font-size="120">${b.label}</text>`).join('\n');
await writeFile(out, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 10000">${background}${shapes}</svg>`);
if (mapPath && !verify) {
  for (const b of data.bounds) {
    for (let i = 0; i < b.points.length; i += 1) {
      const [x, y] = b.points[i];
      console.log(`${b.id}[${i}]: pixel (${x}, ${y})`);
    }
  }
}
console.log(`SVG: ${out}`);

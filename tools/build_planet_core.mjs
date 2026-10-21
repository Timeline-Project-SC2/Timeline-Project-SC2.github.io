// Сборка Wasm-ускорителя planet-core (CR-01 PR 4).
//
// Два модуля из одного исходника src/planet/assembly/kernels.ts:
//   - полное ядро (planet-core.ts) — только воркер/Node: Chrome запрещает
//     синхронную компиляцию Wasm > 4 КиБ на главном потоке;
//   - шумовое ядро (planet-noise-core.ts, ~2.2 КиБ) — можно синхронно и на
//     главном потоке (simplex/value для PlanetNoise).
// Байты встраиваются base64 в src/planet/planet-core-bytes.ts: публикация
// и CI не требуют AssemblyScript, а синхронная инстанциация не требует
// сетевых запросов. Режим --check пересобирает в память и сверяет с
// закоммиченным файлом.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bytesPath = join(repoRoot, 'src/planet/planet-core-bytes.ts');
const check = process.argv.includes('--check');

function buildOne(entry, outName, workDir) {
  const out = join(workDir, outName);
  execFileSync('npx', [
    '--yes', 'asc', join(repoRoot, 'src/planet/assembly', entry),
    '-o', out,
    '-O3', '--runtime', 'stub', '--enable', 'simd',
    '--initialMemory', '256',
  ], { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'] });
  return readFileSync(out);
}

function renderBytes(full, noise) {
  const chunk = (b64) => {
    const lines = [];
    for (let i = 0; i < b64.length; i += 100) lines.push(`  '${b64.slice(i, i + 100)}'`);
    return lines.join(' +\n');
  };
  return `// СГЕНЕРИРОВАНО tools/build_planet_core.mjs — НЕ ПРАВИТЬ ВРУЧНУЮ.
// Источник: src/planet/assembly/kernels.ts (AssemblyScript, asc -O3
// --runtime stub --enable simd). Полное ядро — только воркер/Node
// (синхронный лимит Chrome на главном потоке — 4 КиБ), шумовое — везде.
export const PLANET_CORE_SIZE = ${full.length};
export const PLANET_NOISE_SIZE = ${noise.length};
export const PLANET_CORE_WASM_BASE64 =
${chunk(full.toString('base64'))};
export const PLANET_NOISE_WASM_BASE64 =
${chunk(noise.toString('base64'))};
`;
}

const workDir = mkdtempSync(join(tmpdir(), 'planet-core-'));
try {
  const full = buildOne('planet-core.ts', 'planet-core.wasm', workDir);
  const noise = buildOne('planet-noise-core.ts', 'planet-noise-core.wasm', workDir);
  if (noise.length > 4096) {
    throw new Error(`planet-noise-core: ${noise.length} Б > лимита синхронной компиляции Chrome (4096)`);
  }
  const rendered = renderBytes(full, noise);
  if (check) {
    const current = readFileSync(bytesPath, 'utf8');
    if (current !== rendered) {
      console.error('planet-core: planet-core-bytes.ts УСТАРЕЛ — выполните npm run build:planet-core');
      process.exit(1);
    }
    console.log(`planet-core: байты актуальны (full=${full.length} Б, noise=${noise.length} Б)`);
  } else {
    writeFileSync(bytesPath, rendered);
    console.log(`planet-core: записан ${bytesPath} (full=${full.length} Б, noise=${noise.length} Б)`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

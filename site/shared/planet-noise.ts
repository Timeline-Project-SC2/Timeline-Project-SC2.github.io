/* PlanetNoise — детерминированные поля планеты (контракт
   planet-noise-simplex3d-v1). Строгий TS-порт planet-noise.js (CR-01 PR 4,
   И-5/И-6): примитивы симплекса и value noise выполняет Wasm-ядро
   planet-noise-core (< 4 КиБ, синхронная инстанциация везде), которое
   повторяет JS-арифметику побитово. Публичный API и численные результаты
   заморожены: правки перестановок, градиентов, нормировки или fBm
   требуют новой noise_version и новых golden-тестов.
   Спайковый createSampler в боевой географии не используется. */

import { PlanetNoiseCore } from '../../src/planet/planet-core-host.ts';

export type NoiseKind = 'simplex' | 'value';
export type NoiseFn = (x: number, y: number, z: number) => number;

function hash32(x: number): number {
  x = x >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

function stringSeed(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return hash32(h >>> 0);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Таблица симплекса в раскладке ядра: perm u8[512], затем permMod12 u8[512].
export function buildSimplexTable(seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const tmp = p[i] as number;
    p[i] = p[j] as number;
    p[j] = tmp;
  }
  const table = new Uint8Array(1024);
  for (let i = 0; i < 512; i++) {
    table[i] = p[i & 255] as number;
    table[512 + i] = (table[i] as number) % 12;
  }
  return table;
}

let sharedCore: PlanetNoiseCore | null = null;

function noiseCore(): PlanetNoiseCore {
  if (!sharedCore) sharedCore = new PlanetNoiseCore();
  return sharedCore;
}

function makeSimplex(seed: number): NoiseFn {
  const core = noiseCore();
  const table = core.uploadTable(buildSimplexTable(seed >>> 0));
  return function noise3(x: number, y: number, z: number): number {
    return core.simplexOnce(table, x, y, z);
  };
}

function makeValue(seed: number): NoiseFn {
  const core = noiseCore();
  const seed32 = seed | 0;
  return function noise3(x: number, y: number, z: number): number {
    return core.valueOnce(seed32, x, y, z);
  };
}

function makeNoise(kind: NoiseKind, seed: number): NoiseFn {
  if (kind === 'value') return makeValue(seed >>> 0);
  return makeSimplex(seed >>> 0);
}

function fbm(
  noise: NoiseFn, x: number, y: number, z: number,
  octaves: number, lacunarity: number, gain: number,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

function offsetVector(seed: number): [number, number, number] {
  const rand = mulberry32(seed);
  return [(rand() * 2 - 1) * 100, (rand() * 2 - 1) * 100, (rand() * 2 - 1) * 100];
}

const DOMAIN = {
  elevation: 0x1a2b3c4d,
  moisture: 0x2b3c4d5e,
  temperature: 0x3c4d5e6f,
  warp: 0x4d5e6f70,
} as const;

export interface SamplerOptions {
  seedText?: string;
  kind?: NoiseKind;
  freq?: number;
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  warp?: number;
}

export interface FieldSampler {
  sample(x: number, y: number, z: number, out: { [index: number]: number }): { [index: number]: number };
  masterSeed: number;
  kind: NoiseKind;
}

function createSampler(opts: SamplerOptions = {}): FieldSampler {
  const kind: NoiseKind = opts.kind === 'value' ? 'value' : 'simplex';
  const master = stringSeed(String(opts.seedText != null ? opts.seedText : 'planet'));
  const freq = opts.freq != null ? opts.freq : 2.2;
  const octaves = opts.octaves != null ? opts.octaves : 5;
  const lacunarity = opts.lacunarity != null ? opts.lacunarity : 2.0;
  const gain = opts.gain != null ? opts.gain : 0.5;
  const warp = opts.warp != null ? opts.warp : 0.35;

  const elevNoise = makeNoise(kind, hash32(master ^ DOMAIN.elevation));
  const moistNoise = makeNoise(kind, hash32(master ^ DOMAIN.moisture));
  const tempNoise = makeNoise(kind, hash32(master ^ DOMAIN.temperature));
  const warpNoise = makeNoise(kind, hash32(master ^ DOMAIN.warp));
  const offE = offsetVector(hash32(master ^ 0x51));
  const offM = offsetVector(hash32(master ^ 0x52));
  const offT = offsetVector(hash32(master ^ 0x53));
  const offW = offsetVector(hash32(master ^ 0x54));

  function sample(
    x: number, y: number, z: number, out: { [index: number]: number },
  ): { [index: number]: number } {
    let dx = x;
    let dy = y;
    let dz = z;
    if (warp > 0) {
      // Касательный варп: смещение по поверхности, затем нормализация.
      const wx = warpNoise(x * freq * 0.7 + offW[0], y * freq * 0.7 + offW[1], z * freq * 0.7 + offW[2]);
      const wy = warpNoise(x * freq * 0.7 + offW[1], y * freq * 0.7 + offW[2], z * freq * 0.7 + offW[0]);
      const wz = warpNoise(x * freq * 0.7 + offW[2], y * freq * 0.7 + offW[0], z * freq * 0.7 + offW[1]);
      const along = wx * x + wy * y + wz * z;
      const amp = warp * 0.35;
      dx = x + (wx - along * x) * amp;
      dy = y + (wy - along * y) * amp;
      dz = z + (wz - along * z) * amp;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
    }
    const elev = fbm(elevNoise, dx * freq + offE[0], dy * freq + offE[1], dz * freq + offE[2], octaves, lacunarity, gain);
    const moist = fbm(moistNoise, dx * freq * 1.35 + offM[0], dy * freq * 1.35 + offM[1], dz * freq * 1.35 + offM[2], Math.max(2, octaves - 1), lacunarity, gain);
    // Температура: ось Y — полярная. q = sqrt(1 - y²) — прокси инсоляции.
    const q = Math.sqrt(Math.max(0, 1 - y * y));
    const tn = tempNoise(x * 1.6 + offT[0], y * 1.6 + offT[1], z * 1.6 + offT[2]);
    let temp = 0.72 * q + 0.28 * (tn * 0.5 + 0.5) - 0.22 * Math.max(0, elev);
    if (temp < 0) temp = 0;
    else if (temp > 1) temp = 1;
    out[0] = elev;
    out[1] = moist * 0.5 + 0.5;
    out[2] = temp;
    return out;
  }

  return { sample, masterSeed: master, kind };
}

const PlanetNoise = {
  makeNoise,
  fbm,
  createSampler,
  stringSeed,
  hash32,
};

export type PlanetNoiseApi = typeof PlanetNoise;

declare global {
  interface Window {
    PlanetNoise: PlanetNoiseApi;
  }
}

(globalThis as typeof globalThis & { PlanetNoise: PlanetNoiseApi }).PlanetNoise = PlanetNoise;

export default PlanetNoise;

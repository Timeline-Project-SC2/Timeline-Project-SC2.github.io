// planet-noise-core — компактный Wasm-модуль шума для синхронной
// инстанциации на главном потоке (< 4 КиБ, лимит Chrome). Только
// simplex/value-примитивы из общего kernels.ts.
export {
  coreVersion, arenaBase, heapBase, setGradTable,
  simplexOnce, fbmOnce, valueOnce, xxhash32,
} from './kernels';

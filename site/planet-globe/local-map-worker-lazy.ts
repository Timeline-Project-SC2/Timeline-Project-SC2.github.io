/* LocalMapWorkerLazy — ленивый чанк генерации локальной карты
   (Stage-8.10b, A-12b).
   --------------------------------------------------------------------------
   Главный поток страницы не импортирует src/local-map/local-map-worker.ts
   статически: этот модуль — и через него полное Wasm-ядро planet-core —
   грузится ОТДЕЛЬНЫМ чанком при первом Dive-in через динамический
   import() (промис кэшируется в переменной модуля страницы, повторный
   Dive-in чанк не перезагружает).

   Чанк публикуется pipeline как классический IIFE-ассет (см.
   tools/vite/timeline-publish-pipeline.ts): поэтому модуль НЕ имеет
   value-export — он выставляет API через глобал `LocalMapWorkerLazyModule`
   на globalThis, а страница читает его после исполнения import(). Типы
   wire-протокола берутся из воркера через `import type` — просто, без
   ядра в графе статических импортов этой страницы.

   Побочный эффект регистрации onmessage воркера срабатывает ТОЛЬКО в
   dedicated worker (проверка importScripts), в главного потока его нет. */

import { generateHorizonSkirt, generateLocalMap } from '../../src/local-map/local-map-worker.ts';
import type {
  HorizonSkirtData,
  LocalMapWorkerRequest,
  LocalMapWorkerResponse,
} from '../../src/local-map/local-map-worker.ts';

/** API ленивого чанка, который читает страница после загрузки. */
export interface LocalMapWorkerLazyModule {
  generateLocalMap(request: LocalMapWorkerRequest): Promise<LocalMapWorkerResponse>;
  generateHorizonSkirt(
    request: LocalMapWorkerRequest,
    innerHeightfield?: Float32Array,
  ): Promise<HorizonSkirtData>;
}

const localMapWorkerLazyModule: LocalMapWorkerLazyModule = {
  generateLocalMap,
  generateHorizonSkirt,
};

(globalThis as typeof globalThis & { LocalMapWorkerLazyModule?: LocalMapWorkerLazyModule })
  .LocalMapWorkerLazyModule = localMapWorkerLazyModule;

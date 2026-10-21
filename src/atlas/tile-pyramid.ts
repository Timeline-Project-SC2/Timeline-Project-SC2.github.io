/* Map Atlas — тайловая пирамида 512×512, LRU-кэш и превью подложки. */

import { CONFIG } from './config.ts';
import type {
  AtlasKernel,
  AtlasMeta,
  TileManifest,
  TilePyramidApi,
} from './config.ts';

interface TileRuntimeLevel {
  index: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

interface TileRuntimeState {
  levels: TileRuntimeLevel[];
  tileSize: number;
  dir: string;
  version: string;
  preview: string | null;
  previewImage?: HTMLImageElement;
  cache: Record<string, HTMLImageElement>;
  loading: Record<string, boolean>;
  failed: Record<string, boolean>;
  failedCount?: number;
  previewState: string;
  visible: Record<string, number>;
  counter: number;
}

export function createTilePyramid(kernel: AtlasKernel): TilePyramidApi {
  const state = kernel.state;

  /* ------------------------------------------------------------------ растр: тайлы и предпросмотр */

  var tileState: TileRuntimeState = {
    levels: [],
    tileSize: 512,
    dir: CONFIG.tiles.dir,
    // ?v= от сборки: Pages держит файлы 10 минут, а после пересборки тайлов
    // их адреса не меняются. Версия из манифеста заставляет браузер взять свежие.
    version: '',
    preview: null,
    cache: {},
    loading: {},
    failed: {},
    previewState: 'idle',
    visible: {},
    counter: 0
  };

  function rasterExpected(meta: AtlasMeta | null | undefined): boolean {
    // за флагом следит сборка тайлов; без него нет смысла ловить 404 на каждый запрос
    return !!(meta && meta.assets && meta.assets.hasRaster);
  }

  function configureTiles(manifest: TileManifest | null | undefined, meta: AtlasMeta | null | undefined): void {
    tileState.levels = [];
    tileState.preview = null;
    tileState.version = (manifest && manifest.version) ? ('?v=' + encodeURIComponent(String(manifest.version))) : tileState.version;
    tileState.cache = {}; tileState.loading = {}; tileState.failed = {};

    if (manifest && manifest.levels && manifest.levels.length) {
      var size = manifest.mapSize || kernel.data.mapSize();
      tileState.tileSize = manifest.tileSize || 512;
      tileState.dir = (manifest.dir || CONFIG.tiles.dir).replace(/\/$/, '');
      tileState.preview = manifest.preview || null;
      tileState.version = manifest.version ? ('?v=' + encodeURIComponent(String(manifest.version))) : '';
      tileState.levels = manifest.levels.map(function (level, index) {
        var width = Number(level.width || level.size || (meta && meta.levels && meta.levels[index]) || size);
        return {
          index: level.index != null ? level.index : index,
          width: width,
          height: level.height || width,
          cols: level.cols || Math.ceil(width / tileState.tileSize),
          rows: level.rows || Math.ceil((level.height || width) / tileState.tileSize)
        };
      }).sort(function (a, b) { return a.width - b.width; });
      state.rasterMode = 'tiles';
    } else if ((window.SITE_LINKS && window.SITE_LINKS.sectorMapPreview) || rasterExpected(meta)) {
      // манифеста нет, но растр собран — пробуем один предпросмотр
      // (ссылка из links.js имеет приоритет над meta.json)
      var previewUrl = (window.SITE_LINKS && window.SITE_LINKS.sectorMapPreview) || (meta && meta.assets && meta.assets.preview) || '/assets/map-preview.webp';
      loadPreview(previewUrl + (manifest && manifest.version ? '?v=' + encodeURIComponent(String(manifest.version)) : ''));
    }
  }

  function loadPreview(url: string): void {
    var image = new Image();
    tileState.previewState = 'loading';
    image.onload = function () {
      tileState.previewImage = image;
      tileState.previewState = 'ready';
      state.rasterMode = 'preview';
      kernel.renderer.requestRender();
    };
    image.onerror = function () {
      tileState.previewState = 'missing';
      state.rasterMode = 'none';
      kernel.renderer.requestRender();
    };
    image.src = url;
  }

  function levelForScale(scale: number): TileRuntimeLevel | undefined {
    var size = kernel.data.mapSize();
    var need = size * scale;
    var chosen = tileState.levels[0];
    for (var i = 0; i < tileState.levels.length; i++) {
      chosen = tileState.levels[i]!;
      if (chosen.width >= need) break;
    }
    return chosen;
  }

  function tileKey(level: TileRuntimeLevel, col: number, row: number): string { return level.index + '/' + col + '_' + row; }

  function ensureTile(level: TileRuntimeLevel, col: number, row: number): void {
    var key = tileKey(level, col, row);
    tileState.counter += 1;
    tileState.visible[key] = tileState.counter;
    if (tileState.cache[key] || tileState.loading[key] || tileState.failed[key]) return;
    tileState.loading[key] = true;
    var image = new Image();
    image.onload = function () {
      delete tileState.loading[key];
      tileState.cache[key] = image;
      kernel.renderer.requestRender();
      evictTiles();
    };
    image.onerror = function () {
      delete tileState.loading[key];
      tileState.failed[key] = true;
      tileState.failedCount = (tileState.failedCount || 0) + 1;
      // манифест есть, а файлов нет — показываем схему вместо пустого экрана
      if (tileState.failedCount >= 4 && !Object.keys(tileState.cache).length) {
        state.rasterMode = 'none';
        kernel.renderer.requestRender();
      }
    };
    image.src = tileState.dir + '/' + level.index + '/' + col + '_' + row + '.webp' + tileState.version;
  }

  function evictTiles(): void {
    var keys = Object.keys(tileState.cache);
    if (keys.length <= CONFIG.tiles.cacheLimit) return;
    keys.sort(function (a, b) { return (tileState.visible[a] || 0) - (tileState.visible[b] || 0); });
    var excess = keys.length - CONFIG.tiles.cacheLimit;
    for (var i = 0; i < excess; i++) delete tileState.cache[keys[i]!];
  }

  function drawLevel(level: TileRuntimeLevel): number {
    const ctx = kernel.ctx!;
    // Один тайл — tileState.tileSize пикселей уровня, а не 1/cols карты.
    // Последняя колонка/строка неполная, поэтому size/cols сжимал растр:
    // для 1250 px и 3 колонок изображение кончалось на 84,7% мира, тогда как
    // маркеры продолжали рисоваться до 10000. Переводим каждый пиксель уровня
    // в мировые координаты напрямую — так растр и оверлеи совпадают пиксель-в-пиксель.
    var size = kernel.data.mapSize();
    var scale = state.view.scale;
    var worldPerPixelX = size / level.width;
    var worldPerPixelY = size / level.height;
    var tileWorldX = tileState.tileSize * worldPerPixelX;
    var tileWorldY = tileState.tileSize * worldPerPixelY;
    var view = state.view;

    var colFrom = Math.max(0, Math.floor((-view.tx) / (tileWorldX * scale)));
    var colTo = Math.min(level.cols - 1, Math.floor((state.viewport.w - view.tx) / (tileWorldX * scale)));
    var rowFrom = Math.max(0, Math.floor((-view.ty) / (tileWorldY * scale)));
    var rowTo = Math.min(level.rows - 1, Math.floor((state.viewport.h - view.ty) / (tileWorldY * scale)));

    var drawn = 0;
    for (var col = colFrom; col <= colTo; col++) {
      for (var row = rowFrom; row <= rowTo; row++) {
        ensureTile(level, col, row);
        var image = tileState.cache[tileKey(level, col, row)];
        if (!image) continue;
        var screen = kernel.renderer.toScreen(col * tileWorldX, row * tileWorldY);
        var width = image.naturalWidth * worldPerPixelX * scale;
        var height = image.naturalHeight * worldPerPixelY * scale;
        ctx.drawImage(image, screen.x, screen.y, width, height);
        drawn++;
      }
    }
    return drawn;
  }

  function drawRaster(): void {
    const ctx = kernel.ctx!;
    if (state.rasterMode === 'tiles') {
      var target = levelForScale(state.view.scale)!;
      var base = tileState.levels[0]!;
      if (base.index !== target.index) drawLevel(base);
      drawLevel(target);
      return;
    }
    if (state.rasterMode === 'preview' && tileState.previewImage) {
      var screen = kernel.renderer.toScreen(0, 0);
      var span = kernel.data.mapSize() * state.view.scale;
      ctx.drawImage(tileState.previewImage, screen.x, screen.y, span, span);
    }
  }
  function hasPreviewImage(): boolean {
    return !!tileState.previewImage;
  }

  return { configureTiles, drawRaster, hasPreviewImage };
}

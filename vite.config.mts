import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { createTimelinePublishPlugins } from './tools/vite/timeline-publish-pipeline.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const siteRoot = resolve(repoRoot, 'site');
const srcRoot = resolve(repoRoot, 'src');
const defaultPublishRoot = resolve(repoRoot, '.publish');
const atlasTemplatePath = resolve(repoRoot, 'templates/atlas-shell.html');

const routes = [
  'index.html',
  'sector/sector.html',
  'sector/admin-edit/index.html',
  'minimal/minimal.html',
  'cursor-test/index.html',
  'spiral-test/index.html',
  'planet-test/index.html',
  'planet-globe/index.html',
] as const;

export default defineConfig({
  root: siteRoot,
  server: {
    host: true,
    allowedHosts: true,
  },
  publicDir: false,
  plugins: createTimelinePublishPlugins({
    repoRoot,
    siteRoot,
    srcRoot,
    defaultPublishRoot,
    atlasTemplatePath,
    routes,
  }),
  build: {
    assetsDir: '_vite',
    copyPublicDir: false,
    cssMinify: false,
    emptyOutDir: true,
    minify: false,
    modulePreload: false,
    outDir: defaultPublishRoot,
    reportCompressedSize: false,
    rollupOptions: {
      input: Object.fromEntries(routes.map((route) => [route.replace(/[^a-z0-9]+/gi, '-'), resolve(siteRoot, route)])),
    },
    sourcemap: false,
  },
});

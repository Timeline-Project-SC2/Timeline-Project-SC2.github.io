// Выбор тяжёлых шагов существующего CI; неизвестный diff включает полный прогон.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function classifyCiPaths(paths) {
  const environment = /^(?:\.github\/workflows\/|package(?:-lock)?\.json$|tsconfig[^/]*\.json$|vite\.config\.|eslint\.config\.|tools\/|assets\/src\/)/;
  // Общие модули вне atlas тоже могут быть зависимостями планетарного ядра.
  const planet = /^(?:src\/(?!atlas\/)|site\/(?:planet|shared\/planet|shared\/local-map)|tests\/(?:planet|local-map)|data\/(?:planet|presets)|baseline[^/]*\.json$)/;
  return {
    compatibility: paths.some(path => environment.test(path)),
    planet: paths.some(path => environment.test(path) || planet.test(path)),
  };
}

export function scopeForEvent(eventName, event, changedPaths) {
  if (eventName === 'schedule') return { compatibility: true, planet: true };
  if (eventName === 'workflow_dispatch') {
    const full = event.inputs?.full === true || event.inputs?.full === 'true';
    return { compatibility: full, planet: full };
  }
  if (eventName !== 'pull_request' || changedPaths === null) return { compatibility: true, planet: true };
  return classifyCiPaths(changedPaths);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let paths = null;
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    try {
      const { base, head } = event.pull_request;
      if (![base.sha, head.sha].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Некорректный SHA');
      paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base.sha}...${head.sha}`], { encoding: 'utf8' }).split('\0').filter(Boolean);
    } catch (error) {
      console.warn('Diff недоступен: выполняем полный прогон.', error.message);
    }
  }
  const scope = scopeForEvent(process.env.GITHUB_EVENT_NAME, event, paths);
  for (const [key, value] of Object.entries(scope)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log('Выбранные тяжёлые проверки:', scope);
}

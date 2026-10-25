/* Внекадровая навигация по системам (§6.5). */

import type { AtlasKernel, SystemRecord } from './config.ts';
import { formatAddress, addressOf } from './sector-address.ts';
import { levelForWidth } from './level-ladder.ts';
import { formatDistanceLy } from './sector-units.ts';

export interface ArrowSystem {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly address?: string;
}
export interface RankedArrow extends ArrowSystem {
  readonly distance: number;
  /** Угол мира, радианы; ось Y направлена вниз. */
  readonly angle: number;
  readonly visible: boolean;
}
export interface ArrowSelection {
  readonly arrows: readonly RankedArrow[];
  readonly omitted: number;
  readonly nextDistance: number | null;
}

const MAX_ARROWS = 5;
const MIN_SEPARATION = 24 * Math.PI / 180;

function distanceLabel(ly: number): string {
  return formatDistanceLy(ly, 'label');
}

function angleDistance(a: number, b: number): number {
  const d = Math.abs(((a - b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
  return d;
}

/** Отбор выполняется по мировому расстоянию до камеры, не по экранной видимости. */
export function selectSectorArrows(
  systems: readonly ArrowSystem[], centerX: number, centerY: number,
  isVisible: (system: ArrowSystem) => boolean = () => false,
): ArrowSelection {
  const ranked = systems.map(function (system): RankedArrow | null {
    const dx = system.x - centerX;
    const dy = system.y - centerY;
    const distance = Math.hypot(dx, dy);
    if (!Number.isFinite(distance) || distance <= 0.5) return null;
    return { ...system, distance, angle: Math.atan2(dy, dx), visible: isVisible(system) };
  }).filter((item): item is RankedArrow => item !== null).sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const chosen: RankedArrow[] = [];
  const omitted: RankedArrow[] = [];
  for (const candidate of ranked) {
    if (chosen.length >= MAX_ARROWS || chosen.some((prior) => angleDistance(prior.angle, candidate.angle) < MIN_SEPARATION)) {
      omitted.push(candidate);
    } else {
      chosen.push(candidate);
    }
  }
  return { arrows: chosen, omitted: omitted.length, nextDistance: omitted.length ? omitted[omitted.length - 1]!.distance : null };
}

export interface SectorArrowsApi {
  refresh(): void;
  destroy(): void;
}

export function createSectorArrows(kernel: AtlasKernel, fly: (system: SystemRecord) => void): SectorArrowsApi {
  const host = kernel.el.mapStage.ownerDocument.createElement('div');
  host.className = 'sector-arrows';
  host.setAttribute('aria-label', 'Ближайшие системы вне кадра');
  const safeProbe = kernel.el.mapStage.ownerDocument.createElement('span');
  safeProbe.style.cssText = 'position:absolute;visibility:hidden;padding-bottom:env(safe-area-inset-bottom)';
  kernel.el.mapStage.append(safeProbe, host);
  let timer = 0;
  const mobile = window.matchMedia('(max-width: 599px)');

  function refresh(): void {
    const state = kernel.state;
    const width = Math.min(state.viewport.w, state.viewport.h) / state.view.scale;
    if (levelForWidth(width) >= 13 || !state.systems.length) { host.replaceChildren(); host.hidden = true; return; }
    const catalog = kernel.el.leftPanel;
    const catalogRect = catalog && !catalog.classList.contains('collapsed') ? catalog.getBoundingClientRect() : null;
    const freeLeft = catalogRect ? Math.min(state.viewport.w * 0.72, Math.max(0, catalogRect.right + 12)) : 0;
    const cxScreen = (freeLeft + state.viewport.w) / 2;
    const cyScreen = state.viewport.h / 2;
    const center = kernel.renderer.toWorld(cxScreen, cyScreen);
    const systems: ArrowSystem[] = state.systems.filter((s) => !!s.coord).map((s) => ({
      id: s.id, name: s.name, x: s.coord![0], y: s.coord![1],
      address: formatAddress(addressOf(s.coord![0], s.coord![1])),
    }));
    const visible = (s: ArrowSystem): boolean => {
      const screen = kernel.renderer.toScreen(s.x, s.y);
      return screen.x >= freeLeft && screen.x <= state.viewport.w && screen.y >= 0 && screen.y <= state.viewport.h;
    };
    const selection = selectSectorArrows(systems, center.x, center.y, visible);
    const inset = mobile.matches ? 24 : 32;
    const safeBottom = mobile.matches ? Number.parseFloat(getComputedStyle(safeProbe).paddingBottom) || 0 : 0;
    const halfW = Math.max(1, (state.viewport.w - freeLeft) / 2 - inset);
    const halfH = Math.max(1, state.viewport.h / 2 - inset - safeBottom / 2);
    const fragment = document.createDocumentFragment();
    selection.arrows.forEach(function (item): void {
      const angle = item.angle;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const edge = Math.min(halfW / Math.max(Math.abs(dx), 1e-9), halfH / Math.max(Math.abs(dy), 1e-9));
      const x = cxScreen + dx * edge;
      const y = cyScreen + dy * edge;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sector-arrow' + (item.visible ? ' is-visible' : '');
      button.style.left = x + 'px';
      button.style.top = y + 'px';
      button.style.setProperty('--arrow-angle', (angle + Math.PI) + 'rad');
      const spokenDistance = distanceLabel(item.distance).replace(/\u00a0св\.г\.$/, ' светового года');
      button.setAttribute('aria-label', 'К системе ' + item.name + ', ' + spokenDistance + ', адрес ' + item.address);
      button.innerHTML = '<span class="sector-arrow-chevron" aria-hidden="true">›</span><span class="sector-arrow-copy"><span>' +
        escape(item.name) + ' · ' + escape(distanceLabel(item.distance)) + '</span><span class="sector-arrow-address">' + escape(item.address || '') + '</span></span>';
      button.addEventListener('click', function (): void {
        const system = state.systemsById[item.id];
        if (system) fly(system);
      });
      fragment.append(button);
    });
    if (selection.omitted && selection.nextDistance !== null) {
      const count = document.createElement('div');
      count.className = 'sector-arrow-count';
      count.textContent = '+' + selection.omitted + ' · до ' + distanceLabel(selection.nextDistance);
      count.setAttribute('aria-live', 'polite');
      fragment.append(count);
    }
    host.replaceChildren(fragment);
    host.hidden = false;
    host.classList.toggle('is-flying', false);
  }

  function escape(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  }
  timer = window.setInterval(refresh, 250);
  return { refresh, destroy(): void { window.clearInterval(timer); safeProbe.remove(); host.remove(); } };
}

/** Текущая мировая цель с системного каталога, доступно также для тестов. */
export function arrowInput(system: SystemRecord): ArrowSystem | null {
  return system.coord ? { id: system.id, name: system.name, x: system.coord[0], y: system.coord[1], address: formatAddress(addressOf(system.coord[0], system.coord[1])) } : null;
}

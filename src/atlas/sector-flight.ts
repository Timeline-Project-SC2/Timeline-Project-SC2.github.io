/* Полёт между системами сектора (§6.4): единый владелец покадрового перехода. */

import type { AtlasKernel, SystemRecord } from './config.ts';
import { levelForWidth, visibleWidthForLevel } from './level-ladder.ts';

export interface FlightPoint {
  readonly x: number;
  readonly y: number;
  readonly level: number;
  readonly id?: string;
}

export interface FlightPlan {
  readonly from: FlightPoint;
  readonly to: FlightPoint;
  readonly delta: number;
  readonly duration: number;
  readonly targetScaleLevel: 9;
}

export interface FlightApi {
  planClickFlight(from: FlightPoint, to: FlightPoint): FlightPlan;
  planArrowTrip(current: FlightPoint, target: FlightPoint): FlightPlan;
  flyTo(plan: FlightPlan, onArrive?: () => void): void;
  cancel(): void;
  readonly active: boolean;
}

export const FLIGHT_TIMING = Object.freeze({
  anticipation: 140,
  frameEnd: 380,
  settle: 120,
  base: 760,
  perLevel: 80,
  min: 760,
  max: 1500,
});

export function flightDuration(delta: number): number {
  if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Разница уровней должна быть неотрицательной');
  return Math.max(FLIGHT_TIMING.min, Math.min(FLIGHT_TIMING.max,
    FLIGHT_TIMING.base + FLIGHT_TIMING.perLevel * delta));
}

function pointOf(value: FlightPoint | SystemRecord, level?: number): FlightPoint {
  if ('coord' in value) {
    if (!value.coord) throw new RangeError('У системы нет координат для полёта');
    return { x: value.coord[0], y: value.coord[1], level: level ?? 0, id: value.id };
  }
  if (![value.x, value.y, value.level].every(Number.isFinite)) throw new RangeError('Некорректная точка полёта');
  return value;
}

function makePlan(fromValue: FlightPoint | SystemRecord, toValue: FlightPoint | SystemRecord): FlightPlan {
  const from = pointOf(fromValue);
  const to = pointOf(toValue);
  const delta = Math.abs(from.level - to.level);
  return Object.freeze({ from, to, delta, duration: flightDuration(delta), targetScaleLevel: 9 as const });
}

export function planClickFlight(from: FlightPoint | SystemRecord, to: FlightPoint | SystemRecord): FlightPlan {
  return makePlan(from, to);
}

export function planArrowTrip(current: FlightPoint | SystemRecord, target: FlightPoint | SystemRecord): FlightPlan {
  return makePlan(current, target);
}

export function createFlight(kernel: AtlasKernel): FlightApi {
  let frame = 0;
  let started = 0;
  let active = false;
  let savedCenterOn: AtlasKernel['renderer']['centerOn'] | null = null;
  let onArrive: (() => void) | undefined;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  function ease(t: number): number { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function restoreSetter(): void {
    if (savedCenterOn) kernel.renderer.centerOn = savedCenterOn;
    savedCenterOn = null;
  }
  function cancel(): void {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    active = false;
    onArrive = undefined;
    restoreSetter();
    kernel.el.mapCanvas.style.opacity = '';
    kernel.el.mapCanvas.classList.remove('sector-flight-reduced');
    const ui = kernel.el.mapStage.querySelector<HTMLElement>('.sector-flight-frame');
    if (ui) ui.remove();
    kernel.renderer.requestRender();
  }

  function flyTo(plan: FlightPlan, complete?: () => void): void {
    cancel();
    kernel.renderer.cancelAnimation();
    active = true;
    started = performance.now();
    onArrive = complete;
    // На время полёта centerOn становится синхронным и клампит штатным
    // рендерером; тем самым все кадровые изменения проходят одним API-сеттером.
    savedCenterOn = kernel.renderer.centerOn;
    kernel.renderer.centerOn = function (x: number, y: number, scale?: number): void {
      const desired = scale ?? kernel.renderer.maxScale();
      kernel.state.view.scale = Math.max(kernel.renderer.minScale(), Math.min(kernel.renderer.maxScale(), desired));
      kernel.state.view.tx = kernel.state.viewport.w / 2 - x * kernel.state.view.scale;
      kernel.state.view.ty = kernel.state.viewport.h / 2 - y * kernel.state.view.scale;
      kernel.renderer.clampView();
    };
    const width = Math.min(kernel.state.viewport.w, kernel.state.viewport.h);
    const duration = reduced.matches ? 120 : plan.duration;
    const endScale = Math.max(kernel.renderer.minScale(), Math.min(kernel.renderer.maxScale(), width / visibleWidthForLevel(9)));
    const beginScale = kernel.state.view.scale;
    const beginCenter = kernel.renderer.toWorld(kernel.state.viewport.w / 2, kernel.state.viewport.h / 2);
    const overlay = kernel.el.mapStage.ownerDocument.createElement('div');
    overlay.className = 'sector-flight-frame';
    overlay.setAttribute('aria-hidden', 'true');
    if (!reduced.matches) kernel.el.mapStage.append(overlay);
    else kernel.el.mapCanvas.classList.add('sector-flight-reduced');

    function tick(now: number): void {
      if (!active) return;
      const elapsed = Math.min(duration, now - started);
      const p = Math.min(1, elapsed / duration);
      const stageStart = reduced.matches ? 0 : FLIGHT_TIMING.frameEnd;
      const stageEnd = reduced.matches ? duration : duration - FLIGHT_TIMING.settle;
      const stageP = Math.max(0, Math.min(1, (elapsed - stageStart) / Math.max(1, stageEnd - stageStart)));
      const k = ease(stageP);
      const cx = beginCenter.x + (plan.to.x - beginCenter.x) * k;
      const cy = beginCenter.y + (plan.to.y - beginCenter.y) * k;
      const scale = beginScale * Math.pow(endScale / beginScale, k);
      // Кадр прицела вспыхивает, сжимается, затем раскрывается на доводке.
      if (!reduced.matches) {
        overlay.style.opacity = elapsed < FLIGHT_TIMING.anticipation ? String(0.55 + 0.45 * Math.sin(elapsed / 140 * Math.PI)) : '1';
        const frameProgress = elapsed < FLIGHT_TIMING.anticipation ? 0 : elapsed < FLIGHT_TIMING.frameEnd
          ? (elapsed - FLIGHT_TIMING.anticipation) / (FLIGHT_TIMING.frameEnd - FLIGHT_TIMING.anticipation)
          : elapsed > duration - FLIGHT_TIMING.settle ? (elapsed - (duration - FLIGHT_TIMING.settle)) / FLIGHT_TIMING.settle : 1;
        overlay.style.setProperty('--flight-progress', String(Math.max(0, Math.min(1, frameProgress))));
        overlay.classList.toggle('is-settling', elapsed >= duration - FLIGHT_TIMING.settle);
      } else {
        kernel.el.mapCanvas.style.opacity = String(1 - p * 0.35);
      }
      kernel.renderer.centerOn(cx, cy, scale);
      kernel.renderer.requestRender();
      if (p < 1) { frame = window.requestAnimationFrame(tick); return; }
      frame = 0;
      kernel.renderer.centerOn(plan.to.x, plan.to.y, endScale);
      kernel.renderer.requestRender();
      active = false;
      restoreSetter();
      kernel.el.mapCanvas.style.opacity = '';
      kernel.el.mapCanvas.classList.remove('sector-flight-reduced');
      window.setTimeout(function (): void { overlay.remove(); }, reduced.matches ? 0 : 0);
      const done = onArrive;
      onArrive = undefined;
      done?.();
    }
    frame = window.requestAnimationFrame(tick);
  }
  return { planClickFlight, planArrowTrip, flyTo, cancel, get active(): boolean { return active; } };
}

export function currentFlightPoint(kernel: AtlasKernel): FlightPoint {
  const center = kernel.renderer.toWorld(kernel.state.viewport.w / 2, kernel.state.viewport.h / 2);
  const width = Math.min(kernel.state.viewport.w, kernel.state.viewport.h) / kernel.state.view.scale;
  return { ...center, level: levelForWidth(width) };
}

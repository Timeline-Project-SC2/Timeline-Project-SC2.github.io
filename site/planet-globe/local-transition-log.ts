/* A-16 / Stage-8.10c: ручной лог-замер перехода между гексами локальной карты.
   t0..t8 — performance.now(); t6..t8 и max frame gap — независимый rAF-пробник
   (стартует с t0, гасится с финалом); разрыв кадра > 100 мс — alarming (отдельный
   флаг). Буфер 20 записей; финал (естественный t8 или ручной стоп) — одна запись:
   console.table + скачиваемый JSON (весь буфер). */
export function createTransitionLog(o: {
  gpuDone: () => boolean;
  download?: (f: string, t: string) => void;
}) {
  const dl = o.download || ((f, t) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t]));
    a.download = f;
    a.click();
  });
  let a: any = null, b: any[] = [], r = 0, p = 0, g = 0, s = 0;
  function fin() {
    if (!a) return null;
    const x = a; a = null;
    r && cancelAnimationFrame(r);
    x.maxFrameGapMs = g || null; x.alarming = g > 100;
    b.push(x);
    b.length > 20 && b.shift();
    console.table(x);
    dl(`tl-${x.seed}-${x.cell}-${Date.now()}`, JSON.stringify(b));
    return x;
  }
  function pr() {
    r = requestAnimationFrame(pr);
    const T = performance.now(), d = T - p; p = T;
    if (d > g) g = d;
    if (!a) return;
    if (a.t6 == null && a.t5 != null && o.gpuDone()) a.t6 = T;
    if (a.t7 == null && a.t6 != null && T > a.t6) a.t7 = T, s = 0;
    if (a.t8 == null && a.t7 != null && (s = d <= 100 ? s + 1 : 0) >= 5) a.t8 = T, fin();
  }
  return {
    start(seed: number) {
      if (a) return;
      p = performance.now();
      a = { seed, cell: null, t0: p, t1: null, t2: null, t3: null, t4: null, t5: null, t6: null, t7: null, t8: null, maxFrameGapMs: null, alarming: false };
      g = s = 0; r = requestAnimationFrame(pr);
    },
    mark(ph: string, c?: number) {
      if (a) {
        a[ph] = performance.now();
        c != null && !a.cell && (a.cell = c);
      }
    },
    stop: fin,
  };
}

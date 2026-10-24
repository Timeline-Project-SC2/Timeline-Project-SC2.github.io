/* A-16 / Stage-8.10c: ручной лог-замер перехода между гексами локальной карты.
   t0..t8 — performance.now(); t6..t8 и max frame gap — независимый rAF-пробник
   (стартует с t0, гасится с финалом); разрыв кадра > 100 мс — alarming (отдельный
   флаг). Буфер 20 записей; финал (естественный t8 или ручной стоп) — одна запись:
   console.table + скачиваемый JSON (весь буфер). */

interface TransitionRecord {
  seed: number;
  cell: number | null;
  t0: number;
  t1: number | null;
  t2: number | null;
  t3: number | null;
  t4: number | null;
  t5: number | null;
  t6: number | null;
  t7: number | null;
  t8: number | null;
  maxFrameGapMs: number | null;
  alarming: boolean;
}

interface TransitionLogOptions {
  gpuDone: () => boolean;
  download?: (filename: string, text: string) => void;
}

/** ISO-подобная метка для имени файла: 2026-10-23-123456 (UTC). */
function stampForFilename(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

export function createTransitionLog(options: TransitionLogOptions) {
  const download = options.download || ((filename, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
  let record: TransitionRecord | null = null;
  const buffer: TransitionRecord[] = [];
  let rafId = 0;
  let prevFrameAt = 0;
  let maxGapMs = 0;
  let calmFrames = 0;

  function finish(): TransitionRecord | null {
    if (!record) return null;
    const finalRecord = record;
    record = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
    }
    finalRecord.maxFrameGapMs = maxGapMs > 0 ? maxGapMs : null;
    finalRecord.alarming = maxGapMs > 100;
    buffer.push(finalRecord);
    if (buffer.length > 20) {
      buffer.shift();
    }
    console.table(finalRecord);
    const now = new Date();
    download(
      `tl-${finalRecord.seed}-${finalRecord.cell ?? '?'}-${stampForFilename(now)}.json`,
      JSON.stringify(buffer)
    );
    return finalRecord;
  }

  function probe(): void {
    rafId = requestAnimationFrame(probe);
    const frameAt = performance.now();
    const gapMs = frameAt - prevFrameAt;
    prevFrameAt = frameAt;
    if (gapMs > maxGapMs) {
      maxGapMs = gapMs;
    }
    if (!record) return;
    if (record.t6 === null && record.t5 !== null && options.gpuDone()) {
      record.t6 = frameAt;
    }
    if (record.t7 === null && record.t6 !== null && frameAt > record.t6) {
      record.t7 = frameAt;
      calmFrames = 0;
    }
    if (record.t8 === null && record.t7 !== null) {
      calmFrames = gapMs <= 100 ? calmFrames + 1 : 0;
      if (calmFrames >= 5) {
        record.t8 = frameAt;
        finish();
      }
    }
  }

  return {
    start(seed: number): void {
      if (record) return;
      const startAt = performance.now();
      prevFrameAt = startAt;
      record = {
        seed,
        cell: null,
        t0: startAt,
        t1: null,
        t2: null,
        t3: null,
        t4: null,
        t5: null,
        t6: null,
        t7: null,
        t8: null,
        maxFrameGapMs: null,
        alarming: false,
      };
      maxGapMs = 0;
      calmFrames = 0;
      rafId = requestAnimationFrame(probe);
    },
    mark(phase: 't1' | 't2' | 't3' | 't4' | 't5', cell?: number): void {
      if (!record) return;
      record[phase] = performance.now();
      if (cell !== undefined && record.cell === null) {
        record.cell = cell;
      }
    },
    stop(): TransitionRecord | null {
      return finish();
    },
  };
}

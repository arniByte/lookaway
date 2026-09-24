import { config as defaultConfig, type Config } from '../config';
import { clamp, combineLids, lidScores, rawAxes } from './gaze';
import type { CalibrationProfile, RawFrame } from './types';

/** Кадры каждого шага калибровки (уже без settleMs в начале шага). */
export interface CalibSegments {
  center: RawFrame[];
  left: RawFrame[];
  right: RawFrame[];
  up: RawFrame[];
  down: RawFrame[];
  blinks: RawFrame[];
  closed: RawFrame[];
}

export interface CalibResult {
  profile: CalibrationProfile; // calibrated=false, если есть фатальные проблемы: такой профиль не сохранять
  warnings: string[];
  fatal: string[];
  blinkDurationsMs: number[];
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const faces = (fs: RawFrame[]) => fs.filter((f) => f.face);

/** Длительности эпизодов, где score ≥ threshold (для оценки длительности моргания). */
export function runDurations(frames: RawFrame[], score: (f: RawFrame) => number, threshold: number): number[] {
  const out: number[] = [];
  let start: number | null = null;
  for (const f of frames) {
    const on = score(f) >= threshold;
    if (on && start === null) start = f.t;
    if (!on && start !== null) {
      out.push(f.t - start);
      start = null;
    }
  }
  return out;
}

export function computeProfile(seg: CalibSegments, cfg: Config = defaultConfig): CalibResult {
  const warnings: string[] = [];
  const fatal: string[] = [];
  const openFrames = faces([...seg.center, ...seg.left, ...seg.right, ...seg.up, ...seg.down]);
  const closedFrames = faces(seg.closed);

  for (const [step, frames] of Object.entries(seg)) {
    const n = faces(frames).length;
    if (n < cfg.calibration.minFramesPerStep) fatal.push(`Шаг «${step}»: лицо почти не видно (${n} кадров с лицом).`);
  }

  const open = {
    L: median(openFrames.map((f) => f.blinkL)),
    R: median(openFrames.map((f) => f.blinkR)),
  };
  const shut = {
    L: median(closedFrames.map((f) => f.blinkL)),
    R: median(closedFrames.map((f) => f.blinkR)),
  };
  for (const eye of ['L', 'R'] as const) {
    const sep = shut[eye] - open[eye];
    if (!(sep >= cfg.calibration.minSeparation)) {
      fatal.push(
        `Глаз ${eye}: закрытые плохо отличаются от открытых (${sep.toFixed(2)}). Очки, блики или свет?`,
      );
    }
  }

  const axis = (fs: RawFrame[], key: 'h' | 'v') => median(faces(fs).map((f) => rawAxes(f, cfg)[key]));
  const h = { left: axis(seg.left, 'h'), center: axis(seg.center, 'h'), right: axis(seg.right, 'h') };
  const v = { down: axis(seg.down, 'v'), center: axis(seg.center, 'v'), up: axis(seg.up, 'v') };
  const minSpan = cfg.calibration.minGazeSpan;
  if (!((h.left - h.center) * (h.right - h.center) < 0)) {
    fatal.push('Влево и вправо не разошлись по разные стороны от центра: зоны L/R работать не будут.');
  } else if (Math.min(Math.abs(h.left - h.center), Math.abs(h.right - h.center)) < minSpan) {
    fatal.push(`Взгляд влево/вправо почти не меняет сигнал (< ${minSpan}): шум будет прыгать по зонам.`);
  }
  if (!((v.down - v.center) * (v.up - v.center) < 0)) {
    warnings.push('Вверх и вниз не разошлись по разные стороны от центра.');
  }

  const draft: CalibrationProfile = {
    version: 1,
    calibrated: true,
    open,
    shut,
    h,
    v,
    closedMs: cfg.lid.closedMsDefault,
  };

  const durations = runDurations(
    faces(seg.blinks),
    (f) => combineLids(lidScores(f, draft), cfg.lid.combine),
    (cfg.lid.onThreshold + cfg.lid.offThreshold) / 2,
  );
  if (durations.length < cfg.calibration.blinkCount - 1) {
    warnings.push(`Поймано морганий: ${durations.length} из ${cfg.calibration.blinkCount}. closedMs по умолчанию.`);
  } else {
    const [lo, hi] = cfg.lid.closedMsRange;
    draft.closedMs = Math.round(clamp(median(durations) * cfg.lid.closedMsPerBlink, lo, hi));
  }

  const finite = [open.L, open.R, shut.L, shut.R, h.left, h.center, h.right, v.down, v.center, v.up];
  if (finite.some((x) => !Number.isFinite(x)) && fatal.length === 0) fatal.push('Калибровка неполная.');
  draft.calibrated = fatal.length === 0;

  return { profile: draft, warnings: [...fatal, ...warnings], fatal, blinkDurationsMs: durations };
}

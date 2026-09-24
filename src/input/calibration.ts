// Калибровка v2 (TECH → Калибровка): 9 точек, приём по стабильности, отбраковка выбросов,
// ridge-регрессия взгляда, пороги век из шума конкретного человека, валидация и перецентровка.
import { config as defaultConfig, type Config } from '../config';
import { clamp, combineLids, gazeFeatures, lidScores, mapGaze, rawAxes } from './gaze';
import { dot, ridge } from './regression';
import type { CalibrationProfile, RawFrame } from './types';

export interface GazeTarget {
  x: number; // −1..1, x>0 — право
  y: number; // −1..1, y>0 — верх
}

export interface CalibPoint {
  target: GazeTarget;
  frames: RawFrame[];
}

export interface CalibData {
  points: CalibPoint[];
  blinks: RawFrame[];
  closed: RawFrame[];
  validation?: CalibPoint[];
}

export interface CalibResult {
  profile: CalibrationProfile; // calibrated=false, если есть фатальные проблемы: такой профиль не сохранять
  warnings: string[];
  fatal: string[];
  blinkDurationsMs: number[];
  /** Ошибка по каждой точке калибровки (единицы gaze). */
  residuals: number[];
  /** Средняя ошибка валидации или null, если валидации не было. */
  validationError: number | null;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Робастное СКО: 1.4826 × MAD. */
export function robustSigma(xs: number[]): number {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

const std = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

const faces = (fs: RawFrame[]) => fs.filter((f) => f.face);

/** 9 точек сеткой 3×3, центр первым: игрок начинает с естественного положения. */
export function calibrationGrid(cfg: Config = defaultConfig): GazeTarget[] {
  const g = cfg.calibration.gridAt;
  const pts: GazeTarget[] = [{ x: 0, y: 0 }];
  for (const y of [g, 0, -g]) for (const x of [-g, 0, g]) if (x || y) pts.push({ x, y });
  return pts;
}

export function validationTargets(cfg: Config = defaultConfig): GazeTarget[] {
  const v = cfg.calibration.validateAt;
  return [
    { x: -v, y: v },
    { x: v, y: -v },
    { x: v, y: v },
    { x: -v, y: -v },
  ];
}

/** Окно последних кадров стабильно: лицо есть, глаза не моргают, сырые оси почти не меняются. */
export function isStable(window: RawFrame[], cfg: Config = defaultConfig): boolean {
  if (window.length < cfg.calibration.stableWindow) return false;
  const w = window.slice(-cfg.calibration.stableWindow);
  if (w.some((f) => !f.face)) return false;
  const blink = w.map((f) => Math.min(f.blinkL, f.blinkR));
  if (Math.max(...blink) - Math.min(...blink) > 0.25) return false;
  const a = w.map((f) => rawAxes(f, cfg));
  return std(a.map((v) => v.h)) < cfg.calibration.stableStd && std(a.map((v) => v.v)) < cfg.calibration.stableStd;
}

/** Кадры точки, попавшие в стабильные окна, без выбросов (робастный z по признакам > 4). */
export function stableFrames(frames: RawFrame[], cfg: Config = defaultConfig): RawFrame[] {
  const fs = faces(frames);
  const n = cfg.calibration.stableWindow;
  const keep = new Set<number>();
  for (let i = n; i <= fs.length; i++) {
    if (isStable(fs.slice(i - n, i), cfg)) for (let j = i - n; j < i; j++) keep.add(j);
  }
  const picked = fs.filter((_, i) => keep.has(i));
  if (picked.length < 3) return picked;
  const feats = picked.map(gazeFeatures);
  const d = feats[0].length;
  const med: number[] = [];
  const sig: number[] = [];
  for (let j = 0; j < d; j++) {
    const col = feats.map((f) => f[j]);
    med.push(median(col));
    sig.push(robustSigma(col) || 1e-6);
  }
  return picked.filter((_, i) => feats[i].every((v, j) => j === 0 || Math.abs(v - med[j]) / sig[j] <= 4));
}

/** Длительности эпизодов, где score ≥ threshold (для оценки длительности моргания). */
export function runDurations(frames: RawFrame[], score: (f: RawFrame) => number, threshold: number): number[] {
  return runs(frames, score, threshold).map((r) => r.ms);
}

function runs(frames: RawFrame[], score: (f: RawFrame) => number, threshold: number): { ms: number; peak: number }[] {
  const out: { ms: number; peak: number }[] = [];
  let start: number | null = null;
  let peak = 0;
  for (const f of frames) {
    const s = score(f);
    if (s >= threshold) {
      if (start === null) {
        start = f.t;
        peak = 0;
      }
      peak = Math.max(peak, s);
    } else if (start !== null) {
      out.push({ ms: f.t - start, peak });
      start = null;
    }
  }
  return out;
}

/** Ошибка отображения по точкам: |pred(медиана признаков) − цель| для каждой точки. */
export function pointErrors(profile: CalibrationProfile, points: CalibPoint[], cfg: Config = defaultConfig): number[] {
  return points.map((p) => {
    const fs = stableFrames(p.frames, cfg);
    const use = fs.length ? fs : faces(p.frames);
    if (!use.length) return NaN;
    const preds = use.map((f) => mapGaze(f, profile, cfg));
    const px = median(preds.map((q) => q.x));
    const py = median(preds.map((q) => q.y));
    return Math.hypot(px - p.target.x, py - p.target.y);
  });
}

const mean = (xs: number[]) => {
  const ok = xs.filter(Number.isFinite);
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN;
};

export function computeProfile(data: CalibData, cfg: Config = defaultConfig): CalibResult {
  const warnings: string[] = [];
  const fatal: string[] = [];
  const cc = cfg.calibration;

  // 1. Точки с лицом и стабильным взглядом.
  const usable: { target: GazeTarget; frames: RawFrame[] }[] = [];
  data.points.forEach((p, i) => {
    const st = stableFrames(p.frames, cfg);
    if (st.length >= Math.min(cc.minStableFrames, cc.minFramesPerStep)) usable.push({ target: p.target, frames: st });
    else warnings.push(`Точка ${i + 1}: взгляд не удержался или лицо не видно — пропущена.`);
  });
  if (usable.length < 6) fatal.push(`Годных точек ${usable.length} из ${data.points.length}: нужно хотя бы 6.`);

  // 2. Веки: открытые — все кадры точек, закрытые — шаг с закрытыми глазами.
  const openFrames = faces(data.points.flatMap((p) => p.frames));
  const closedFrames = faces(data.closed);
  if (closedFrames.length < cc.minFramesPerStep) fatal.push(`Шаг «closed»: лицо почти не видно (${closedFrames.length} кадров).`);
  const open = { L: median(openFrames.map((f) => f.blinkL)), R: median(openFrames.map((f) => f.blinkR)) };
  const shut = { L: median(closedFrames.map((f) => f.blinkL)), R: median(closedFrames.map((f) => f.blinkR)) };
  for (const eye of ['L', 'R'] as const) {
    const sep = shut[eye] - open[eye];
    if (!(sep >= cc.minSeparation)) {
      fatal.push(`Глаз ${eye}: закрытые плохо отличаются от открытых (${sep.toFixed(2)}). Очки, блики или свет?`);
    }
  }

  // 3. Регрессия взгляда: все стабильные кадры, каждая точка весит одинаково.
  const X: number[][] = [];
  const yx: number[] = [];
  const yy: number[] = [];
  const w: number[] = [];
  for (const p of usable) {
    for (const f of p.frames) {
      X.push(gazeFeatures(f));
      yx.push(p.target.x);
      yy.push(p.target.y);
      w.push(1 / p.frames.length);
    }
  }
  const fx = X.length ? ridge(X, yx, w, cc.ridgeLambda) : null;
  const fy = X.length ? ridge(X, yy, w, cc.ridgeLambda) : null;
  if (!fx || !fy) fatal.push('Не удалось построить отображение взгляда.');

  // Объяснённая доля разброса по осям: взгляд влево-вправо должен реально менять сигнал.
  const r2 = (fit: { w: number[] } | null, key: 'x' | 'y') => {
    if (!fit || usable.length < 2) return 0;
    const ts = usable.map((p) => p.target[key]);
    const ps = usable.map((p) => median(p.frames.map((f) => dot(fit.w, gazeFeatures(f)))));
    const m = mean(ts);
    const ssTot = ts.reduce((a, t) => a + (t - m) ** 2, 0);
    const ssRes = ts.reduce((a, t, i) => a + (t - ps[i]) ** 2, 0);
    return ssTot > 0 ? 1 - ssRes / ssTot : 0;
  };
  const r2x = r2(fx, 'x');
  const r2y = r2(fy, 'y');
  if (fx && r2x < 0.5) fatal.push(`Взгляд влево/вправо почти не меняет сигнал (R² ${r2x.toFixed(2)}).`);
  if (fy && r2y < 0.5) warnings.push(`Взгляд вверх/вниз различается плохо (R² ${r2y.toFixed(2)}).`);

  // Легаси-оси v1 (оверлей, запасной путь): медианы в средних точках сетки.
  const axisAt = (tx: number, ty: number, key: 'h' | 'v') => {
    const p = usable.find((q) => Math.abs(q.target.x - tx) < 1e-6 && Math.abs(q.target.y - ty) < 1e-6);
    return p ? median(p.frames.map((f) => rawAxes(f, cfg)[key])) : NaN;
  };
  const g = cc.gridAt;
  const h = { left: axisAt(-g, 0, 'h'), center: axisAt(0, 0, 'h'), right: axisAt(g, 0, 'h') };
  const v = { down: axisAt(0, -g, 'v'), center: axisAt(0, 0, 'v'), up: axisAt(0, g, 'v') };

  const profile: CalibrationProfile = {
    version: 1,
    calibrated: false,
    open,
    shut,
    h,
    v,
    closedMs: cfg.lid.closedMsDefault,
    map: fx && fy ? { x: fx.w, y: fy.w } : undefined,
  };

  // 4. Пороги век из шума открытых глаз. Шум — по необрезанному сигналу: clamp в 0 прячет половину разброса.
  const rawNorm = (f: RawFrame) => {
    const n = (v: number, o: number, c: number) => (v - o) / Math.max(c - o, 1e-3);
    return combineLids({ L: n(f.blinkL, open.L, shut.L), R: n(f.blinkR, open.R, shut.R) }, cfg.lid.combine);
  };
  const openScores = openFrames.map(rawNorm); // все кадры точек: окна стабильности отобраны и по тихим векам — шум занижен
  const m0 = median(openScores);
  const sigma = robustSigma(openScores);
  const lc = cfg.lid;
  let on = clamp(Math.max(lc.onThreshold, m0 + lc.noiseSigmaOn * sigma), ...lc.onRange);
  let off = clamp(Math.max(lc.offThreshold, m0 + lc.noiseSigmaOff * sigma), ...lc.offRange);
  if (off > on - 0.1) off = on - 0.1;

  // Моргания по сигналу: пики должны доставать до on, иначе опускаем on (но не ниже шума).
  const score = (f: RawFrame) => combineLids(lidScores(f, profile), lc.combine);
  const blinks = runs(faces(data.blinks), score, off).filter((r) => r.ms < 1000);
  if (blinks.length >= 2) {
    const weakest = Math.min(...blinks.map((b) => b.peak));
    if (weakest < on) {
      const floor = m0 + lc.noiseSigmaOff * sigma + 0.05;
      const lowered = Math.max(off + 0.1, weakest * 0.9);
      if (lowered < floor) warnings.push('Шумный сигнал век: часть морганий может теряться. Больше света на лицо?');
      on = Math.max(lowered, off + 0.1);
    }
  }
  profile.lid = { on, off, confirm: sigma > lc.noisyConfirmSigma ? 2 : lc.confirmFrames };

  const durations = blinks.map((b) => b.ms);
  if (durations.length < cc.blinkCount - 2) {
    warnings.push(`Поймано морганий: ${durations.length} из ${cc.blinkCount}. closedMs по умолчанию.`);
  } else {
    const [lo, hi] = lc.closedMsRange;
    profile.closedMs = Math.round(clamp(median(durations) * lc.closedMsPerBlink, lo, hi));
  }

  // 5. Точность: на точках калибровки и (если есть) на отдельной валидации.
  const residuals = profile.map ? pointErrors(profile, data.points, cfg) : [];
  let validationError: number | null = null;
  if (profile.map && data.validation?.length) {
    validationError = mean(pointErrors(profile, data.validation, cfg));
    if (Number.isFinite(validationError)) {
      profile.accuracy = validationError;
      if (validationError > cc.maxValidationError) {
        warnings.push(`Точность ${(validationError * 50).toFixed(0)}% экрана — хуже нормы. Перекалибруй при лучшем свете.`);
      }
    }
  }

  const finite = [open.L, open.R, shut.L, shut.R];
  if (finite.some((x) => !Number.isFinite(x)) && fatal.length === 0) fatal.push('Калибровка неполная.');
  profile.calibrated = fatal.length === 0;
  return { profile, warnings: [...fatal, ...warnings], fatal, blinkDurationsMs: durations, residuals, validationError };
}

/** Перецентровка за 1 точку: сдвинуть свободные члены так, чтобы центр снова был центром. */
export function recenterProfile(p: CalibrationProfile, frames: RawFrame[], cfg: Config = defaultConfig): CalibrationProfile | null {
  const st = stableFrames(frames, cfg);
  if (st.length < cfg.calibration.minFramesPerStep) return null;
  if (p.map) {
    const px = median(st.map((f) => dot(p.map!.x, gazeFeatures(f))));
    const py = median(st.map((f) => dot(p.map!.y, gazeFeatures(f))));
    const x = [...p.map.x];
    const y = [...p.map.y];
    x[0] -= px;
    y[0] -= py;
    return { ...p, map: { x, y } };
  }
  const h = median(st.map((f) => rawAxes(f, cfg).h));
  const v = median(st.map((f) => rawAxes(f, cfg).v));
  const dh = h - p.h.center;
  const dv = v - p.v.center;
  return {
    ...p,
    h: { left: p.h.left + dh, center: h, right: p.h.right + dh },
    v: { down: p.v.down + dv, center: v, up: p.v.up + dv },
  };
}

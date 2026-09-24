import { config as defaultConfig, type Config, type LidCombine } from '../config';
import { OneEuro } from './filters';
import { LidMachine } from './lid';
import { dot } from './regression';
import type { CalibrationProfile, EyeEvent, EyeState, RawFrame } from './types';
import { ZoneTracker } from './zones';

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v: number): number => clamp(v, 0, 1);

const smoothstep = (lo: number, hi: number, v: number): number => {
  const k = clamp01((v - lo) / (hi - lo));
  return k * k * (3 - 2 * k);
};

export function defaultProfile(cfg: Config = defaultConfig): CalibrationProfile {
  return {
    version: 1,
    calibrated: false,
    open: { L: 0.05, R: 0.05 },
    shut: { L: 0.75, R: 0.75 },
    h: { left: -0.3, center: 0, right: 0.3 },
    v: { down: -0.2, center: 0, up: 0.2 },
    closedMs: cfg.lid.closedMsDefault,
  };
}

export function initialEyeState(t = 0, lost = true): EyeState {
  return {
    t,
    confidence: 0,
    lost,
    gaze: { x: 0, y: 0 },
    zone: 'C',
    blink: false,
    closed: false,
    wink: null,
    wide: 0,
    squint: 0,
    events: [],
  };
}

export function confidenceOf(f: RawFrame, cfg: Config = defaultConfig): number {
  if (!f.face) return 0;
  return smoothstep(cfg.signal.lumaLow, cfg.signal.lumaOk, f.luma);
}

/** Нормированный blink-score по глазам: 0 = открыты, 1 = закрыты (по профилю). open — адаптированный baseline. */
export function lidScores(
  f: RawFrame,
  p: CalibrationProfile,
  open: { L: number; R: number } = p.open,
): { L: number; R: number } {
  const norm = (v: number, o: number, shut: number) => (shut - o > 1e-3 ? clamp01((v - o) / (shut - o)) : 0);
  return { L: norm(f.blinkL, open.L, p.shut.L), R: norm(f.blinkR, open.R, p.shut.R) };
}

/** Признаки для регрессии взгляда (калибровка v2): свободный член, голова, глаза (blendshapes), зрачок. */
export function gazeFeatures(f: RawFrame): number[] {
  const lookH = (f.lookInL - f.lookOutL + (f.lookOutR - f.lookInR)) / 2;
  const lookV = (f.lookUpL + f.lookUpR - (f.lookDownL + f.lookDownR)) / 2;
  return [1, f.headYaw, f.headPitch, lookH, lookV, f.irisX, f.irisY];
}

/** Взгляд −1..1 по профилю: регрессия v2 или кусочно-линейно по осям v1. До One Euro. */
export function mapGaze(f: RawFrame, p: CalibrationProfile, cfg: Config = defaultConfig): { x: number; y: number } {
  if (p.map) {
    const feats = gazeFeatures(f);
    return { x: clamp(dot(p.map.x, feats), -1.2, 1.2), y: clamp(dot(p.map.y, feats), -1.2, 1.2) };
  }
  const a = rawAxes(f, cfg);
  return {
    x: mapAxis(a.h, p.h.left, p.h.center, p.h.right, cfg.gaze.calibTarget),
    y: mapAxis(a.v, p.v.down, p.v.center, p.v.up, cfg.gaze.calibTarget),
  };
}

export function combineLids(s: { L: number; R: number }, mode: LidCombine): number {
  switch (mode) {
    case 'min':
      return Math.min(s.L, s.R);
    case 'max':
      return Math.max(s.L, s.R);
    case 'mean':
      return (s.L + s.R) / 2;
    case 'L':
      return s.L;
    case 'R':
      return s.R;
  }
}

/** Сырые оси взгляда до калибровки: голова + глаза. Знак и масштаб — любые. */
export function rawAxes(f: RawFrame, cfg: Config = defaultConfig): { h: number; v: number } {
  let eyeH: number;
  let eyeV: number;
  if (cfg.gaze.eyeSignal === 'iris') {
    eyeH = f.irisX;
    eyeV = f.irisY;
  } else {
    eyeH = (f.lookInL - f.lookOutL + (f.lookOutR - f.lookInR)) / 2;
    eyeV = (f.lookUpL + f.lookUpR - (f.lookDownL + f.lookDownR)) / 2;
  }
  return {
    h: cfg.gaze.headWeight * f.headYaw + cfg.gaze.eyeWeight * eyeH,
    v: cfg.gaze.headWeight * f.headPitch + cfg.gaze.eyeWeight * eyeV,
  };
}

/**
 * Кусочно-линейное отображение сырого значения в −1..1: neg → −target, center → 0, pos → +target.
 * Знак берётся из калибровки, поэтому зеркалирование и имена L/R на результат не влияют.
 */
export function mapAxis(v: number, neg: number, center: number, pos: number, target: number): number {
  const d = v - center;
  const toPos = pos - center;
  const toNeg = neg - center;
  if (d * toPos >= 0) return Math.abs(toPos) > 1e-6 ? clamp((target * d) / toPos, -1, 1) : 0;
  return Math.abs(toNeg) > 1e-6 ? clamp((-target * d) / toNeg, -1, 1) : 0;
}

/** RawFrame + профиль → EyeState. Один экземпляр на поток кадров. */
export class GazeProcessor {
  readonly lid: LidMachine;
  readonly zones: ZoneTracker;
  private fx: OneEuro;
  private fy: OneEuro;
  private state: EyeState;
  private lowSince: number | null = null;
  private highSince: number | null = null;
  private winkCand: 'L' | 'R' | null = null;
  private winkSince = 0;
  /** Адаптивный baseline открытых глаз (свет, усталость). */
  openBase: { L: number; R: number };
  private baseT: number | null = null;
  /** Последний нормированный score (для оверлея). */
  lastScore = 0;

  constructor(
    public profile: CalibrationProfile,
    private cfg: Config = defaultConfig,
  ) {
    this.lid = new LidMachine({
      onThreshold: profile.lid?.on ?? cfg.lid.onThreshold,
      offThreshold: profile.lid?.off ?? cfg.lid.offThreshold,
      confirmFrames: profile.lid?.confirm ?? cfg.lid.confirmFrames,
      closedMs: profile.closedMs,
    });
    this.openBase = { ...profile.open };
    this.zones = new ZoneTracker({ ...cfg.zones });
    const e = cfg.gaze.oneEuro;
    this.fx = new OneEuro(e.minCutoff, e.beta, e.dCutoff);
    this.fy = new OneEuro(e.minCutoff, e.beta, e.dCutoff);
    this.state = initialEyeState(0, true);
  }

  setProfile(p: CalibrationProfile): void {
    this.profile = p;
    this.lid.params.closedMs = p.closedMs;
    this.lid.params.onThreshold = p.lid?.on ?? this.cfg.lid.onThreshold;
    this.lid.params.offThreshold = p.lid?.off ?? this.cfg.lid.offThreshold;
    this.lid.params.confirmFrames = p.lid?.confirm ?? this.cfg.lid.confirmFrames;
    this.openBase = { ...p.open };
    this.baseT = null;
    this.fx.reset();
    this.fy.reset();
  }

  get current(): EyeState {
    return this.state;
  }

  /** Медленно подтянуть baseline открытых глаз, только пока веки уверенно открыты. */
  private adaptBaseline(f: RawFrame, confidentlyOpen: boolean): void {
    const prevT = this.baseT;
    this.baseT = f.t;
    if (!confidentlyOpen || prevT === null) return;
    const k = 1 - Math.exp(-(f.t - prevT) / this.cfg.lid.baselineTauMs);
    const p = this.profile;
    for (const eye of ['L', 'R'] as const) {
      const raw = eye === 'L' ? f.blinkL : f.blinkR;
      const lim = this.cfg.lid.baselineMaxDrift * Math.max(p.shut[eye] - p.open[eye], 0);
      const next = this.openBase[eye] + (raw - this.openBase[eye]) * k;
      this.openBase[eye] = clamp(next, p.open[eye] - lim, p.open[eye] + lim);
    }
  }

  /** Обработать кадр. Возвращает состояние с событиями только этого кадра. */
  process(f: RawFrame): EyeState {
    const cfg = this.cfg;
    const events: EyeEvent[] = [];
    const conf = confidenceOf(f, cfg);
    const prev = this.state;
    let lost = prev.lost;

    if (!lost) {
      if (conf < cfg.signal.lostBelow) {
        this.lowSince ??= f.t;
        if (f.t - this.lowSince >= cfg.signal.lostAfterMs) {
          this.lid.reset(f.t, events);
          this.winkCand = null;
          lost = true;
          this.lowSince = null;
          events.push('signalLost');
        }
      } else {
        this.lowSince = null;
      }
    } else if (conf >= cfg.signal.backAbove) {
      this.highSince ??= f.t;
      if (f.t - this.highSince >= cfg.signal.backAfterMs) {
        lost = false;
        this.highSince = null;
        this.fx.reset();
        this.fy.reset();
        events.push('signalBack');
      }
    } else {
      this.highSince = null;
    }

    // Потерян или кадр ненадёжен: состояние заморожено, веки считаются открытыми.
    if (lost || conf < cfg.signal.lostBelow) {
      this.state = {
        ...prev,
        t: f.t,
        confidence: conf,
        lost,
        blink: lost ? false : prev.blink,
        closed: lost ? false : prev.closed,
        wink: lost ? null : prev.wink,
        events,
      };
      return this.state;
    }

    // Веки.
    let s = lidScores(f, this.profile, this.openBase);
    if (cfg.lid.swapLR) s = { L: s.R, R: s.L };
    const score = combineLids(s, cfg.lid.combine);
    this.lastScore = score;
    const phase = this.lid.update(score, f.t, events);
    const open = phase === 'open';
    this.adaptBaseline(f, open && Math.max(s.L, s.R) < this.lid.params.offThreshold * 0.6);

    // Подмигивание: один глаз закрыт, другой открыт, держится winkMinMs.
    let wink: 'L' | 'R' | null = null;
    const hi = Math.max(s.L, s.R);
    const lo = Math.min(s.L, s.R);
    const cand =
      open && hi >= this.lid.params.onThreshold && lo <= this.lid.params.offThreshold && hi - lo >= cfg.lid.winkAsym
        ? s.L > s.R
          ? 'L'
          : 'R'
        : null;
    if (cand !== this.winkCand) {
      this.winkCand = cand;
      this.winkSince = f.t;
    }
    if (cand && f.t - this.winkSince >= cfg.lid.winkMinMs) wink = cand;

    const meanLid = (s.L + s.R) / 2;
    const squint = open && !wink ? clamp01((meanLid - cfg.lid.squintFrom) / (this.lid.params.onThreshold - cfg.lid.squintFrom)) : 0;
    const wide = open ? clamp01(((f.wideL + f.wideR) / 2 - cfg.wide.from) / (cfg.wide.to - cfg.wide.from)) : 0;

    // Взгляд: заморожен, пока веки сомкнуты, и ещё holdAfterShutMs после открытия.
    let gaze = prev.gaze;
    let zone = prev.zone;
    if (open && f.t - this.lid.lastOpenAt >= cfg.gaze.holdAfterShutMs) {
      const { x, y } = mapGaze(f, this.profile, cfg);
      gaze = { x: this.fx.filter(x, f.t), y: this.fy.filter(y, f.t) };
      zone = this.zones.update(gaze.x, f.t, events);
    }

    this.state = {
      t: f.t,
      confidence: conf,
      lost: false,
      gaze,
      zone,
      blink: phase === 'blink',
      closed: phase === 'closed',
      wink,
      wide,
      squint,
      events,
    };
    return this.state;
  }
}

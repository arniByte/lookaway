import { config as defaultConfig, type Config, type LidCombine } from '../config';
import { OneEuro } from './filters';
import { LidMachine } from './lid';
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

/** Нормированный blink-score по глазам: 0 = открыты, 1 = закрыты (по профилю). */
export function lidScores(f: RawFrame, p: CalibrationProfile): { L: number; R: number } {
  const norm = (v: number, open: number, shut: number) =>
    shut - open > 1e-3 ? clamp01((v - open) / (shut - open)) : 0;
  return { L: norm(f.blinkL, p.open.L, p.shut.L), R: norm(f.blinkR, p.open.R, p.shut.R) };
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
  /** Последний нормированный score (для оверлея). */
  lastScore = 0;

  constructor(
    public profile: CalibrationProfile,
    private cfg: Config = defaultConfig,
  ) {
    this.lid = new LidMachine({
      onThreshold: cfg.lid.onThreshold,
      offThreshold: cfg.lid.offThreshold,
      confirmFrames: cfg.lid.confirmFrames,
      closedMs: profile.closedMs,
    });
    this.zones = new ZoneTracker({ ...cfg.zones });
    const e = cfg.gaze.oneEuro;
    this.fx = new OneEuro(e.minCutoff, e.beta, e.dCutoff);
    this.fy = new OneEuro(e.minCutoff, e.beta, e.dCutoff);
    this.state = initialEyeState(0, true);
  }

  setProfile(p: CalibrationProfile): void {
    this.profile = p;
    this.lid.params.closedMs = p.closedMs;
    this.fx.reset();
    this.fy.reset();
  }

  get current(): EyeState {
    return this.state;
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
    let s = lidScores(f, this.profile);
    if (cfg.lid.swapLR) s = { L: s.R, R: s.L };
    const score = combineLids(s, cfg.lid.combine);
    this.lastScore = score;
    const phase = this.lid.update(score, f.t, events);
    const open = phase === 'open';

    // Подмигивание: один глаз закрыт, другой открыт, держится winkMinMs.
    let wink: 'L' | 'R' | null = null;
    const hi = Math.max(s.L, s.R);
    const lo = Math.min(s.L, s.R);
    const cand =
      open && hi >= cfg.lid.onThreshold && lo <= cfg.lid.offThreshold && hi - lo >= cfg.lid.winkAsym
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
    const squint = open && !wink ? clamp01((meanLid - cfg.lid.squintFrom) / (cfg.lid.onThreshold - cfg.lid.squintFrom)) : 0;
    const wide = open ? clamp01(((f.wideL + f.wideR) / 2 - cfg.wide.from) / (cfg.wide.to - cfg.wide.from)) : 0;

    // Взгляд: заморожен, пока веки сомкнуты, и ещё holdAfterShutMs после открытия.
    let gaze = prev.gaze;
    let zone = prev.zone;
    if (open && f.t - this.lid.lastOpenAt >= cfg.gaze.holdAfterShutMs) {
      const a = rawAxes(f, cfg);
      const p = this.profile;
      const x = mapAxis(a.h, p.h.left, p.h.center, p.h.right, cfg.gaze.calibTarget);
      const y = mapAxis(a.v, p.v.down, p.v.center, p.v.up, cfg.gaze.calibTarget);
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

// Синтетические потоки RawFrame с известной разметкой. Страховка логики, не замена живым фикстурам.
import { config } from '../src/config';
import { PROTOCOLS } from '../src/input/protocols';
import { calibrationGrid, validationTargets, type CalibData, type GazeTarget } from '../src/input/calibration';
import type { CalibrationProfile, Cue, Fixture, ProtocolId, RawFrame, Zone } from '../src/input/types';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Truth {
  open: { L: number; R: number };
  shut: { L: number; R: number };
  headPerUnit: number; // headYaw на единицу цели (L=-1, C=0, R=+1)
  eyePerUnit: number; // eyeLook на единицу цели
  mirror: boolean; // перевернуть знак горизонтали (другая конвенция имён/зеркала)
  luma: number;
  lidNoise?: number; // шум blink-сигнала (по умолчанию — общий noise)
  lidCommon?: number; // общий для обоих глаз шум век (свет, голова) — именно он даёт ложные моргания
  eyeNoise?: number; // шум eyeLook* (по умолчанию — общий noise)
  crossTalk?: number; // вертикаль взгляда протекает в горизонтальный сигнал глаз
  yawBias?: number; // голова сдвинулась после калибровки
  openDrift?: (t: number) => number; // дрейф blink-сигнала открытых глаз (свет, усталость)
}

export const TRUTH: Truth = {
  open: { L: 0.06, R: 0.08 },
  shut: { L: 0.82, R: 0.78 },
  headPerUnit: 0.04,
  eyePerUnit: 0.25,
  mirror: false,
  luma: 0.35,
};

/** Сценарий: интервалы смыкания, взгляд по времени, потеря сигнала. */
export interface Script {
  durationMs: number;
  shut?: { t: number; ms: number; eye?: 'L' | 'R' }[]; // eye — подмигивание одним глазом
  looks?: { t: number; zone: Zone; y?: number }[];
  lost?: { t: number; ms: number; how: 'noface' | 'dark' }[];
  /** Произвольный горизонтальный взгляд в единицах цели (перекрывает looks). */
  gazeFn?: (t: number) => number;
  /** Произвольный 2D-взгляд в единицах цели (перекрывает всё остальное). */
  gaze2?: (t: number) => { x: number; y: number };
}

export interface SynthOptions {
  seed?: number;
  hz?: number;
  noise?: number;
  truth?: Partial<Truth>;
}

const CLOSE_RAMP = 60;
const OPEN_RAMP = 120;
const SACCADE = 80;
const zoneUnit = (z: Zone) => (z === 'L' ? -1 : z === 'R' ? 1 : 0);

function closureAt(t: number, s: Script['shut']): { both: number; L: number; R: number } {
  let L = 0;
  let R = 0;
  for (const iv of s ?? []) {
    const a = iv.t;
    const b = iv.t + iv.ms;
    let c = 0;
    if (t >= a - CLOSE_RAMP && t < a) c = (t - (a - CLOSE_RAMP)) / CLOSE_RAMP;
    else if (t >= a && t <= b) c = 1;
    else if (t > b && t < b + OPEN_RAMP) c = 1 - (t - b) / OPEN_RAMP;
    if (iv.eye !== 'R') L = Math.max(L, c);
    if (iv.eye !== 'L') R = Math.max(R, c);
  }
  return { both: Math.min(L, R), L, R };
}

function gazeAt(t: number, script: Script): { x: number; y: number } {
  if (script.gaze2) return script.gaze2(t);
  if (script.gazeFn) return { x: script.gazeFn(t), y: 0 };
  let x = 0;
  let y = 0;
  let prevX = 0;
  let prevY = 0;
  for (const l of script.looks ?? []) {
    if (t < l.t) break;
    prevX = x;
    prevY = y;
    x = zoneUnit(l.zone);
    y = l.y ?? 0;
    const k = Math.min(1, (t - l.t) / SACCADE);
    if (k < 1) {
      return { x: prevX + (x - prevX) * k, y: prevY + (y - prevY) * k };
    }
  }
  return { x, y };
}

export function synthFrames(script: Script, opts: SynthOptions = {}): RawFrame[] {
  const rnd = mulberry32(opts.seed ?? 1);
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const tr = { ...TRUTH, ...opts.truth };
  const hz = opts.hz ?? 30;
  const sigma = opts.noise ?? 0.02;
  const n = (s = sigma) => s * gauss();
  const frames: RawFrame[] = [];
  const dt = 1000 / hz;

  for (let t = 0; t <= script.durationMs; t += dt) {
    const lost = (script.lost ?? []).find((l) => t >= l.t && t < l.t + l.ms);
    const clo = closureAt(t, script.shut);
    const g = gazeAt(t, script);
    const sign = tr.mirror ? -1 : 1;
    // Горизонталь в анатомической конвенции: взгляд вправо = lookInL + lookOutR.
    const eyeH = sign * (g.x + (tr.crossTalk ?? 0) * g.y) * tr.eyePerUnit;
    const eyeV = g.y * tr.eyePerUnit;
    const garbage = clo.both > 0.5; // при сомкнутых веках eyeLook* — мусор
    const look = (v: number) => (garbage ? rnd() * 0.6 : Math.max(0, v + n(tr.eyeNoise ?? sigma)));
    const drift = tr.openDrift?.(t) ?? 0;
    const lidN = tr.lidNoise ?? sigma;
    const common = n(tr.lidCommon ?? 0);

    const f: RawFrame = {
      t: Math.round(t),
      face: lost?.how === 'noface' ? 0 : 1,
      luma: lost?.how === 'dark' ? 0.02 : tr.luma + n(0.01),
      blinkL: tr.open.L + drift + clo.L * (tr.shut.L - tr.open.L - drift) + common + n(lidN),
      blinkR: tr.open.R + drift + clo.R * (tr.shut.R - tr.open.R - drift) + common + n(lidN),
      squintL: 0.1 + n(),
      squintR: 0.1 + n(),
      wideL: 0.05 + n(),
      wideR: 0.05 + n(),
      lookInL: look(Math.max(0, eyeH)),
      lookOutL: look(Math.max(0, -eyeH)),
      lookInR: look(Math.max(0, -eyeH)),
      lookOutR: look(Math.max(0, eyeH)),
      lookUpL: look(Math.max(0, eyeV)),
      lookUpR: look(Math.max(0, eyeV)),
      lookDownL: look(Math.max(0, -eyeV)),
      lookDownR: look(Math.max(0, -eyeV)),
      headYaw: sign * g.x * tr.headPerUnit + (tr.yawBias ?? 0) + n(0.005),
      headPitch: g.y * tr.headPerUnit + n(0.005),
      irisX: sign * g.x * 0.15 + n(0.01),
      irisY: g.y * 0.1 + n(0.01),
    };
    if (!f.face) {
      for (const k of Object.keys(f) as (keyof RawFrame)[]) if (k !== 't') f[k] = 0;
    }
    frames.push(f);
  }
  return frames;
}

/** Профиль, который получился бы из идеальной калибровки по TRUTH. */
export function truthProfile(truth: Partial<Truth> = {}, closedMs = 500): CalibrationProfile {
  const tr = { ...TRUTH, ...truth };
  const sign = tr.mirror ? -1 : 1;
  // rawAxes: headWeight × yaw + eyeWeight × eyeH
  const { headWeight: hw, eyeWeight: ew } = config.gaze;
  const unitV = hw * tr.headPerUnit + ew * tr.eyePerUnit;
  const unit = sign * unitV;
  return {
    version: 1,
    calibrated: true,
    open: { ...tr.open },
    shut: { ...tr.shut },
    h: { left: -unit, center: 0, right: unit },
    v: { down: -unitV, center: 0, up: unitV },
    closedMs,
  };
}

/** Взгляд на цель в координатах gaze (−1..1) → единицы синтетики (1 = центр зоны, 2/3 экрана). */
export const toUnit = (t: GazeTarget) => ({ x: t.x / config.gaze.calibTarget, y: t.y / config.gaze.calibTarget });

/** Держать взгляд на цели ms миллисекунд (с саккадой в начале: первые кадры ещё едут от центра). */
export function holdGaze(target: GazeTarget, ms: number, opts: SynthOptions = {}): RawFrame[] {
  const u = toUnit(target);
  return synthFrames(
    { durationMs: ms, gaze2: (t) => { const k = Math.min(1, t / 250); return { x: u.x * k, y: u.y * k }; } },
    opts,
  );
}

/** Данные калибровки v2, как их собрал бы мастер: 9 точек, моргания, закрытые глаза, валидация. */
export function synthCalibration(opts: SynthOptions = {}): CalibData {
  const seed0 = opts.seed ?? 11;
  return {
    points: calibrationGrid().map((target, i) => ({ target, frames: holdGaze(target, 1500, { ...opts, seed: seed0 + i }) })),
    validation: validationTargets().map((target, i) => ({ target, frames: holdGaze(target, 1300, { ...opts, seed: seed0 + 50 + i }) })),
    blinks: synthFrames(
      { durationMs: 6500, shut: [800, 2000, 3200, 4400, 5600].map((t, i) => ({ t, ms: 140 + i * 15 })) },
      { ...opts, seed: seed0 + 30 },
    ),
    closed: synthFrames({ durationMs: 2000, shut: [{ t: -500, ms: 5000 }] }, { ...opts, seed: seed0 + 31 }),
  };
}

/** Фикстура протокола, как её записал бы идеальный игрок (с реакцией и естественными морганиями). */
export function synthProtocol(id: ProtocolId, opts: SynthOptions = {}): Fixture {
  const p = PROTOCOLS[id];
  const reaction = 300;
  const script: Script = { durationMs: p.durationMs, shut: [], looks: [], lost: [] };
  const cues: Cue[] = p.cues.map((c) => ({ ...c }));
  switch (id) {
    case 'calm':
      for (let t = 1500; t < p.durationMs; t += 4000 + ((t * 7) % 1500)) script.shut!.push({ t, ms: 140 });
      script.gazeFn = (t) => 0.3 * Math.sin(t / 2300) + 0.15 * Math.sin(t / 700);
      break;
    case 'blinks':
      for (const c of cues) script.shut!.push({ t: c.t + reaction, ms: 150 });
      break;
    case 'zones':
      for (const c of cues) script.looks!.push({ t: c.t + reaction, zone: c.zone! });
      break;
    case 'closed':
      for (const c of cues) script.shut!.push({ t: c.t + reaction, ms: c.durMs! });
      break;
    case 'lost':
      for (const c of cues) script.lost!.push({ t: c.t + reaction, ms: c.durMs!, how: 'noface' });
      break;
  }
  return {
    version: 1,
    meta: {
      name: `synthetic-${id}`,
      protocol: id,
      recordedAt: '1970-01-01T00:00:00.000Z',
      durationMs: p.durationMs,
      conditions: { glasses: false, light: 'normal' },
      profile: truthProfile(opts.truth),
      cues,
      synthetic: true,
    },
    frames: synthFrames(script, opts),
  };
}

import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import {
  computeProfile,
  isStable,
  pointErrors,
  recenterProfile,
  validationTargets,
  type CalibPoint,
} from '../src/input/calibration';
import { GazeProcessor, mapAxis, rawAxes } from '../src/input/gaze';
import type { CalibrationProfile, EyeEvent, RawFrame } from '../src/input/types';
import { holdGaze, synthCalibration, synthFrames, type SynthOptions, type Truth } from './synthetic';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Ошибка старого отображения v1 (фиксированные веса головы/глаз + кусочно-линейно по осям). */
function v1Error(profile: CalibrationProfile, points: CalibPoint[]): number {
  const g = config.calibration.gridAt;
  return mean(
    points.map((p) => {
      const a = p.frames.filter((f) => f.face).slice(10).map((f) => rawAxes(f));
      const h = a.map((q) => q.h).sort((x, y) => x - y)[a.length >> 1];
      const v = a.map((q) => q.v).sort((x, y) => x - y)[a.length >> 1];
      const x = mapAxis(h, profile.h.left, profile.h.center, profile.h.right, g);
      const y = mapAxis(v, profile.v.down, profile.v.center, profile.v.up, g);
      return Math.hypot(x - p.target.x, y - p.target.y);
    }),
  );
}

const USERS: Record<string, Partial<Truth>> = {
  обычный: {},
  'головой, не глазами': { headPerUnit: 0.12, eyePerUnit: 0.05 },
  'глазами, не головой': { headPerUnit: 0.005, eyePerUnit: 0.4 },
  зеркало: { mirror: true },
};

describe('калибровка v2: точность', () => {
  it.each(Object.entries(USERS))('%s — валидация точнее 0.12', (_, truth) => {
    const res = computeProfile(synthCalibration({ truth }));
    expect(res.fatal).toEqual([]);
    expect(res.profile.calibrated).toBe(true);
    expect(res.validationError!).toBeLessThan(0.12);
    expect(res.profile.accuracy).toBeCloseTo(res.validationError!, 6);
  });

  it('регрессия заметно точнее фиксированных весов v1: перекрёстная связь осей + шумные глаза', () => {
    const opts: SynthOptions = { truth: { crossTalk: 0.5, eyeNoise: 0.06, headPerUnit: 0.08 } };
    const data = synthCalibration(opts);
    const res = computeProfile(data);
    const v2 = mean(pointErrors(res.profile, data.validation!));
    const v1 = v1Error(res.profile, data.validation!);
    expect(v2).toBeLessThan(v1 * 0.7);
  });

  it('знак правильный при зеркале: взгляд вправо → x > 0', () => {
    const res = computeProfile(synthCalibration({ truth: { mirror: true } }));
    const gp = new GazeProcessor(res.profile);
    let last = gp.current;
    for (const f of holdGaze({ x: 0.6, y: 0 }, 2000, { truth: { mirror: true }, seed: 5 })) last = gp.process(f);
    expect(last.gaze.x).toBeGreaterThan(0.4);
    expect(last.zone).toBe('R');
  });
});

describe('калибровка v2: отказ вместо плохого профиля', () => {
  it('закрытые ≈ открытые → fatal', () => {
    const data = synthCalibration();
    data.closed = data.points[0].frames;
    const res = computeProfile(data);
    expect(res.profile.calibrated).toBe(false);
    expect(res.fatal.some((w) => w.includes('Глаз'))).toBe(true);
  });

  it('взгляд не меняет сигнал → fatal', () => {
    const data = synthCalibration();
    data.points = data.points.map((p) => ({ ...p, frames: data.points[0].frames }));
    expect(computeProfile(data).profile.calibrated).toBe(false);
  });

  it('две точки без лица — пропущены, профиль принят; четыре — отказ', () => {
    const noFace = (p: CalibPoint) => ({ ...p, frames: p.frames.map((f) => ({ ...f, face: 0 })) });
    const two = synthCalibration();
    two.points = two.points.map((p, i) => (i === 3 || i === 7 ? noFace(p) : p));
    const r2 = computeProfile(two);
    expect(r2.profile.calibrated).toBe(true);
    expect(r2.warnings.filter((w) => w.startsWith('Точка')).length).toBe(2);

    const four = synthCalibration();
    four.points = four.points.map((p, i) => (i >= 1 && i <= 4 ? noFace(p) : p));
    expect(computeProfile(four).profile.calibrated).toBe(false);
  });
});

describe('стабильность взгляда', () => {
  it('фиксация стабильна, саккада и моргание — нет', () => {
    const fix = holdGaze({ x: 0.5, y: 0 }, 1500, { seed: 1 });
    expect(isStable(fix.slice(-10))).toBe(true);
    const sacc = synthFrames({ durationMs: 600, gaze2: (t) => ({ x: t < 300 ? -1 : 1, y: 0 }) }, { seed: 2 });
    expect(isStable(sacc.slice(5, 13))).toBe(false);
    const blink = synthFrames({ durationMs: 600, shut: [{ t: 200, ms: 150 }] }, { seed: 3 });
    expect(isStable(blink.slice(4, 12))).toBe(false);
  });
});

function countBlinks(profile: CalibrationProfile, frames: RawFrame[]): number {
  const gp = new GazeProcessor(profile);
  let n = 0;
  for (const f of frames) n += gp.process(f).events.filter((e: EyeEvent) => e === 'blinkStart').length;
  return n;
}

describe('пороги век из шума', () => {
  it('чистые глаза — пороги по умолчанию', () => {
    const p = computeProfile(synthCalibration()).profile;
    expect(p.lid!.on).toBeCloseTo(config.lid.onThreshold, 6);
    expect(p.lid!.off).toBeCloseTo(config.lid.offThreshold, 6);
  });

  it('шумные веки (общий шум обоих глаз) — пороги выше, ложных морганий нет, настоящие ловятся', () => {
    const truth = { lidCommon: 0.15 };
    const p = computeProfile(synthCalibration({ truth })).profile;
    expect(p.lid!.on).toBeGreaterThan(config.lid.onThreshold);

    const calm = synthFrames({ durationMs: 120_000 }, { truth, seed: 9 });
    const withDefaults = { ...p, lid: undefined };
    expect(countBlinks(withDefaults, calm)).toBeGreaterThan(0); // по умолчанию — ложные срабатывания
    expect(countBlinks(p, calm)).toBe(0);

    const shut = Array.from({ length: 10 }, (_, i) => ({ t: 1000 + i * 1500, ms: 160 }));
    expect(countBlinks(p, synthFrames({ durationMs: 16_000, shut }, { truth, seed: 10 }))).toBeGreaterThanOrEqual(9);
  });
});

describe('адаптивный baseline открытых глаз', () => {
  const drift = (t: number) => Math.min(0.3, (t / 90_000) * 0.3); // +0.3 за полторы минуты
  const shut = Array.from({ length: 40 }, (_, i) => ({ t: 3000 + i * 3000, ms: 150 }));

  it('догоняет медленный дрейф: без ложных морганий и без пропусков', () => {
    const p = computeProfile(synthCalibration()).profile;
    const frames = synthFrames({ durationMs: 125_000, shut }, { truth: { openDrift: drift }, seed: 21 });
    expect(countBlinks(p, frames)).toBe(40);
  });

  it('долгое закрытие не «съедается» baseline-ом', () => {
    const p = computeProfile(synthCalibration()).profile;
    const gp = new GazeProcessor(p);
    const events: EyeEvent[] = [];
    for (const f of synthFrames({ durationMs: 30_000, shut: [{ t: 2000, ms: 25_000 }] }, { seed: 22 })) {
      events.push(...gp.process(f).events);
    }
    expect(events.filter((e) => e === 'closeEnd')).toHaveLength(1);
    const closeEndAt = events.indexOf('closeEnd');
    expect(events.slice(0, closeEndAt).filter((e) => e === 'blinkEnd')).toHaveLength(0);
  });
});

describe('перецентровка', () => {
  it('голова сдвинулась после калибровки — одна точка возвращает точность', () => {
    const p = computeProfile(synthCalibration()).profile;
    const shifted = { yawBias: 0.04 };
    const val = validationTargets().map((target, i) => ({ target, frames: holdGaze(target, 1300, { truth: shifted, seed: 70 + i }) }));
    const before = mean(pointErrors(p, val));
    const fixed = recenterProfile(p, holdGaze({ x: 0, y: 0 }, 1500, { truth: shifted, seed: 80 }))!;
    const after = mean(pointErrors(fixed, val));
    expect(before).toBeGreaterThan(0.15);
    expect(after).toBeLessThan(before / 2);
  });
});

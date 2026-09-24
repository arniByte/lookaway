import { describe, expect, it } from 'vitest';
import { computeProfile } from '../src/input/calibration';
import { runFixture } from '../src/input/evaluate';
import { GazeProcessor, mapAxis } from '../src/input/gaze';
import type { EyeEvent, EyeState, Fixture, RawFrame } from '../src/input/types';
import { synthCalibration, synthFrames, truthProfile, type Script } from './synthetic';

function run(frames: RawFrame[], profile = truthProfile()) {
  const gp = new GazeProcessor(profile);
  const states: EyeState[] = [];
  const events: { t: number; e: EyeEvent }[] = [];
  for (const f of frames) {
    const s = gp.process(f);
    states.push(s);
    for (const e of s.events) events.push({ t: s.t, e });
  }
  return { states, events, count: (e: EyeEvent) => events.filter((x) => x.e === e).length };
}

const at = (states: EyeState[], t: number) => states.filter((s) => s.t <= t).at(-1)!;

describe('GazeProcessor: веки', () => {
  it('ловит все моргания и ни одного лишнего на шуме', () => {
    const shut = Array.from({ length: 20 }, (_, i) => ({ t: 1000 + i * 1500, ms: 120 + (i % 4) * 40 }));
    const r = run(synthFrames({ durationMs: 32_000, shut }, { seed: 3 }));
    expect(r.count('blinkStart')).toBe(20);
    expect(r.count('blinkEnd')).toBe(20);
    expect(r.count('closeStart')).toBe(0);
  });

  it('5 минут шума без морганий — ноль срабатываний', () => {
    const r = run(synthFrames({ durationMs: 300_000 }, { seed: 4, noise: 0.03 }));
    expect(r.count('blinkStart')).toBe(0);
    expect(r.count('zoneChange')).toBe(0);
  });

  it('закрытые глаза отличаются от моргания', () => {
    const r = run(synthFrames({ durationMs: 5000, shut: [{ t: 1000, ms: 200 }, { t: 2500, ms: 1500 }] }, { seed: 5 }));
    expect(r.events.filter((x) => x.e !== 'signalBack').map((x) => x.e)).toEqual([
      'blinkStart', 'blinkEnd', 'blinkStart', 'closeStart', 'closeEnd',
    ]);
    expect(r.states.every((s) => !(s.blink && s.closed))).toBe(true);
  });

  it('подмигивание не считается морганием (combine=min) и даёт wink', () => {
    const r = run(synthFrames({ durationMs: 3000, shut: [{ t: 1000, ms: 600, eye: 'L' }] }, { seed: 6 }));
    expect(r.count('blinkStart')).toBe(0);
    expect(r.states.some((s) => s.wink === 'L')).toBe(true);
    expect(r.states.some((s) => s.wink === 'R')).toBe(false);
  });
});

describe('GazeProcessor: зоны', () => {
  it('последовательность взглядов даёт правильные зоны', () => {
    const looks = [
      { t: 1000, zone: 'L' as const },
      { t: 2000, zone: 'C' as const },
      { t: 3000, zone: 'R' as const },
      { t: 4000, zone: 'L' as const },
    ];
    const r = run(synthFrames({ durationMs: 5000, looks }, { seed: 7 }));
    for (const l of looks) expect(at(r.states, l.t + 700).zone).toBe(l.zone);
    expect(r.count('zoneChange')).toBe(4);
  });

  it('взгляд на границе зон с шумом не дребезжит', () => {
    // x ≈ граница C/R (1/3) ± шум
    const unit = 0.5; // 0.5 × 2/3 = 1/3
    const r = run(synthFrames({ durationMs: 20_000, gazeFn: () => unit }, { seed: 8, noise: 0.04 }));
    expect(r.count('zoneChange')).toBeLessThanOrEqual(1);
  });

  it('gaze заморожен, пока веки сомкнуты (eyeLook* — мусор)', () => {
    const r = run(synthFrames({ durationMs: 6000, looks: [{ t: -100, zone: 'L' }], shut: [{ t: 1000, ms: 2500 }] }, { seed: 9 }));
    const shut = r.states.filter((s) => s.blink || s.closed);
    expect(shut.length).toBeGreaterThan(50);
    expect(new Set(shut.map((s) => s.zone))).toEqual(new Set(['L']));
    const xs = shut.map((s) => s.gaze.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(0);
    expect(r.count('zoneChange')).toBe(1);
  });
});

describe('GazeProcessor: потеря сигнала', () => {
  const script = (how: 'noface' | 'dark'): Script => ({ durationMs: 5000, lost: [{ t: 1500, ms: 1500, how }] });

  it.each(['noface', 'dark'] as const)('%s → signalLost/signalBack, никогда не closed', (how) => {
    const r = run(synthFrames(script(how), { seed: 10 }));
    expect(r.count('signalLost')).toBe(1);
    expect(r.count('signalBack')).toBe(2); // старт + возврат
    expect(r.count('closeStart')).toBe(0);
    expect(r.count('blinkStart')).toBe(0);
    expect(at(r.states, 2500).lost).toBe(true);
    expect(at(r.states, 4500).lost).toBe(false);
  });

  it('выпавшие 100 мс не ставят паузу', () => {
    const r = run(synthFrames({ durationMs: 3000, lost: [{ t: 1500, ms: 100, how: 'noface' }] }, { seed: 11 }));
    expect(r.count('signalLost')).toBe(0);
  });

  it('потеря при закрытых глазах сначала закрывает интервал', () => {
    const r = run(
      synthFrames({ durationMs: 5000, shut: [{ t: 1000, ms: 3500 }], lost: [{ t: 2000, ms: 1500, how: 'noface' }] }, { seed: 12 }),
    );
    const seq = r.events.map((x) => x.e).filter((e) => e !== 'signalBack');
    expect(seq.slice(0, 4)).toEqual(['blinkStart', 'closeStart', 'closeEnd', 'signalLost']);
    let open = 0;
    for (const e of seq) {
      if (e === 'blinkStart') open++;
      if (e === 'blinkEnd' || e === 'closeEnd') open--;
      expect(open).toBeGreaterThanOrEqual(0);
    }
  });

  it('старт в lost=true, signalBack после стабилизации', () => {
    const r = run(synthFrames({ durationMs: 1500 }, { seed: 13 }));
    expect(r.states[0].lost).toBe(true);
    expect(r.events[0]).toEqual({ t: expect.any(Number), e: 'signalBack' });
    expect(r.events[0].t).toBeGreaterThanOrEqual(500);
  });
});

describe('Калибровка', () => {
  it('mapAxis: знак берётся из калибровки', () => {
    expect(mapAxis(0.3, -0.3, 0, 0.3, 2 / 3)).toBeCloseTo(2 / 3);
    expect(mapAxis(0.3, 0.3, 0, -0.3, 2 / 3)).toBeCloseTo(-2 / 3);
    expect(mapAxis(-0.15, -0.3, 0, 0.3, 2 / 3)).toBeCloseTo(-1 / 3);
    expect(mapAxis(5, -0.3, 0, 0.3, 2 / 3)).toBe(1);
  });

  it('профиль из синтетических сегментов близок к истине', () => {
    const { profile, warnings } = computeProfile(synthCalibration());
    expect(warnings).toEqual([]);
    expect(profile.open.L).toBeCloseTo(0.06, 1);
    expect(profile.shut.R).toBeCloseTo(0.78, 1);
    expect(profile.h.right - profile.h.center).toBeGreaterThan(0.3);
    expect(profile.closedMs).toBeGreaterThanOrEqual(350);
    expect(profile.closedMs).toBeLessThanOrEqual(900);
  });

  it.each([false, true])('зоны верны при mirror=%s после калибровки', (mirror) => {
    const { profile } = computeProfile(synthCalibration({ truth: { mirror } }));
    const looks = [
      { t: 1000, zone: 'L' as const },
      { t: 2500, zone: 'R' as const },
    ];
    const r = run(synthFrames({ durationMs: 4000, looks }, { seed: 14, truth: { mirror } }), profile);
    expect(at(r.states, 1800).zone).toBe('L');
    expect(at(r.states, 3300).zone).toBe('R');
    expect(at(r.states, 3300).gaze.x).toBeGreaterThan(0);
  });

  it('очки/блики: плохое разделение даёт предупреждение', () => {
    const seg = synthCalibration({ truth: { shut: { L: 0.15, R: 0.8 } } });
    const { warnings } = computeProfile(seg);
    expect(warnings.some((w) => w.includes('Глаз L'))).toBe(true);
  });
});

describe('runFixture', () => {
  it('гонит кадры через GazeProcessor с профилем фикстуры', () => {
    const fx: Fixture = {
      version: 1,
      meta: {
        name: 't', protocol: 'blinks', recordedAt: '', durationMs: 3000,
        conditions: { glasses: false, light: 'normal' }, profile: truthProfile(), cues: [],
      },
      frames: synthFrames({ durationMs: 3000, shut: [{ t: 1500, ms: 150 }] }, { seed: 15 }),
    };
    expect(runFixture(fx).events.map((e) => e.e)).toEqual(['signalBack', 'blinkStart', 'blinkEnd']);
  });
});

describe('Калибровка: провал не затирает профиль', () => {
  it('закрытые ≈ открытые → calibrated=false и fatal', () => {
    const seg = synthCalibration();
    seg.closed = seg.center; // «закрыл» глаза, а трекер видит открытые
    const res = computeProfile(seg);
    expect(res.profile.calibrated).toBe(false);
    expect(res.fatal.length).toBeGreaterThan(0);
  });

  it('взгляд влево/вправо не меняет сигнал → calibrated=false', () => {
    const seg = synthCalibration();
    seg.left = seg.center;
    seg.right = seg.center;
    expect(computeProfile(seg).profile.calibrated).toBe(false);
  });

  it('нормальная калибровка → calibrated=true, fatal пуст', () => {
    const res = computeProfile(synthCalibration());
    expect(res.profile.calibrated).toBe(true);
    expect(res.fatal).toEqual([]);
  });
});

it('шаг калибровки без лица называется по имени', () => {
  const seg = synthCalibration();
  seg.up = seg.up.map((f) => ({ ...f, face: 0 }));
  const res = computeProfile(seg);
  expect(res.profile.calibrated).toBe(false);
  expect(res.fatal.some((w) => w.includes('«up»'))).toBe(true);
});

import { describe, expect, it } from 'vitest';
import { LidMachine } from '../src/input/lid';
import type { EyeEvent } from '../src/input/types';

const params = { onThreshold: 0.55, offThreshold: 0.35, confirmFrames: 1, closedMs: 500 };

function drive(scores: [number, number][]) {
  const lid = new LidMachine({ ...params });
  const log: { t: number; e: EyeEvent }[] = [];
  const phases: string[] = [];
  for (const [t, s] of scores) {
    const ev: EyeEvent[] = [];
    phases.push(lid.update(s, t, ev));
    for (const e of ev) log.push({ t, e });
  }
  return { log, phases, lid };
}

const series = (fn: (t: number) => number, ms: number, dt = 33) => {
  const out: [number, number][] = [];
  for (let t = 0; t <= ms; t += dt) out.push([t, fn(t)]);
  return out;
};

describe('LidMachine', () => {
  it('короткое моргание: blinkStart → blinkEnd', () => {
    const { log } = drive(series((t) => (t >= 100 && t < 250 ? 0.9 : 0.05), 600));
    expect(log.map((x) => x.e)).toEqual(['blinkStart', 'blinkEnd']);
  });

  it('закрытие: blinkStart → closeStart → closeEnd, без blinkEnd', () => {
    const { log } = drive(series((t) => (t >= 100 && t < 1500 ? 0.9 : 0.05), 2000));
    expect(log.map((x) => x.e)).toEqual(['blinkStart', 'closeStart', 'closeEnd']);
    expect(log[1].t - log[0].t).toBeGreaterThanOrEqual(500);
  });

  it('гистерезис: колебания между порогами не дают дребезга', () => {
    const { log } = drive(series((t) => (t < 100 ? 0.05 : t < 1000 ? (Math.floor(t / 33) % 2 ? 0.5 : 0.4) : 0.05), 1200));
    expect(log).toEqual([]);
  });

  it('confirmFrames=2 требует двух кадров подряд', () => {
    const lid = new LidMachine({ ...params, confirmFrames: 2 });
    const ev: EyeEvent[] = [];
    lid.update(0.9, 0, ev);
    lid.update(0.1, 33, ev);
    lid.update(0.9, 66, ev);
    expect(ev).toEqual([]);
    lid.update(0.9, 99, ev);
    expect(ev).toEqual(['blinkStart']);
  });

  it('reset закрывает открытый интервал парным событием', () => {
    const lid = new LidMachine({ ...params });
    const ev: EyeEvent[] = [];
    lid.update(0.9, 0, ev);
    lid.update(0.9, 600, ev);
    lid.reset(700, ev);
    expect(ev).toEqual(['blinkStart', 'closeStart', 'closeEnd']);
    expect(lid.phase).toBe('open');
  });
});

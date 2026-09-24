import { describe, expect, it } from 'vitest';
import { evaluate, formatReport } from '../src/input/evaluate';
import { fixtureFromJson, fixtureToJson } from '../src/input/fixture';
import type { ProtocolId } from '../src/input/types';
import { synthProtocol } from './synthetic';

const ALL: ProtocolId[] = ['calm', 'blinks', 'zones', 'closed', 'lost'];

describe('evaluate на синтетических протоколах', () => {
  it.each(ALL)('%s проходит', (id) => {
    const r = evaluate(synthProtocol(id, { seed: 21 }));
    expect(r.ok, formatReport(r)).toBe(true);
  });

  it('blinks: пропущенные моргания валят отчёт', () => {
    const fx = synthProtocol('blinks', { seed: 22 });
    // Два сигнала без моргания: 10/12 < ceil(12 × 0.9) = 11.
    fx.meta.cues = [...fx.meta.cues, { t: 33_000, kind: 'blink' }, { t: 34_000, kind: 'blink' }];
    const r = evaluate(fx);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith('поймано'))?.detail).toBe('10/12');
  });

  it('zones: игрок смотрит не туда — FAIL', () => {
    const fx = synthProtocol('zones', { seed: 23 });
    fx.meta.cues = fx.meta.cues.map((c) => ({ ...c, zone: c.zone === 'L' ? 'R' : c.zone === 'R' ? 'L' : 'C' }));
    expect(evaluate(fx).ok).toBe(false);
  });

  it('lost: если рука трактуется как закрытые глаза — FAIL', () => {
    const fx = synthProtocol('closed', { seed: 24 });
    fx.meta.protocol = 'lost';
    fx.meta.cues = fx.meta.cues.map((c) => ({ ...c, kind: 'cover' as const }));
    expect(evaluate(fx).ok).toBe(false);
  });
});

describe('формат фикстуры', () => {
  it('roundtrip через JSON сохраняет кадры с точностью 1e-3', () => {
    const fx = synthProtocol('blinks', { seed: 25 });
    const json = fixtureToJson(fx);
    const back = fixtureFromJson(json);
    expect(back.meta).toEqual(fx.meta);
    expect(back.frames.length).toBe(fx.frames.length);
    back.frames.forEach((f, i) => {
      expect(f.blinkL).toBeCloseTo(fx.frames[i].blinkL, 3);
      expect(f.headYaw).toBeCloseTo(fx.frames[i].headYaw, 3);
    });
    expect(evaluate(back).ok).toBe(true);
    // ~ размер минуты записи для TECH.md
    const perMinKb = json.length / 1024 / (fx.meta.durationMs / 60_000);
    expect(perMinKb).toBeLessThan(400);
  });

  it('отсутствующие колонки — понятная ошибка', () => {
    const file = JSON.parse(fixtureToJson(synthProtocol('calm', { seed: 26 })));
    file.columns[3] = 'nope';
    expect(() => fixtureFromJson(JSON.stringify(file))).toThrow(/blinkL/);
  });
});

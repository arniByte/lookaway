import { describe, expect, it } from 'vitest';
import { bearingTo, headingOf, wrapAngle } from '../src/game/nav';
import { ringDirections } from '../src/render/lidar';
import { dailySeed } from '../src/world/random';

describe('компас', () => {
  it('курс: yaw 0 — север (−z), поворот налево — запад', () => {
    expect(headingOf(0)).toBeCloseTo(0);
    expect(headingOf(Math.PI / 2)).toBeCloseTo(-Math.PI / 2); // вперёд −x
    expect(bearingTo(-1, 0)).toBeCloseTo(-Math.PI / 2);
    expect(bearingTo(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(bearingTo(0, 1)).toBeCloseTo(Math.PI);
  });

  it('wrapAngle — в (−π, π]', () => {
    for (const a of [-7, -Math.PI, 0, 3, Math.PI, 9, 100]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI - 1e-9);
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a));
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a));
    }
  });
});

describe('лучи сканера', () => {
  const { dir, seed, foot } = ringDirections(60_000, 120, 0.55);
  const n = seed.length;

  it('около заданного числа, единичные, детерминированы', () => {
    expect(Math.abs(n - 60_000) / 60_000).toBeLessThan(0.02);
    for (let i = 0; i < n; i += 97) expect(Math.hypot(dir[i * 3], dir[i * 3 + 1], dir[i * 3 + 2])).toBeCloseTo(1, 5);
    expect(Array.from(ringDirections(60_000, 120, 0.55).dir.slice(0, 30))).toEqual(Array.from(dir.slice(0, 30)));
    expect(foot).toBeGreaterThan(0);
  });

  it('кольца гуще у горизонта, зенит пустой', () => {
    const ys = new Set<number>();
    let nearHorizon = 0;
    let steep = 0;
    for (let i = 0; i < n; i++) {
      const y = dir[i * 3 + 1];
      ys.add(Math.round(y * 1e5));
      if (Math.abs(y) < 0.2) nearHorizon++;
      if (y < -0.6) steep++;
      expect(y).toBeLessThan(0.91);
    }
    expect(ys.size).toBe(120); // одно значение угла места на канал
    expect(nearHorizon).toBeGreaterThan(steep * 2);
  });
});

describe('мир дня', () => {
  it('ГГГГММДД по локальной дате', () => {
    expect(dailySeed(new Date(2026, 8, 24, 23, 59))).toBe(20260924);
    expect(dailySeed(new Date(2027, 0, 1))).toBe(20270101);
  });
});

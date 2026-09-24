import { describe, expect, it } from 'vitest';
import { OneEuro } from '../src/input/filters';

describe('OneEuro', () => {
  it('постоянный вход не меняется', () => {
    const f = new OneEuro(1, 0.3, 1);
    for (let t = 0; t < 1000; t += 33) expect(f.filter(0.5, t)).toBeCloseTo(0.5, 9);
  });

  it('ступенька сходится, шум гасится', () => {
    const f = new OneEuro(1, 0.3, 1);
    let out = 0;
    for (let t = 0; t < 2000; t += 33) out = f.filter(t < 100 ? 0 : 0.66, t);
    expect(out).toBeCloseTo(0.66, 2);

    const g = new OneEuro(1, 0.3, 1);
    let maxDev = 0;
    for (let t = 0; t < 3000; t += 33) {
      const v = g.filter(0.2 + (Math.sin(t * 12.9898) * 43758.5453 % 1) * 0.04, t);
      if (t > 500) maxDev = Math.max(maxDev, Math.abs(v - 0.2));
    }
    expect(maxDev).toBeLessThan(0.03);
  });
});

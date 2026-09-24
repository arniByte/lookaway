import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { sampleSurface } from '../src/world/sample';
import { makeRng } from '../src/world/random';

describe('точки по площади поверхности', () => {
  it('на двух квадратах 1×1 и 3×3 доли точек ≈ 1:9, все точки на поверхности', () => {
    const a = new THREE.PlaneGeometry(1, 1);
    const b = new THREE.PlaneGeometry(3, 3).translate(10, 0, 0);
    const geo = new THREE.BufferGeometry();
    const pos = [...a.getAttribute('position').array, ...b.getAttribute('position').array];
    const nrm = [...a.getAttribute('normal').array, ...b.getAttribute('normal').array];
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('aRefl', new THREE.Float32BufferAttribute(new Array(8).fill(0.5), 1));
    geo.setIndex([0, 2, 1, 2, 3, 1, 4, 6, 5, 6, 7, 5]);
    const s = sampleSurface(geo, 10_000, makeRng(1));
    let big = 0;
    for (let i = 0; i < 10_000; i++) {
      const x = s.pos[i * 3];
      if (x > 5) {
        big++;
        expect(Math.abs(x - 10)).toBeLessThanOrEqual(1.5 + 1e-6);
      } else expect(Math.abs(x)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(s.pos[i * 3 + 2]).toBeCloseTo(0, 6);
    }
    expect(big / 10_000).toBeGreaterThan(0.87);
    expect(big / 10_000).toBeLessThan(0.93);
    expect(s.refl[5]).toBeCloseTo(0.5, 6);
  });
});

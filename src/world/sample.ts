// Точки на поверхности меша, равномерно по площади: детальный скан образца (GDD → Наука).
import type * as THREE from 'three';
import type { Rng } from './random';

export interface SurfaceSamples {
  pos: Float32Array; // n × 3
  nrm: Float32Array; // n × 3
  refl: Float32Array; // n
  rand: Float32Array; // n, порядок появления точек при скане
}

export function sampleSurface(geo: THREE.BufferGeometry, n: number, rnd: Rng): SurfaceSamples {
  const P = geo.getAttribute('position');
  const N = geo.getAttribute('normal');
  const R = geo.getAttribute('aRefl');
  const idx = geo.getIndex();
  const tri = idx ? idx.count / 3 : P.count / 3;
  const at = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);

  const cum = new Float64Array(tri);
  let total = 0;
  for (let t = 0; t < tri; t++) {
    const a = at(t, 0);
    const b = at(t, 1);
    const c = at(t, 2);
    const ux = P.getX(b) - P.getX(a);
    const uy = P.getY(b) - P.getY(a);
    const uz = P.getZ(b) - P.getZ(a);
    const vx = P.getX(c) - P.getX(a);
    const vy = P.getY(c) - P.getY(a);
    const vz = P.getZ(c) - P.getZ(a);
    total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    cum[t] = total;
  }

  const out: SurfaceSamples = {
    pos: new Float32Array(n * 3),
    nrm: new Float32Array(n * 3),
    refl: new Float32Array(n),
    rand: new Float32Array(n),
  };
  if (total <= 0) return out;
  for (let i = 0; i < n; i++) {
    const x = rnd() * total;
    let lo = 0;
    let hi = tri - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    let u = rnd();
    let v = rnd();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const w = 1 - u - v;
    const a = at(lo, 0);
    const b = at(lo, 1);
    const c = at(lo, 2);
    for (let k = 0; k < 3; k++) {
      const get = (A: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, j: number) => (k === 0 ? A.getX(j) : k === 1 ? A.getY(j) : A.getZ(j));
      out.pos[i * 3 + k] = w * get(P, a) + u * get(P, b) + v * get(P, c);
      out.nrm[i * 3 + k] = w * get(N, a) + u * get(N, b) + v * get(N, c);
    }
    out.refl[i] = R ? w * R.getX(a) + u * R.getX(b) + v * R.getX(c) : 0.5;
    out.rand[i] = rnd();
  }
  return out;
}

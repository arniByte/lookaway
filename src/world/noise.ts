// 2D simplex noise (Gustavson), сидируемый перестановкой. + fbm. Без зависимостей.
import { makeRng } from './random';

const G = [
  [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1],
] as const;
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export type Noise2 = (x: number, y: number) => number;

export function simplex2(seed: number): Noise2 {
  const r = makeRng(seed);
  const p = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];

  return (xin, yin) => {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const corner = (x: number, y: number, gi: number) => {
      const tt = 0.5 - x * x - y * y;
      if (tt < 0) return 0;
      const g = G[gi % 8];
      return tt * tt * tt * tt * (g[0] * x + g[1] * y);
    };
    const n0 = corner(x0, y0, p[ii + p[jj]]);
    const n1 = corner(x1, y1, p[ii + i1 + p[jj + j1]]);
    const n2 = corner(x2, y2, p[ii + 1 + p[jj + 1]]);
    return 70 * (n0 + n1 + n2); // ~ −1..1
  };
}

/** Фрактальный шум: сумма октав, ~ −1..1. */
export function fbm(n: Noise2, x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * n(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

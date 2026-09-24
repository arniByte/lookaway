// Детерминированный ГПСЧ для генерации мира. Один seed — один мир (GDD → Мир).

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Дочерний поток: одна подсистема не сдвигает случайность другой при изменениях. */
export function fork(seed: number, salt: string): Rng {
  let h = seed >>> 0;
  for (let i = 0; i < salt.length; i++) h = Math.imul(h ^ salt.charCodeAt(i), 0x9e3779b1) >>> 0;
  return makeRng(h);
}

export const range = (r: Rng, lo: number, hi: number): number => lo + (hi - lo) * r();
export const int = (r: Rng, lo: number, hi: number): number => Math.floor(range(r, lo, hi + 1));
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length];
export const chance = (r: Rng, p: number): boolean => r() < p;

export function gauss(r: Rng): number {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** «Мир дня»: одинаковый у всех в эту дату (локальную) — ГГГГММДД. */
export function dailySeed(d = new Date()): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

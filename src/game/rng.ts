/** mulberry32: состояние — одно число, поэтому GameState остаётся простыми данными. */
export function nextRandom(state: { rng: number }): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const randRange = (state: { rng: number }, [lo, hi]: readonly [number, number]): number =>
  lo + (hi - lo) * nextRandom(state);

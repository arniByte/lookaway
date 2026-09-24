// Линия видимости по коллайдерам (стволы, камни, пни, статуи): за стволом тебя не видно — и его тоже.
import type { Collider } from '../world/worldgen';
import type { SpatialGrid } from './grid';

/** Расстояние от точки до отрезка AB. */
export function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** true — между A и B есть коллайдер толще minR. Коллайдер, внутри которого конец отрезка, не в счёт. */
export function lineBlocked(grid: SpatialGrid<Collider>, ax: number, az: number, bx: number, bz: number, minR = 0.12): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(len / 4));
  const seen = new Set<Collider>();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    for (const c of grid.near(ax + (bx - ax) * t, az + (bz - az) * t, 3)) {
      if (seen.has(c) || c.r < minR) continue;
      seen.add(c);
      if (Math.hypot(c.x - ax, c.z - az) < c.r || Math.hypot(c.x - bx, c.z - bz) < c.r) continue;
      if (segDist(c.x, c.z, ax, az, bx, bz) < c.r * 0.9) return true;
    }
  }
  return false;
}

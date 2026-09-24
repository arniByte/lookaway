// Силуэт (GDD → Угроза). Двигается, только когда на него не смотрят: глаза закрыты, моргнул,
// отвернулся, он за стволом. Взгляд на нём — стоит (не дольше holdMaxMs). Куда идти, решает директор
// (director.ts): выслеживать от ствола к стволу, подойти вплотную, отступить, охотиться. Чистая логика.
import { config as defaultConfig, type Config } from '../config';
import type { PoseName } from '../world/meshes';
import type { Rng } from '../world/random';
import type { Collider, World } from '../world/worldgen';
import type { SpatialGrid } from './grid';
import { wrapAngle } from './nav';

export type StalkerMode = 'dormant' | 'stalk' | 'approach' | 'hunt' | 'retreat';
/** Как игрок его видит сейчас: взглядом в упор, просто в поле зрения, никак. */
export type Seen = 'gaze' | 'view' | 'none';

export interface Stalker {
  x: number;
  y: number;
  z: number;
  heading: number; // поворот фигуры вокруг Y (локальный +Z → направление)
  vx: number; // м/с — для доплера в скане и звука шагов
  vz: number;
  awake: boolean;
  mode: StalkerMode;
  goal: { x: number; z: number; cover: boolean } | null;
  replanAt: number;
  held: boolean;
  heldMs: number;
  freeMs: number;
  stepAcc: number;
}

export interface StalkerCtx {
  time: number;
  player: { x: number; z: number; yaw: number };
  eyesClosed: boolean;
  blinkStart: boolean;
  seen: Seen;
  mode: StalkerMode; // от директора
  desiredDist: number; // от директора
}

export function createStalker(world: World): Stalker {
  const s = world.stalkerSpawn;
  return { x: s.x, y: s.y, z: s.z, heading: 0, vx: 0, vz: 0, awake: false, mode: 'dormant', goal: null, replanAt: 0, held: false, heldMs: 0, freeMs: 0, stepAcc: 0 };
}

export const distTo = (s: Stalker, x: number, z: number) => Math.hypot(s.x - x, s.z - z);

/** Слышит импульс (или бег ближе hearRun): просыпается и сразу пересматривает цель. */
export function hear(s: Stalker, x: number, z: number, radius: number): boolean {
  if (distTo(s, x, z) > radius) return false;
  s.awake = true;
  s.replanAt = 0;
  return true;
}

/** Поворот лицом к точке. */
export const faceTo = (s: Stalker, x: number, z: number) => Math.atan2(x - s.x, z - s.z);

/**
 * Укрытие: точка за стволом со стороны от игрока, на желаемой дистанции, лучше — вне поля зрения.
 * Нет стволов рядом — просто за спиной игрока.
 */
export function pickCover(s: Stalker, ctx: StalkerCtx, trees: SpatialGrid<Collider>, rng: Rng, cfg: Config = defaultConfig): { x: number; z: number; cover: boolean } {
  const sc = cfg.stalker;
  const { x: px, z: pz, yaw } = ctx.player;
  const R = ctx.desiredDist;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  let best: { x: number; z: number; cover: boolean } | null = null;
  let bestScore = -Infinity;
  for (const c of trees.near(px, pz, R + 8)) {
    if (c.r < 0.12 || c.r > 0.7) continue;
    const dx = c.x - px;
    const dz = c.z - pz;
    const d = Math.hypot(dx, dz);
    if (d < 2 || Math.abs(d - R) > 8) continue;
    const hx = c.x + (dx / d) * (c.r + sc.coverRadius);
    const hz = c.z + (dz / d) * (c.r + sc.coverRadius);
    const dh = Math.hypot(hx - px, hz - pz);
    const ang = Math.acos(Math.max(-1, Math.min(1, ((hx - px) * fx + (hz - pz) * fz) / dh)));
    let score = -Math.abs(dh - R) * 0.6 + (ang > sc.viewHalfAngle + 0.15 ? 3 : -1.5) - Math.hypot(hx - s.x, hz - s.z) * 0.04 + rng() * 0.8;
    if (ctx.mode === 'approach') score -= dh * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = { x: hx, z: hz, cover: true };
    }
  }
  if (best) return best;
  const a = Math.atan2(-fx, -fz) + (rng() - 0.5) * 1.2; // за спиной
  return { x: px + Math.sin(a) * R, z: pz + Math.cos(a) * R, cover: false };
}

/** Шаг. 'kill' — дотянулся, 'step' — шаг (для звука), null — ничего. */
export function stepStalker(
  s: Stalker,
  dtMs: number,
  ctx: StalkerCtx,
  world: World,
  grid: SpatialGrid<Collider>,
  rng: Rng,
  cfg: Config = defaultConfig,
): 'kill' | 'step' | null {
  const sc = cfg.stalker;
  const dt = dtMs / 1000;
  const { x: px, z: pz } = ctx.player;
  s.mode = s.awake ? ctx.mode : 'dormant';
  if (!s.awake) {
    s.vx = s.vz = 0;
    s.heading = faceTo(s, px, pz);
    return null;
  }

  // Взгляд держит, но не вечно (анти-кемпинг): потом он медленно идёт и под взглядом.
  if (ctx.seen === 'gaze' && !ctx.eyesClosed) {
    s.heldMs += dtMs;
    s.freeMs = 0;
  } else {
    s.freeMs += dtMs;
    if (s.freeMs >= sc.holdResetMs) s.heldMs = 0;
  }
  s.held = ctx.seen === 'gaze' && !ctx.eyesClosed && s.heldMs < sc.holdMaxMs;

  const toPlayer = distTo(s, px, pz);
  // Моргание — рывок, но не ближе safeDist: моргание не убивает напрямую.
  if (ctx.blinkStart && s.mode !== 'retreat' && toPlayer > sc.safeDist) {
    const leap = Math.min(sc.blinkLeap, toPlayer - sc.safeDist);
    s.x += ((px - s.x) / toPlayer) * leap;
    s.z += ((pz - s.z) / toPlayer) * leap;
  }

  // Цель.
  if (s.mode === 'hunt' || (s.mode === 'approach' && toPlayer < 8)) {
    s.goal = { x: px, z: pz, cover: false };
  } else if (s.mode === 'retreat') {
    if (!s.goal || ctx.time >= s.replanAt) {
      const d = toPlayer || 1;
      const R = world.radius - 8;
      let gx = px + ((s.x - px) / d) * 45;
      let gz = pz + ((s.z - pz) / d) * 45;
      const r = Math.hypot(gx, gz);
      if (r > R) {
        gx *= R / r;
        gz *= R / r;
      }
      s.goal = { x: gx, z: gz, cover: false };
      s.replanAt = ctx.time + sc.replanMs[1];
    }
  } else if (!s.goal || ctx.time >= s.replanAt || Math.hypot(s.goal.x - s.x, s.goal.z - s.z) < 0.5) {
    s.goal = pickCover(s, ctx, grid, rng, cfg);
    s.replanAt = ctx.time + sc.replanMs[0] + rng() * (sc.replanMs[1] - sc.replanMs[0]);
  }

  // Скорость: под взглядом стоит, в поле зрения крадётся, вне — идёт; глаза закрыты — быстрее всего.
  const base = s.mode === 'hunt' ? sc.huntSpeed : s.mode === 'approach' ? sc.approachSpeed : s.mode === 'retreat' ? sc.retreatSpeed : sc.speed;
  const mul = ctx.eyesClosed ? sc.closedMul : ctx.seen === 'gaze' ? (s.held ? 0 : sc.creepMul) : ctx.seen === 'view' ? sc.creepMul : 1;
  const ox = s.x;
  const oz = s.z;
  const g = s.goal!;
  const dg = Math.hypot(g.x - s.x, g.z - s.z);
  if (dg > 0.05 && mul > 0) {
    const stepLen = Math.min(dg, base * mul * dt);
    let dx = (g.x - s.x) / dg;
    let dz = (g.z - s.z) / dg;
    // Препятствие по курсу — скользит по касательной в сторону цели (иначе упрётся в ствол навсегда).
    for (const c of grid.near(s.x, s.z, 2)) {
      const nx = s.x + dx * 0.6 - c.x;
      const nz = s.z + dz * 0.6 - c.z;
      if (Math.hypot(nx, nz) >= c.r + 0.3) continue;
      const ox = s.x - c.x;
      const oz = s.z - c.z;
      const od = Math.hypot(ox, oz) || 1;
      let tx = -oz / od;
      let tz = ox / od;
      if (tx * dx + tz * dz < 0) {
        tx = -tx;
        tz = -tz;
      }
      dx = tx;
      dz = tz;
    }
    s.x += dx * stepLen;
    s.z += dz * stepLen;
    for (const c of grid.near(s.x, s.z, 2)) {
      const dx = s.x - c.x;
      const dz = s.z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + 0.3;
      if (d < min && d > 1e-6) {
        s.x = c.x + (dx / d) * min;
        s.z = c.z + (dz / d) * min;
      }
    }
  }
  const moved = Math.hypot(s.x - ox, s.z - oz);
  s.vx = dt > 0 ? (s.x - ox) / dt : 0;
  s.vz = dt > 0 ? (s.z - oz) / dt : 0;
  s.y = world.height(s.x, s.z);
  s.heading = moved > 1e-4 ? Math.atan2(s.x - ox, s.z - oz) : faceTo(s, px, pz);

  const now = distTo(s, px, pz);
  if ((s.mode === 'approach' || s.mode === 'hunt') && now < sc.killDist) return 'kill';
  s.stepAcc += moved;
  if (s.stepAcc > 0.8) {
    s.stepAcc -= 0.8;
    return 'step';
  }
  return null;
}

/** Поза в момент импульса: скан застаёт его таким. Лицом к игроку — всегда. */
export function scanPose(s: Stalker, px: number, pz: number, cfg: Config = defaultConfig): PoseName {
  const d = distTo(s, px, pz);
  const moving = Math.hypot(s.vx, s.vz) > 0.25;
  s.heading = moving && s.mode === 'retreat' ? s.heading : faceTo(s, px, pz);
  if (moving) return 'walk';
  if ((s.mode === 'approach' || s.mode === 'hunt') && d < 12) return 'reach';
  if (s.goal?.cover && Math.hypot(s.goal.x - s.x, s.goal.z - s.z) < 1) return 'peek';
  if (d < cfg.stalker.revealDist * 1.6) return 'tilt';
  return Math.abs(wrapAngle(s.heading * 7)) < 1.2 ? 'tilt' : 'stand';
}

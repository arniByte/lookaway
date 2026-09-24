// Игрок от первого лица: ходьба по рельефу, столкновения со стволами и камнями, край долины.
import { config as defaultConfig, type Config } from '../config';
import type { Collider, World } from '../world/worldgen';
import { SpatialGrid } from './grid';

export interface PlayerInput {
  forward: number; // −1..1
  strafe: number; // −1..1, >0 — вправо
  run: boolean;
  turn: number; // рад за кадр (мышь / взгляд у края)
  look: number; // рад за кадр, вверх-вниз
}

export const NO_INPUT: PlayerInput = { forward: 0, strafe: 0, run: false, turn: 0, look: 0 };

export interface Player {
  x: number;
  z: number;
  y: number; // глаза
  yaw: number; // 0 — смотрит в −Z
  pitch: number;
  speed: number; // текущая, м/с
  stride: number; // пройдено с последнего шага, м
}

export function createPlayer(world: World, cfg: Config = defaultConfig): Player {
  const { x, z, yaw } = world.spawn;
  return { x, z, y: world.height(x, z) + cfg.player.eyeHeight, yaw, pitch: 0, speed: 0, stride: 0 };
}

export function colliderGrid(world: World): SpatialGrid<Collider> {
  return new SpatialGrid<Collider>(4, world.colliders);
}

/** Шаг движения. Возвращает true, если в этом шаге была «ступня» (для звука шагов). */
export function movePlayer(
  p: Player,
  input: PlayerInput,
  dtMs: number,
  world: World,
  grid: SpatialGrid<Collider>,
  cfg: Config = defaultConfig,
): boolean {
  const pc = cfg.player;
  const dt = dtMs / 1000;
  p.yaw += input.turn;
  p.pitch = Math.max(-1.35, Math.min(1.35, p.pitch + input.look));

  let f = input.forward;
  let s = input.strafe;
  const len = Math.hypot(f, s);
  if (len > 1) {
    f /= len;
    s /= len;
  }
  const target = (input.run ? pc.run : pc.walk) * Math.min(1, len);
  p.speed += (target - p.speed) * Math.min(1, dt * 8);
  const sin = Math.sin(p.yaw);
  const cos = Math.cos(p.yaw);
  // yaw 0 → вперёд = −Z; вправо = +X
  const dirX = -sin * f + cos * s;
  const dirZ = -cos * f - sin * s;
  const dl = Math.hypot(dirX, dirZ) || 1;
  const ox = p.x;
  const oz = p.z;
  p.x += (dirX / dl) * p.speed * dt * Math.min(1, len);
  p.z += (dirZ / dl) * p.speed * dt * Math.min(1, len);

  // Столкновения: выталкиваем из кругов, две итерации хватает для пары соседних стволов.
  for (let it = 0; it < 2; it++) {
    for (const c of grid.near(p.x, p.z, pc.radius + 2)) {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + pc.radius;
      if (d < min && d > 1e-6) {
        p.x = c.x + (dx / d) * min;
        p.z = c.z + (dz / d) * min;
      }
    }
  }
  const rMax = world.radius - 1.5;
  const rr = Math.hypot(p.x, p.z);
  if (rr > rMax) {
    p.x *= rMax / rr;
    p.z *= rMax / rr;
  }

  const ground = world.height(p.x, p.z) + pc.eyeHeight;
  p.y += (ground - p.y) * Math.min(1, dt * 12);

  p.stride += Math.hypot(p.x - ox, p.z - oz);
  const strideLen = input.run ? 0.9 : 0.7;
  if (p.stride >= strideLen) {
    p.stride -= strideLen;
    return true;
  }
  return false;
}

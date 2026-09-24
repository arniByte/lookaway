// Чёрная материя (GDD → Чёрная материя). Чистая логика: слух, погоня, рывок на моргании,
// удержание взглядом с анти-кемпингом. Потеря сигнала — пауза (шаг просто не вызывается).
import { config as defaultConfig, type Config } from '../config';
import type { World } from '../world/worldgen';

export interface DarkMatter {
  x: number;
  y: number;
  z: number;
  awake: boolean;
  target: { x: number; z: number } | null;
  held: boolean;
  heldMs: number; // сколько держат взглядом подряд
  freeMs: number; // сколько взгляд не на ней (для сброса «привыкания»)
}

export interface DarkCtx {
  player: { x: number; z: number };
  eyesClosed: boolean;
  blinkStart: boolean;
  gazeOn: boolean; // взгляд на ней и глаза открыты
}

export function createDark(world: World): DarkMatter {
  const s = world.darkSpawn;
  return { x: s.x, y: s.y, z: s.z, awake: false, target: null, held: false, heldMs: 0, freeMs: 0 };
}

export const distTo = (d: DarkMatter, x: number, z: number) => Math.hypot(d.x - x, d.z - z);

/** Импульс лидара: если слышно — просыпается и идёт на место импульса. */
export function hearPulse(d: DarkMatter, x: number, z: number, cfg: Config = defaultConfig): boolean {
  if (distTo(d, x, z) > cfg.dark.hearing) return false;
  d.awake = true;
  d.target = { x, z };
  return true;
}

/** Шаг. Возвращает 'kill', если дотянулась. */
export function stepDark(d: DarkMatter, dtMs: number, ctx: DarkCtx, world: World, cfg: Config = defaultConfig): 'kill' | null {
  const dc = cfg.dark;
  if (!d.awake) return null;
  const toPlayer = distTo(d, ctx.player.x, ctx.player.z);

  // Удержание взглядом: не дольше holdMaxMs, потом «привыкает» до паузы взгляда holdResetMs.
  if (ctx.gazeOn && !ctx.eyesClosed) {
    d.heldMs += dtMs;
    d.freeMs = 0;
  } else {
    d.freeMs += dtMs;
    if (d.freeMs >= dc.holdResetMs) d.heldMs = 0;
  }
  d.held = ctx.gazeOn && !ctx.eyesClosed && d.heldMs < dc.holdMaxMs;

  // Близко — идёт прямо на игрока, иначе — на последний услышанный импульс, потом дрейфует к игроку.
  let tx = ctx.player.x;
  let tz = ctx.player.z;
  let speed = dc.speed;
  if (toPlayer > dc.senseRadius && d.target) {
    tx = d.target.x;
    tz = d.target.z;
    if (Math.hypot(d.x - tx, d.z - tz) < 1.5) d.target = null;
  } else if (toPlayer > dc.senseRadius) {
    speed *= dc.driftMul;
  }
  if (ctx.eyesClosed) speed *= dc.closedMul;

  // Моргание — рывок (blink-cut), но не ближе safeDist: моргание не убивает напрямую.
  if (ctx.blinkStart && toPlayer > dc.safeDist) {
    const leap = Math.min(dc.blinkLeap, toPlayer - dc.safeDist);
    d.x += ((ctx.player.x - d.x) / toPlayer) * leap;
    d.z += ((ctx.player.z - d.z) / toPlayer) * leap;
  }

  if (!d.held) {
    const dx = tx - d.x;
    const dz = tz - d.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.01) {
      const step = Math.min(dist, (speed * dtMs) / 1000);
      d.x += (dx / dist) * step;
      d.z += (dz / dist) * step;
    }
  }
  d.y = world.height(d.x, d.z) + dc.radius;
  return distTo(d, ctx.player.x, ctx.player.z) < dc.killDist ? 'kill' : null;
}

// Поведение фауны (GDD → Наука → Экология). Чистая логика: позиции и режимы, без three.js.
import { config as defaultConfig, type Config } from '../config';
import { range, type Rng } from '../world/random';
import type { Species } from '../world/species';
import type { PlantInstance, World } from '../world/worldgen';

export type CritterMode = 'fly' | 'perch' | 'crawl' | 'hover' | 'flee';

export interface Critter {
  id: number;
  species: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mode: CritterMode;
  until: number; // мс игрового времени до смены режима
  tx: number; // цель
  ty: number;
  tz: number;
  heading: number; // рад, для ориентации меша
  flap: number; // фаза взмаха
}

export function createFauna(world: World): Critter[] {
  return world.animals.map((a) => ({
    id: a.id,
    species: a.species,
    x: a.x,
    y: a.y,
    z: a.z,
    vx: 0,
    vy: 0,
    vz: 0,
    mode: world.species[a.species].clade === 'coleoptera' ? 'crawl' : 'fly',
    until: 0,
    tx: a.x,
    ty: a.y,
    tz: a.z,
    heading: 0,
    flap: 0,
  }));
}

export interface FaunaEnv {
  time: number;
  world: World;
  hosts: Map<number, PlantInstance[]>; // вид цветка → экземпляры
  pulse: { x: number; z: number } | null; // импульс в этом шаге
  rng: Rng;
}

export function hostIndex(world: World): Map<number, PlantInstance[]> {
  const m = new Map<number, PlantInstance[]>();
  for (const p of world.plants) {
    if (world.species[p.species].clade !== 'flos') continue;
    let l = m.get(p.species);
    if (!l) m.set(p.species, (l = []));
    l.push(p);
  }
  return m;
}

function nearestHost(c: Critter, sp: Species, env: FaunaEnv, rng: Rng): PlantInstance | null {
  const list = env.hosts.get(sp.genome.hostPlant ?? -1) ?? [];
  const cand = list.filter((p) => Math.hypot(p.x - c.x, p.z - c.z) < 14 && Math.hypot(p.x - c.x, p.z - c.z) > 0.5);
  if (!cand.length) return list.length ? list[Math.floor(rng() * list.length)] : null;
  return cand[Math.floor(rng() * cand.length)];
}

function setTarget(c: Critter, x: number, y: number, z: number): void {
  c.tx = x;
  c.ty = y;
  c.tz = z;
}

export function stepFauna(critters: Critter[], dtMs: number, env: FaunaEnv, cfg: Config = defaultConfig): void {
  const dt = dtMs / 1000;
  const { world, rng } = env;
  for (const c of critters) {
    const sp = world.species[c.species];
    const g = sp.genome;

    // Пугливые разлетаются от импульса (поведение, которое попадёт в журнал).
    if (env.pulse && g.flees && Math.hypot(env.pulse.x - c.x, env.pulse.z - c.z) < cfg.fauna.fleeRadius) {
      const ax = c.x - env.pulse.x;
      const az = c.z - env.pulse.z;
      const d = Math.hypot(ax, az) || 1;
      c.mode = 'flee';
      c.until = env.time + range(rng, 1500, 3000);
      const dist = sp.clade === 'coleoptera' ? 2 : 8;
      setTarget(c, c.x + (ax / d) * dist, world.height(c.x, c.z) + (sp.clade === 'coleoptera' ? 0 : 1.8), c.z + (az / d) * dist);
    }

    if (env.time >= c.until) {
      switch (sp.clade) {
        case 'lepidoptera': {
          if (c.mode === 'fly' || c.mode === 'flee') {
            // Долетела — садится на цветок.
            c.mode = 'perch';
            c.until = env.time + range(rng, 3000, 9000);
          } else {
            const h = nearestHost(c, sp, env, rng);
            c.mode = 'fly';
            c.until = env.time + range(rng, 4000, 9000);
            if (h) setTarget(c, h.x, h.y + world.species[h.species].genome.size * h.scale, h.z);
          }
          break;
        }
        case 'coleoptera': {
          c.mode = rng() < 0.5 ? 'perch' : 'crawl';
          c.until = env.time + range(rng, 2000, 6000);
          const a = rng() * Math.PI * 2;
          const tx = c.x + Math.cos(a) * 1.5;
          const tz = c.z + Math.sin(a) * 1.5;
          setTarget(c, tx, world.height(tx, tz), tz);
          break;
        }
        default: {
          c.mode = rng() < 0.35 ? 'hover' : 'fly';
          c.until = env.time + range(rng, 1200, 3500);
          const a = rng() * Math.PI * 2;
          const tx = c.x + Math.cos(a) * range(rng, 3, 9);
          const tz = c.z + Math.sin(a) * range(rng, 3, 9);
          setTarget(c, tx, world.height(tx, tz) + range(rng, 0.8, 2.5), tz);
        }
      }
    }

    // Движение к цели.
    const moving = c.mode !== 'perch' && c.mode !== 'hover';
    const speed = (c.mode === 'flee' ? 1.8 : 1) * g.speed;
    let dx = c.tx - c.x;
    let dy = c.ty - c.y;
    let dz = c.tz - c.z;
    const dist = Math.hypot(dx, dy, dz);
    if (moving && dist > 0.05) {
      dx /= dist;
      dy /= dist;
      dz /= dist;
      // Бабочки порхают: синусоидальные отклонения, стрекозовидные летят прямо.
      const wob = sp.clade === 'lepidoptera' ? 0.8 : 0.1;
      const t = env.time / 1000;
      c.vx = dx * speed + Math.sin(t * 7 + c.id) * wob * speed * 0.5;
      c.vy = dy * speed + Math.sin(t * 11 + c.id * 3) * wob * speed * 0.4;
      c.vz = dz * speed + Math.cos(t * 6 + c.id) * wob * speed * 0.5;
      const step = Math.min(dist, speed * dt);
      c.x += (c.vx / speed) * step;
      c.y += (c.vy / speed) * step;
      c.z += (c.vz / speed) * step;
      c.heading = Math.atan2(c.vx, c.vz);
    } else {
      c.vx = c.vy = c.vz = 0;
      if (moving && sp.clade === 'lepidoptera') c.until = Math.min(c.until, env.time);
    }

    // Земля и край долины.
    const ground = world.height(c.x, c.z);
    const minY = sp.clade === 'coleoptera' ? ground : ground + 0.15;
    if (sp.clade === 'coleoptera') c.y = ground;
    else c.y = Math.max(c.y, minY);
    const r = Math.hypot(c.x, c.z);
    if (r > world.radius - 3) {
      c.x *= (world.radius - 3) / r;
      c.z *= (world.radius - 3) / r;
    }
    const flapHz = c.mode === 'perch' ? 0.4 : sp.clade === 'odonata' ? 25 : sp.clade === 'lepidoptera' ? 9 : 0;
    c.flap += dt * flapHz * Math.PI * 2;
  }
}

// Процедурная долина (GDD → Мир). Только данные: позиции, виды, коллайдеры. Меши строит render/.
import { config as defaultConfig, type Config } from '../config';
import { fbm, simplex2 } from './noise';
import { chance, fork, gauss, int, pick, range, type Rng } from './random';
import type { PoseName } from './meshes';
import { generateSpecies, type Species } from './species';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlantInstance extends Vec3 {
  id: number;
  species: number;
  rot: number;
  scale: number;
  variant: number;
  collider: number; // радиус ствола для игрока, 0 — проходимо
}

export interface RockInstance extends Vec3 {
  r: number;
  seed: number;
}

export interface GrassClump extends Vec3 {
  rot: number;
  scale: number;
}

/** Упавший ствол: лежит вдоль yaw, наклонён по склону. */
export interface LogInstance extends Vec3 {
  yaw: number;
  tilt: number;
  len: number;
  r: number;
  seed: number;
}

export interface Scatter extends Vec3 {
  rot: number;
  scale: number;
  seed: number;
}

/** Застывший участник прошлой экспедиции (GDD → Угроза). Смотрит на маяк. */
export interface Statue extends Vec3 {
  id: number;
  yaw: number; // поворот вокруг Y: локальный +Z фигуры → направление взгляда
  pose: PoseName;
  height: number;
  seed: number;
}

export interface AnimalSpawn extends Vec3 {
  id: number;
  species: number;
}

export interface Collider {
  x: number;
  z: number;
  r: number;
}

export interface World {
  seed: number;
  radius: number; // проходимая часть
  species: Species[];
  height: (x: number, z: number) => number;
  clearing: (x: number, z: number) => number; // 0 — лес, 1 — поляна
  plants: PlantInstance[];
  rocks: RockInstance[];
  grass: GrassClump[];
  logs: LogInstance[];
  stumps: Scatter[]; // scale — радиус, м
  shrubs: Scatter[];
  pebbles: Scatter[];
  statues: Statue[];
  animals: AnimalSpawn[];
  beacon: Vec3;
  spawn: { x: number; z: number; yaw: number };
  stalkerSpawn: Vec3;
  colliders: Collider[];
}

const smooth = (a: number, b: number, v: number) => {
  const k = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

export function generateWorld(seed: number, cfg: Config = defaultConfig): World {
  const wc = cfg.world;
  const R = wc.radius;
  const species = generateSpecies(seed);

  const nA = simplex2(seed ^ 0x1234);
  const nB = simplex2(seed ^ 0x5678);
  const nC = simplex2(seed ^ 0x9abc);
  const clearing = (x: number, z: number) => {
    const d = Math.hypot(x, z);
    const spawnClear = 1 - smooth(wc.spawnClearing, wc.spawnClearing + 6, d);
    return Math.max(spawnClear, smooth(0.15, 0.45, fbm(nC, x * 0.018, z * 0.018, 3)));
  };
  const raw = (x: number, z: number) => fbm(nA, x * 0.011, z * 0.011, 5) * wc.hillHeight + fbm(nB, x * 0.05, z * 0.05, 3) * 0.7;
  const h0 = raw(0, 0);
  const height = (x: number, z: number) => {
    const d = Math.hypot(x, z);
    const flat = 1 - smooth(wc.spawnClearing * 0.5, wc.spawnClearing + 4, d);
    const rim = smooth(R - 8, R + 12, d) ** 2 * wc.rimHeight;
    return raw(x, z) * (1 - flat) + h0 * flat - h0 + rim;
  };
  const inside = (x: number, z: number, margin = 0) => Math.hypot(x, z) < R - margin;

  const plants: PlantInstance[] = [];
  const colliders: Collider[] = [];
  let pid = 0;
  const bySpecies = (clade: Species['clade']) => species.filter((s) => s.clade === clade);
  const weighted = (r: Rng, list: Species[]) => {
    const total = list.reduce((a, s) => a + s.genome.density, 0);
    let k = r() * total;
    for (const s of list) if ((k -= s.genome.density) <= 0) return s;
    return list[list.length - 1];
  };
  const tooClose = (x: number, z: number, r: number) => colliders.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < (c.r + r) ** 2);
  const addPlant = (s: Species, x: number, z: number, r: Rng, collider = 0) => {
    const p: PlantInstance = {
      id: pid++,
      species: s.id,
      x,
      z,
      y: height(x, z),
      rot: r() * Math.PI * 2,
      scale: Math.exp(gauss(r) * 0.15),
      variant: int(r, 0, wc.variantsPerSpecies - 1),
      collider,
    };
    plants.push(p);
    if (collider > 0) colliders.push({ x, z, r: collider });
    return p;
  };

  // Маяк высадки и игрок.
  const beacon = { x: 0, y: height(0, 0), z: 0 };
  colliders.push({ x: 0, z: 0, r: 0.6 });

  // Камни: реже в центре, чаще на склонах.
  const rr = fork(seed, 'rocks');
  const rocks: RockInstance[] = [];
  for (let i = 0; i < wc.rockCount; i++) {
    const a = rr() * Math.PI * 2;
    const d = Math.sqrt(rr()) * (R - 4);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (d < wc.spawnClearing) continue;
    const r = range(rr, 0.4, 1.6) * (chance(rr, 0.15) ? 2 : 1);
    if (tooClose(x, z, r)) continue;
    rocks.push({ x, z, y: height(x, z), r, seed: int(rr, 0, 1e9) });
    colliders.push({ x, z, r: r * 0.85 });
  }

  // Деревья: сетка с джиттером, плотность — лес против полян.
  const tr = fork(seed, 'trees');
  const trees = bySpecies('arbor');
  for (let gx = -R; gx < R; gx += wc.treeCell) {
    for (let gz = -R; gz < R; gz += wc.treeCell) {
      const x = gx + tr() * wc.treeCell;
      const z = gz + tr() * wc.treeCell;
      if (!inside(x, z, 3)) continue;
      if (!chance(tr, wc.treeDensity * (1 - clearing(x, z)))) continue;
      const s = weighted(tr, trees);
      const trunk = 0.12 + (s.genome.size / 9) * 0.18;
      if (tooClose(x, z, trunk + 1.2)) continue;
      addPlant(s, x, z, tr, trunk + 0.15);
    }
  }

  // Упавшие стволы и пни: лес выглядит прожитым.
  const lr = fork(seed, 'logs');
  const logs: LogInstance[] = [];
  for (let i = 0, tries = 0; logs.length < wc.logCount && tries < wc.logCount * 20; tries++) {
    const a = lr() * Math.PI * 2;
    const d = Math.sqrt(lr()) * (R - 6);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (d < wc.spawnClearing + 2 || clearing(x, z) > 0.55) continue;
    const len = range(lr, 2.5, 6.5);
    const yaw = lr() * Math.PI;
    const dx = (Math.cos(yaw) * len) / 2;
    const dz = (-Math.sin(yaw) * len) / 2;
    if (tooClose(x + dx, z + dz, 0.4) || tooClose(x - dx, z - dz, 0.4) || tooClose(x, z, 0.5)) continue;
    const h0 = height(x - dx, z - dz);
    const h1 = height(x + dx, z + dz);
    logs.push({ x, z, y: (h0 + h1) / 2, yaw, tilt: Math.atan2(h1 - h0, len), len, r: range(lr, 0.14, 0.32), seed: int(lr, 0, 1e9) });
    i++;
  }
  const stumps: Scatter[] = [];
  for (let i = 0, tries = 0; stumps.length < wc.stumpCount && tries < wc.stumpCount * 20; tries++) {
    const a = lr() * Math.PI * 2;
    const d = Math.sqrt(lr()) * (R - 5);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const r = range(lr, 0.18, 0.4);
    if (d < wc.spawnClearing + 2 || clearing(x, z) > 0.6 || tooClose(x, z, r + 0.8)) continue;
    stumps.push({ x, z, y: height(x, z), rot: lr() * Math.PI * 2, scale: r, seed: int(lr, 0, 1e9) });
    colliders.push({ x, z, r: r * 1.2 });
    i++;
  }

  // Папоротники: подлесок.
  const fr = fork(seed, 'ferns');
  const ferns = bySpecies('filix');
  for (let gx = -R; gx < R; gx += wc.fernCell) {
    for (let gz = -R; gz < R; gz += wc.fernCell) {
      const x = gx + fr() * wc.fernCell;
      const z = gz + fr() * wc.fernCell;
      if (!inside(x, z, 2) || !chance(fr, wc.fernDensity * (1 - clearing(x, z)))) continue;
      if (tooClose(x, z, 0.5)) continue;
      addPlant(weighted(fr, ferns), x, z, fr);
    }
  }

  // Цветы: куртины на полянах, одна куртина — один вид.
  const cr = fork(seed, 'flowers');
  const flowers = bySpecies('flos');
  const flowerClusters: { x: number; z: number; species: number }[] = [];
  for (let i = 0, tries = 0; i < wc.flowerClusters && tries < 2000; tries++) {
    const a = cr() * Math.PI * 2;
    const d = Math.sqrt(cr()) * (R - 6);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (clearing(x, z) < 0.5 || d < 6) continue;
    const s = flowers[i % flowers.length];
    flowerClusters.push({ x, z, species: s.id });
    const n = int(cr, 6, 14);
    for (let k = 0; k < n; k++) {
      const fx = x + gauss(cr) * 1.6;
      const fz = z + gauss(cr) * 1.6;
      if (inside(fx, fz, 2) && !tooClose(fx, fz, 0.2)) addPlant(s, fx, fz, cr);
    }
    i++;
  }

  // Грибы: пятна у камней и стволов.
  const gr = fork(seed, 'fungi');
  const fungi = bySpecies('fungus');
  const anchors = [...rocks.map((r) => ({ x: r.x, z: r.z, r: r.r })), ...colliders.filter((c) => c.r > 0.2 && c.r < 0.6)];
  for (let i = 0; i < wc.fungusPatches && anchors.length; i++) {
    const a = pick(gr, anchors);
    const s = weighted(gr, fungi);
    const n = int(gr, 3, 8);
    const ang = gr() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const d = a.r + 0.25 + gr() * 0.9;
      const t = ang + gauss(gr) * 0.5;
      const x = a.x + Math.cos(t) * d;
      const z = a.z + Math.sin(t) * d;
      if (inside(x, z, 2)) addPlant(s, x, z, gr);
    }
  }

  // Трава: гуще на полянах.
  const wr = fork(seed, 'grass');
  const grass: GrassClump[] = [];
  for (let gx = -R; gx < R; gx += wc.grassCell) {
    for (let gz = -R; gz < R; gz += wc.grassCell) {
      const x = gx + wr() * wc.grassCell;
      const z = gz + wr() * wc.grassCell;
      if (!inside(x, z, 1)) continue;
      if (!chance(wr, wc.grassDensity * (0.35 + 0.65 * clearing(x, z)))) continue;
      grass.push({ x, z, y: height(x, z), rot: wr() * Math.PI * 2, scale: range(wr, 0.6, 1.3) });
    }
  }

  // Кусты подлеска и галька: фон, не виды.
  const sr0 = fork(seed, 'shrubs');
  const shrubs: Scatter[] = [];
  for (let gx = -R; gx < R; gx += wc.shrubCell) {
    for (let gz = -R; gz < R; gz += wc.shrubCell) {
      const x = gx + sr0() * wc.shrubCell;
      const z = gz + sr0() * wc.shrubCell;
      if (!inside(x, z, 2) || Math.hypot(x, z) < wc.spawnClearing) continue;
      const c = clearing(x, z);
      if (!chance(sr0, wc.shrubDensity * (1 - Math.abs(c - 0.45) * 1.6))) continue; // гуще на опушках
      if (tooClose(x, z, 0.5)) continue;
      shrubs.push({ x, z, y: height(x, z), rot: sr0() * Math.PI * 2, scale: range(sr0, 0.5, 1.3), seed: int(sr0, 0, 1e9) });
    }
  }
  const pebbles: Scatter[] = [];
  for (let i = 0; i < wc.pebbleCount; i++) {
    const near = rocks.length && chance(sr0, 0.5) ? pick(sr0, rocks) : null;
    const a = sr0() * Math.PI * 2;
    const d = near ? near.r + range(sr0, 0.2, 2.5) : Math.sqrt(sr0()) * (R - 3);
    const x = (near?.x ?? 0) + Math.cos(a) * d;
    const z = (near?.z ?? 0) + Math.sin(a) * d;
    if (!inside(x, z, 1)) continue;
    pebbles.push({ x, z, y: height(x, z), rot: sr0() * Math.PI * 2, scale: range(sr0, 0.04, 0.16), seed: int(sr0, 0, 1e9) });
  }

  // Экспедиция: застывшие люди на опушках, лицом к маяку. Коллайдер — как у ствола.
  const er = fork(seed, 'expedition');
  const ec = cfg.expedition;
  const statues: Statue[] = [];
  const poses: PoseName[] = ['stand', 'slump', 'kneel', 'tilt', 'stand', 'crouch'];
  for (let tries = 0; statues.length < ec.statues && tries < 4000; tries++) {
    const a = er() * Math.PI * 2;
    const d = range(er, ec.minDist, Math.min(ec.maxDist, R - 6));
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const c = clearing(x, z);
    if (c < 0.15 || c > 0.75 || tooClose(x, z, 0.8) || statues.some((st) => Math.hypot(st.x - x, st.z - z) < 14)) continue;
    const i = statues.length;
    statues.push({ id: i, x, z, y: height(x, z), yaw: Math.atan2(-x, -z) + gauss(er) * 0.15, pose: poses[i % poses.length], height: range(er, 1.62, 1.84), seed: int(er, 0, 1e9) });
    colliders.push({ x, z, r: 0.3 });
  }

  // Фауна: бабочки — у куртин кормового растения, жуки — у стволов и грибов, стрекозовидные — над полянами.
  const ar = fork(seed, 'animals');
  const animals: AnimalSpawn[] = [];
  let aid = 0;
  for (const s of species.filter((sp) => sp.kingdom === 'animal')) {
    const n = Math.round(wc.animalsPerSpecies * s.genome.density);
    for (let k = 0; k < n; k++) {
      let x = 0;
      let z = 0;
      let y = 0;
      if (s.clade === 'lepidoptera') {
        const hosts = flowerClusters.filter((c) => c.species === s.genome.hostPlant);
        const c = hosts.length ? pick(ar, hosts) : pick(ar, flowerClusters);
        x = c.x + gauss(ar) * 2.5;
        z = c.z + gauss(ar) * 2.5;
        y = height(x, z) + range(ar, 0.4, 1.6);
      } else if (s.clade === 'coleoptera') {
        const a = pick(ar, anchors.length ? anchors : [{ x: 10, z: 10, r: 1 }]);
        x = a.x + gauss(ar) * 1.5;
        z = a.z + gauss(ar) * 1.5;
        y = height(x, z);
      } else {
        const c = flowerClusters.length ? pick(ar, flowerClusters) : { x: 15, z: 15 };
        x = c.x + gauss(ar) * 6;
        z = c.z + gauss(ar) * 6;
        y = height(x, z) + range(ar, 1, 2.5);
      }
      if (!inside(x, z, 3)) continue;
      animals.push({ id: aid++, species: s.id, x, y, z });
    }
  }

  const sr = fork(seed, 'spawn');
  const da = sr() * Math.PI * 2;
  const dd = range(sr, cfg.stalker.spawnMinDist, R - 10);
  const stalkerSpawn = { x: Math.cos(da) * dd, y: 0, z: Math.sin(da) * dd };
  stalkerSpawn.y = height(stalkerSpawn.x, stalkerSpawn.z);

  return {
    seed,
    radius: R,
    species,
    height,
    clearing,
    plants,
    rocks,
    grass,
    logs,
    stumps,
    shrubs,
    pebbles,
    statues,
    animals,
    beacon,
    spawn: { x: 0, z: 3, yaw: Math.PI }, // спиной к маяку: впереди долина, маяк — засечка на кольце HUD
    stalkerSpawn,
    colliders,
  };
}

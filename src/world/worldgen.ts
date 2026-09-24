// Процедурная долина (GDD → Мир). Только данные: позиции, виды, коллайдеры. Меши строит render/.
import { config as defaultConfig, type Config } from '../config';
import { fbm, simplex2 } from './noise';
import { chance, fork, gauss, int, pick, range, type Rng } from './random';
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
  animals: AnimalSpawn[];
  beacon: Vec3;
  spawn: { x: number; z: number; yaw: number };
  darkSpawn: Vec3;
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
  const dd = range(sr, wc.darkMinDist, R - 10);
  const darkSpawn = { x: Math.cos(da) * dd, y: 0, z: Math.sin(da) * dd };
  darkSpawn.y = height(darkSpawn.x, darkSpawn.z);

  return {
    seed,
    radius: R,
    species,
    height,
    clearing,
    plants,
    rocks,
    grass,
    animals,
    beacon,
    spawn: { x: 0, z: 3, yaw: 0 },
    darkSpawn,
    colliders,
  };
}

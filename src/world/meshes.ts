// Процедурные меши из генома. Игрок их не видит — их «видит» лидар (render/lidar.ts).
// У каждой вершины: aRefl (отражение 905 нм, 0..1), aMat (класс материала), aSpecies (id+1, 0 — не вид).
import * as THREE from 'three';
import type { Rng } from './random';
import { gauss, makeRng, range } from './random';
import type { Genome, Species } from './species';

/** Классы материалов в скане (GDD → Лидар). */
export const MAT = {
  none: 0,
  terrain: 1,
  rock: 2,
  bark: 3,
  foliage: 4,
  petal: 5,
  fungus: 6,
  insect: 7,
  beacon: 8,
  figure: 9,
} as const;

type V3 = THREE.Vector3;
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Накопитель треугольников с нашими атрибутами. */
export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  refl: number[] = [];
  mat: number[] = [];
  idx: number[] = [];

  private vert(p: V3, n: V3, refl: number, mat: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.refl.push(refl);
    this.mat.push(mat);
    return this.pos.length / 3 - 1;
  }

  /** Трубка вдоль ломаной с радиусами (ствол, ветка, сегмент тела). */
  tube(path: V3[], radii: number[], radial: number, mat: number, refl: (t: number, a: number) => number): void {
    if (path.length < 2) return;
    let normal = v(1, 0, 0);
    const first = path[1].clone().sub(path[0]).normalize();
    if (Math.abs(first.dot(normal)) > 0.9) normal = v(0, 0, 1);
    normal.sub(first.clone().multiplyScalar(normal.dot(first))).normalize();
    const base = this.pos.length / 3;
    for (let i = 0; i < path.length; i++) {
      const tan = (i < path.length - 1 ? path[i + 1].clone().sub(path[i]) : path[i].clone().sub(path[i - 1])).normalize();
      normal.sub(tan.clone().multiplyScalar(normal.dot(tan))).normalize(); // параллельный перенос
      const bin = tan.clone().cross(normal);
      for (let k = 0; k < radial; k++) {
        const a = (k / radial) * Math.PI * 2;
        const n = normal.clone().multiplyScalar(Math.cos(a)).add(bin.clone().multiplyScalar(Math.sin(a)));
        this.vert(path[i].clone().add(n.clone().multiplyScalar(radii[i])), n, refl(i / (path.length - 1), a), mat);
      }
    }
    for (let i = 0; i < path.length - 1; i++) {
      for (let k = 0; k < radial; k++) {
        const a = base + i * radial + k;
        const b = base + i * radial + ((k + 1) % radial);
        const c = a + radial;
        const d = b + radial;
        this.idx.push(a, c, b, b, c, d);
      }
    }
  }

  /** Лист / лепесток / травинка: полоска вдоль dir с профилем ширины и изгибом. */
  blade(root: V3, dir: V3, side: V3, length: number, width: number, bend: V3, segs: number, mat: number, refl: number, shape = 0.5): void {
    const base = this.pos.length / 3;
    const nrm = dir.clone().cross(side).normalize();
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const w = width * Math.pow(Math.sin(Math.PI * Math.min(t * (1 - shape * 0.4) + 0.05, 1)), 0.6 + shape) * (i === segs ? 0.05 : 1);
      const c = root.clone().add(dir.clone().multiplyScalar(length * t)).add(bend.clone().multiplyScalar(t * t));
      this.vert(c.clone().add(side.clone().multiplyScalar(-w / 2)), nrm, refl, mat);
      this.vert(c.clone().add(side.clone().multiplyScalar(w / 2)), nrm, refl, mat);
    }
    for (let i = 0; i < segs; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  /** Решётка в полярных координатах: крыло с контуром r(θ) и узором отражения. */
  wing(
    root: V3,
    fwd: V3,
    out: V3,
    radius: (th: number) => number,
    th0: number,
    th1: number,
    rings: number,
    spokes: number,
    mat: number,
    refl: (r: number, th: number) => number,
  ): void {
    const base = this.pos.length / 3;
    const nrm = out.clone().cross(fwd).normalize();
    for (let i = 0; i <= spokes; i++) {
      const th = th0 + ((th1 - th0) * i) / spokes;
      const R = radius(th);
      for (let j = 0; j <= rings; j++) {
        const r = (j / rings) * R;
        const p = root.clone().add(out.clone().multiplyScalar(Math.cos(th) * r)).add(fwd.clone().multiplyScalar(Math.sin(th) * r));
        this.vert(p, nrm, refl(j / rings, th), mat);
      }
    }
    for (let i = 0; i < spokes; i++) {
      for (let j = 0; j < rings; j++) {
        const a = base + i * (rings + 1) + j;
        const b = a + rings + 1;
        this.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  /** Эллипсоид (тело жука, голова, камень). */
  ellipsoid(c: V3, r: V3, wSeg: number, hSeg: number, mat: number, refl: (u: number, v: number) => number, jitter?: (p: V3) => number): void {
    const base = this.pos.length / 3;
    for (let i = 0; i <= hSeg; i++) {
      const phi = (i / hSeg) * Math.PI;
      for (let j = 0; j <= wSeg; j++) {
        const th = (j / wSeg) * Math.PI * 2;
        const n = v(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
        const k = jitter ? jitter(n) : 1;
        const p = v(n.x * r.x * k, n.y * r.y * k, n.z * r.z * k).add(c);
        this.vert(p, n, refl(j / wSeg, i / hSeg), mat);
      }
    }
    for (let i = 0; i < hSeg; i++) {
      for (let j = 0; j < wSeg; j++) {
        const a = base + i * (wSeg + 1) + j;
        const b = a + wSeg + 1;
        this.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aRefl', new THREE.Float32BufferAttribute(this.refl, 1));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 1));
    g.setIndex(this.idx);
    return g;
  }
}

const randDir = (r: Rng) => v(gauss(r), gauss(r), gauss(r)).normalize();
const perp = (d: V3) => (Math.abs(d.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0)).cross(d).normalize();

// ─── Растения ────────────────────────────────────────────────────────────────

export function buildTree(g: Genome, r: Rng, detail = 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const H = g.size * range(r, 0.85, 1.15);
  const trunkR = 0.12 + (g.size / 9) * 0.18;
  const barkRefl = 0.25 + g.reflect905 * 0.25;
  const leafRefl = g.reflect905;
  const depth = Math.min(3, g.segments);
  const leavesPerTip = Math.round(16 * detail);

  const branch = (from: V3, dir: V3, len: number, rad: number, level: number) => {
    const n = 4;
    const pts: V3[] = [];
    const rs: number[] = [];
    const sway = randDir(r).multiplyScalar(len * 0.12);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(from.clone().add(dir.clone().multiplyScalar(len * t)).add(sway.clone().multiplyScalar(Math.sin(t * Math.PI))));
      rs.push(rad * (1 - t * 0.6));
    }
    b.tube(pts, rs, level === 0 ? 7 : 5, MAT.bark, (t, a) => barkRefl * (0.8 + 0.2 * Math.sin(a * 3 + t * 20)));
    const tip = pts[n];
    if (level >= depth) {
      const s = g.size / 9;
      for (let k = 0; k < leavesPerTip; k++) {
        const d = randDir(r);
        const root = tip.clone().add(randDir(r).multiplyScalar(0.6 * s + r() * 0.8 * s));
        const L = (0.26 + g.leafShape * 0.3) * Math.sqrt(s) * range(r, 0.7, 1.3);
        b.blade(root, d, perp(d), L, L * (0.9 - g.leafShape * 0.6), v(0, -L * 0.2, 0), 2, MAT.foliage, leafRefl * range(r, 0.85, 1.1), g.leafShape);
      }
      return;
    }
    const kids = 2 + Math.round(r() * 2);
    for (let k = 0; k < kids; k++) {
      const around = perp(dir).applyAxisAngle(dir, g.phyllo * k + r());
      const nd = dir.clone().applyAxisAngle(around, g.branchAngle * range(r, 0.8, 1.2)).normalize();
      nd.y = Math.max(nd.y, -0.2);
      const at = level === 0 ? range(r, 0.45, 1) : range(r, 0.6, 1);
      const start = from.clone().add(dir.clone().multiplyScalar(len * at));
      branch(start, nd.normalize(), len * range(r, 0.55, 0.7), rad * 0.55, level + 1);
    }
  };
  branch(v(0, -0.2, 0), v(gauss(r) * 0.04, 1, gauss(r) * 0.04).normalize(), H * 0.6, trunkR, 0);
  return b.build();
}

export function buildFern(g: Genome, r: Rng, detail = 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const fronds = g.symmetry + 3;
  const L = g.size * range(r, 0.8, 1.2);
  const pairs = Math.round((6 + g.segments) * detail);
  for (let f = 0; f < fronds; f++) {
    const az = f * g.phyllo + gauss(r) * 0.2;
    const out = v(Math.cos(az), 0, Math.sin(az));
    const lift = 0.9 - g.curl * 0.5;
    const spine: V3[] = [];
    for (let i = 0; i <= pairs; i++) {
      const t = i / pairs;
      const droop = t * t * (0.4 + g.curl * 0.6);
      spine.push(out.clone().multiplyScalar(L * t * 0.8).add(v(0, L * (t * lift - droop * 0.6), 0)));
    }
    b.tube(spine, spine.map((_, i) => 0.008 * (1 - i / (pairs + 1))), 3, MAT.foliage, () => g.reflect905 * 0.7);
    const side = out.clone().cross(v(0, 1, 0)).normalize();
    for (let i = 1; i < pairs; i++) {
      const t = i / pairs;
      const len = L * 0.22 * Math.sin(Math.PI * Math.min(1, t * 1.1)) * (0.6 + g.leafShape * 0.6);
      for (const s of [-1, 1]) {
        const d = side.clone().multiplyScalar(s).add(out.clone().multiplyScalar(0.35)).normalize();
        b.blade(spine[i], d, out, len, len * 0.35, v(0, -len * 0.25, 0), 2, MAT.foliage, g.reflect905, g.leafShape);
      }
    }
  }
  return b.build();
}

export function buildFlower(g: Genome, r: Rng, detail = 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const H = g.size * range(r, 0.8, 1.2);
  const bend = v(gauss(r) * 0.05, 0, gauss(r) * 0.05);
  const stem: V3[] = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    stem.push(v(0, H * t, 0).add(bend.clone().multiplyScalar(t * t)));
  }
  b.tube(stem, stem.map(() => 0.006 + H * 0.01), 4, MAT.foliage, () => 0.4);
  for (let k = 0; k < 2; k++) {
    const d = v(Math.cos(k * Math.PI + r()), 0.6, Math.sin(k * Math.PI + r())).normalize();
    b.blade(stem[1 + k], d, perp(d), H * 0.35, H * 0.12, v(0, -H * 0.05, 0), 3, MAT.foliage, 0.45, g.leafShape);
  }
  const head = stem[5];
  const petals = g.symmetry;
  const PL = H * (0.18 + g.aspect * 0.18);
  const rings = g.segments > 6 ? 2 : 1;
  for (let ring = 0; ring < rings; ring++) {
    for (let k = 0; k < petals; k++) {
      const az = (k / petals) * Math.PI * 2 + ring * (Math.PI / petals);
      const d = v(Math.cos(az), 0.25 + g.curl * 0.6 - ring * 0.2, Math.sin(az)).normalize();
      const refl = g.reflect905 * (0.7 + 0.3 * Math.cos(k * g.pattern * 6));
      b.blade(head, d, perp(d), PL * (1 - ring * 0.25), PL * (0.3 + (1 - g.leafShape) * 0.4), v(0, -PL * 0.2 * g.curl, 0), Math.round(3 * detail) + 1, MAT.petal, refl, g.leafShape);
    }
  }
  b.ellipsoid(head.clone().add(v(0, 0.01, 0)), v(PL * 0.25, PL * 0.12, PL * 0.25), 8, 4, MAT.petal, () => 0.9);
  return b.build();
}

export function buildFungus(g: Genome, r: Rng, detail = 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const H = g.size * range(r, 0.7, 1.3);
  const capR = H * (0.35 + g.aspect * 0.5);
  const lean = v(gauss(r) * 0.08, 1, gauss(r) * 0.08).normalize();
  const stalk: V3[] = [];
  for (let i = 0; i <= 4; i++) stalk.push(lean.clone().multiplyScalar((H * i) / 4));
  b.tube(stalk, stalk.map((_, i) => H * 0.09 * (1.2 - i * 0.08)), 6, MAT.fungus, () => 0.55);
  const top = stalk[4];
  const flat = 0.25 + (1 - g.aspect) * 0.6;
  const seg = Math.round(14 * detail);
  b.ellipsoid(top, v(capR, capR * flat, capR), seg, Math.round(6 * detail), MAT.fungus, (u, vv) => {
    const spots = g.pattern > 0.5 ? 0.25 * Math.max(0, Math.sin(u * 40 * g.pattern) * Math.sin(vv * 30)) : 0;
    return g.reflect905 * (vv < 0.55 ? 1 : 0.5) + spots; // низ шляпки (пластинки) темнее
  }, (n) => (n.y < -0.1 ? 0.4 : 1));
  return b.build();
}

export function buildGrass(r: Rng): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const blades = 9 + Math.round(r() * 4);
  for (let k = 0; k < blades; k++) {
    const root = v(gauss(r) * 0.1, 0, gauss(r) * 0.1);
    const d = v(gauss(r) * 0.3, 1, gauss(r) * 0.3).normalize();
    const L = range(r, 0.18, 0.6);
    b.blade(root, d, perp(d), L, range(r, 0.012, 0.024), v(gauss(r) * 0.14, -L * 0.2, gauss(r) * 0.14), 3, MAT.foliage, range(r, 0.28, 0.46), 0.9);
  }
  return b.build();
}

/** Упавший ствол вдоль X: трубка с изломом, обломки сучьев, торец темнее. */
export function buildLog(seed: number, length: number, radius: number): THREE.BufferGeometry {
  const r = makeRng(seed);
  const b = new GeoBuilder();
  const pts: V3[] = [];
  const rs: number[] = [];
  const bend = gauss(r) * 0.15;
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push(v((t - 0.5) * length, radius * 0.8 + Math.sin(t * Math.PI) * bend * 0.3, Math.sin(t * Math.PI) * bend * length * 0.1));
    rs.push(radius * (1 - t * 0.35) * (0.92 + 0.08 * Math.sin(i * 2.7)));
  }
  const refl = range(r, 0.22, 0.34);
  b.tube(pts, rs, 9, MAT.bark, (t, a) => refl * (0.75 + 0.25 * Math.sin(a * 5 + t * 30)));
  const stubs = 2 + Math.round(r() * 3);
  for (let k = 0; k < stubs; k++) {
    const t = range(r, 0.2, 0.85);
    const at = v((t - 0.5) * length, radius * 0.8, 0);
    const d = v(gauss(r) * 0.3, range(r, 0.3, 1), gauss(r)).normalize();
    b.tube([at, at.clone().add(d.clone().multiplyScalar(range(r, 0.3, 0.9)))], [radius * 0.3, radius * 0.12], 4, MAT.bark, () => refl);
  }
  return b.build();
}

/** Пень с корневыми наплывами. */
export function buildStump(seed: number, radius: number): THREE.BufferGeometry {
  const r = makeRng(seed);
  const b = new GeoBuilder();
  const H = radius * range(r, 1.5, 3);
  b.tube([v(0, -0.1, 0), v(0, H * 0.5, 0), v(0, H, 0)], [radius * 1.25, radius, radius * 0.95], 10, MAT.bark, (_t, a) => 0.3 * (0.8 + 0.2 * Math.sin(a * 7)));
  b.ellipsoid(v(0, H, 0), v(radius * 0.95, radius * 0.08, radius * 0.95), 10, 3, MAT.bark, () => 0.45); // спил светлее
  const roots = 4 + Math.round(r() * 2);
  for (let k = 0; k < roots; k++) {
    const a = (k / roots) * Math.PI * 2 + gauss(r) * 0.3;
    const o = v(Math.cos(a), 0, Math.sin(a));
    b.tube([o.clone().multiplyScalar(radius * 0.6).setY(H * 0.25), o.clone().multiplyScalar(radius * 1.9).setY(-0.02)], [radius * 0.32, radius * 0.1], 4, MAT.bark, () => 0.28);
  }
  return b.build();
}

/** Куст подлеска (не вид: фон, в журнал не идёт). */
export function buildShrub(r: Rng, size: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const stems = 5 + Math.round(r() * 4);
  for (let k = 0; k < stems; k++) {
    const d = v(gauss(r) * 0.45, 1, gauss(r) * 0.45).normalize();
    const L = size * range(r, 0.6, 1.1);
    b.tube([v(0, 0, 0), d.clone().multiplyScalar(L)], [0.012, 0.005], 3, MAT.bark, () => 0.3);
    for (let j = 0; j < 7; j++) {
      const at = d.clone().multiplyScalar(L * range(r, 0.35, 1));
      const ld = randDir(r);
      ld.y = Math.abs(ld.y) * 0.5 + 0.2;
      ld.normalize();
      const ll = size * range(r, 0.12, 0.2);
      b.blade(at, ld, perp(ld), ll, ll * 0.55, v(0, -ll * 0.2, 0), 2, MAT.foliage, range(r, 0.35, 0.5), 0.3);
    }
  }
  return b.build();
}

/** Мелкий камень / галька. */
export function buildPebble(r: Rng, radius: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.ellipsoid(v(0, radius * 0.3, 0), v(radius, radius * range(r, 0.4, 0.7), radius * range(r, 0.7, 1.1)), 7, 4, MAT.rock, () => range(r, 0.4, 0.6));
  return b.build();
}

export function buildRock(seed: number, radius: number): THREE.BufferGeometry {
  const r = makeRng(seed);
  const b = new GeoBuilder();
  const f = [range(r, 1, 3), range(r, 1, 3), range(r, 1, 3)];
  const ph = [r() * 6, r() * 6, r() * 6];
  const flat = range(r, 0.45, 0.8);
  b.ellipsoid(v(0, radius * flat * 0.4, 0), v(radius, radius * flat, radius * range(r, 0.8, 1.2)), 16, 9, MAT.rock,
    (u, vv) => 0.45 + 0.1 * Math.sin(u * 30 + vv * 17),
    (n) => 1 + 0.18 * Math.sin(n.x * f[0] * 3 + ph[0]) * Math.sin(n.y * f[1] * 3 + ph[1]) + 0.1 * Math.sin(n.z * f[2] * 5 + ph[2]));
  return b.build();
}

export function buildBeacon(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.tube([v(0, 0, 0), v(0, 7, 0)], [0.12, 0.08], 8, MAT.beacon, () => 1);
  for (const h of [2.5, 4.5, 6.5]) {
    const ring: V3[] = [];
    for (let i = 0; i <= 24; i++) ring.push(v(Math.cos((i / 24) * Math.PI * 2) * 0.5, h, Math.sin((i / 24) * Math.PI * 2) * 0.5));
    b.tube(ring, ring.map(() => 0.03), 5, MAT.beacon, () => 1);
  }
  b.ellipsoid(v(0, 0.25, 0), v(0.7, 0.25, 0.7), 16, 4, MAT.beacon, () => 0.8);
  return b.build();
}

// ─── Люди ────────────────────────────────────────────────────────────────────

/** Поза фигуры. Углы в радианах; руки: [плечо — 0 вдоль тела, π/2 вперёд; локоть — сгиб вперёд]. */
export interface FigurePose {
  lean: number; // корпус вперёд
  side: number; // корпус вбок (выглядывает из-за ствола), + — вправо
  headTilt: number; // голова к плечу
  headDrop: number; // голова вниз (− — вверх, смотрит на тебя снизу)
  armL: [number, number];
  armR: [number, number];
  stride: number; // −1..1 шаг
  crouch: number; // 0..1
}

export type PoseName = 'stand' | 'tilt' | 'reach' | 'peek' | 'crouch' | 'walk' | 'slump' | 'kneel';

export const POSES: Record<PoseName, FigurePose> = {
  stand: { lean: 0.03, side: 0, headTilt: 0, headDrop: 0.05, armL: [0.08, 0.1], armR: [0.08, 0.1], stride: 0, crouch: 0 },
  tilt: { lean: 0.05, side: 0, headTilt: 0.55, headDrop: 0.12, armL: [0.12, 0.25], armR: [0.1, 0.2], stride: 0, crouch: 0 },
  reach: { lean: 0.16, side: 0, headTilt: 0.15, headDrop: -0.08, armL: [0.25, 0.35], armR: [1.35, 0.08], stride: 0.35, crouch: 0.05 },
  peek: { lean: 0.08, side: 0.38, headTilt: 0.35, headDrop: 0, armL: [0.45, 1.3], armR: [0.1, 0.15], stride: 0, crouch: 0.08 },
  crouch: { lean: 0.5, side: 0, headTilt: 0.1, headDrop: -0.35, armL: [0.7, 0.9], armR: [0.65, 1.0], stride: 0, crouch: 0.75 },
  walk: { lean: 0.1, side: 0, headTilt: 0.05, headDrop: 0.02, armL: [0.35, 0.25], armR: [-0.3, 0.1], stride: 0.85, crouch: 0.05 },
  slump: { lean: 0.35, side: 0.05, headTilt: 0.2, headDrop: 0.75, armL: [0.02, 0.05], armR: [0.02, 0.05], stride: 0, crouch: 0.1 },
  kneel: { lean: 0.12, side: 0, headTilt: 0, headDrop: 0.6, armL: [0.3, 0.8], armR: [0.3, 0.8], stride: 0, crouch: 1 },
};

export interface FigureBuild {
  height: number; // м
  armMul: number; // длина рук относительно нормы
  backpack: boolean;
  fingers: boolean; // длинные пальцы — примета того, кто двигается
}

/** Человек из трубок и эллипсоидов, лицом к +Z, ноги в нуле. В скане — силуэт в плаще. */
export function buildFigure(pose: FigurePose, b0: FigureBuild): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const H = b0.height;
  const refl = () => 0.5;
  const skin = () => 0.62;
  const cs = Math.cos(pose.side);
  const ss = Math.sin(pose.side);
  const cl = Math.cos(pose.lean);
  const sl = Math.sin(pose.lean);
  const up = v(ss, cs * cl, cs * sl).normalize(); // ось корпуса
  const fwd = v(0, -sl, cl).normalize();
  const right = up.clone().cross(fwd).normalize().negate(); // правая сторона фигуры (−X при взгляде на +Z)
  const hipY = H * (0.52 - 0.3 * pose.crouch);
  const pelvis = v(0, hipY, 0);

  // Ноги: бедро вперёд при приседе и шаге, голень назад.
  for (const side of [-1, 1] as const) {
    const hip = pelvis.clone().add(v(side * H * 0.055, 0, 0));
    const step = side * pose.stride * 0.35;
    const thighA = pose.crouch * 1.25 + step;
    const shinA = -pose.crouch * 1.35 + Math.max(0, -step) * 0.6;
    const thighDir = v(0, -Math.cos(thighA), Math.sin(thighA));
    const knee = hip.clone().add(thighDir.multiplyScalar(H * 0.25));
    const shinDir = v(0, -Math.cos(thighA + shinA), Math.sin(thighA + shinA));
    const ankle = knee.clone().add(shinDir.multiplyScalar(H * 0.25));
    b.tube([hip, knee], [H * 0.045, H * 0.036], 6, MAT.figure, refl);
    b.tube([knee, ankle], [H * 0.036, H * 0.026], 6, MAT.figure, refl);
    b.ellipsoid(ankle.clone().add(v(0, -H * 0.012, H * 0.035)), v(H * 0.028, H * 0.02, H * 0.06), 8, 4, MAT.figure, refl);
  }

  // Корпус и плащ до колен.
  const neck = pelvis.clone().add(up.clone().multiplyScalar(H * 0.3));
  const spine = [0, 0.35, 0.7, 1].map((t) => pelvis.clone().add(up.clone().multiplyScalar(H * 0.3 * t)));
  b.tube(spine, [H * 0.075, H * 0.07, H * 0.085, H * 0.06], 10, MAT.figure, refl);
  const hem = pelvis.clone().add(v(0, -H * 0.24 * (1 - pose.crouch * 0.5), H * 0.02 * pose.stride));
  b.tube([pelvis.clone().add(up.clone().multiplyScalar(H * 0.05)), hem], [H * 0.085, H * 0.12], 12, MAT.figure, () => 0.46);
  const shoulderC = neck.clone().add(up.clone().multiplyScalar(-H * 0.03));
  const shL = shoulderC.clone().add(right.clone().multiplyScalar(-H * 0.12));
  const shR = shoulderC.clone().add(right.clone().multiplyScalar(H * 0.12));
  b.tube([shL, shoulderC, shR], [H * 0.04, H * 0.05, H * 0.04], 6, MAT.figure, refl);
  if (b0.backpack) {
    b.ellipsoid(pelvis.clone().add(up.clone().multiplyScalar(H * 0.19)).add(fwd.clone().multiplyScalar(-H * 0.1)), v(H * 0.09, H * 0.12, H * 0.06), 10, 6, MAT.figure, () => 0.42);
  }

  // Голова: наклон к плечу и вниз.
  const headUp = up.clone().applyAxisAngle(fwd, -pose.headTilt).applyAxisAngle(right, pose.headDrop).normalize();
  b.tube([neck, neck.clone().add(headUp.clone().multiplyScalar(H * 0.05))], [H * 0.026, H * 0.024], 6, MAT.figure, skin);
  const head = neck.clone().add(headUp.clone().multiplyScalar(H * 0.115));
  b.ellipsoid(head, v(H * 0.058, H * 0.07, H * 0.064), 12, 8, MAT.figure, skin);

  // Руки.
  const arm = (sh: V3, sideSign: number, [pitch, elbow]: [number, number]) => {
    const down = up.clone().negate();
    const d1 = down.clone().multiplyScalar(Math.cos(pitch)).add(fwd.clone().multiplyScalar(Math.sin(pitch))).add(right.clone().multiplyScalar(sideSign * 0.08)).normalize();
    const L1 = H * 0.18 * b0.armMul;
    const L2 = H * 0.16 * b0.armMul;
    const el = sh.clone().add(d1.clone().multiplyScalar(L1));
    const d2 = d1.clone().multiplyScalar(Math.cos(elbow)).add(fwd.clone().multiplyScalar(Math.sin(elbow))).normalize();
    const wr = el.clone().add(d2.clone().multiplyScalar(L2));
    b.tube([sh, el], [H * 0.032, H * 0.026], 6, MAT.figure, refl);
    b.tube([el, wr], [H * 0.026, H * 0.02], 6, MAT.figure, refl);
    b.ellipsoid(wr.clone().add(d2.clone().multiplyScalar(H * 0.03)), v(H * 0.022, H * 0.03, H * 0.022), 6, 4, MAT.figure, skin);
    if (b0.fingers) {
      for (let k = -1.5; k <= 1.5; k++) {
        const base = wr.clone().add(d2.clone().multiplyScalar(H * 0.05)).add(right.clone().multiplyScalar(k * H * 0.009));
        b.tube([base, base.clone().add(d2.clone().multiplyScalar(H * 0.075))], [H * 0.006, H * 0.004], 3, MAT.figure, skin);
      }
    }
  };
  arm(shL, -1, pose.armL);
  arm(shR, 1, pose.armR);
  return b.build();
}

export function buildPlant(s: Species, variantSeed: number, detail = 1): THREE.BufferGeometry {
  const r = makeRng(variantSeed);
  switch (s.clade) {
    case 'arbor':
      return buildTree(s.genome, r, detail);
    case 'filix':
      return buildFern(s.genome, r, detail);
    case 'flos':
      return buildFlower(s.genome, r, detail);
    case 'fungus':
      return buildFungus(s.genome, r, detail);
    default:
      throw new Error(`не растение: ${s.clade}`);
  }
}

// ─── Животные ────────────────────────────────────────────────────────────────

/** Части животного: тело и шарнирные элементы (крылья машут, лапы не нужны в движении). */
export interface AnimalParts {
  body: THREE.BufferGeometry;
  wings: { geo: THREE.BufferGeometry; side: 1 | -1 }[]; // вращаются вокруг оси тела (Z)
}

const stripe = (g: Genome, a: number, b: number) =>
  g.pattern > 0.33 ? 0.55 + 0.45 * Math.sign(Math.sin(a * (4 + g.pattern * 14) + b * 3)) * 0.5 + 0.2 : 0.75;

function butterfly(g: Genome, r: Rng, detail: number): AnimalParts {
  const S = g.size; // размах
  const body = new GeoBuilder();
  const len = S * 0.45;
  const path: V3[] = [];
  for (let i = 0; i <= 6; i++) path.push(v(0, 0, -len / 2 + (len * i) / 6));
  body.tube(path, path.map((_, i) => S * 0.035 * Math.sin(Math.PI * (0.15 + (0.7 * i) / 6))), 6, MAT.insect, () => 0.5);
  for (const s of [-1, 1]) {
    const ant: V3[] = [v(0, 0, len / 2), v(s * S * 0.08, S * 0.06, len / 2 + S * 0.2)];
    body.tube(ant, [S * 0.004, S * 0.003], 3, MAT.insect, () => 0.4);
  }
  const wings: AnimalParts['wings'] = [];
  const rings = Math.round(6 * detail);
  const spokes = Math.round(14 * detail);
  for (const side of [-1, 1] as const) {
    const w = new GeoBuilder();
    const out = v(side, 0, 0);
    const fwd = v(0, 0, 1);
    const fore = (th: number) => S * 0.5 * (0.6 + 0.4 * Math.sin(th * 1.6)) * (0.8 + g.aspect * 0.4);
    const hind = (th: number) => S * 0.36 * (0.7 + 0.3 * Math.cos(th * 2)) * (1.1 - g.aspect * 0.3);
    const refl = (rr: number, th: number) => g.reflect905 * stripe(g, rr, th) * (rr > 0.85 ? 1.2 : 1);
    w.wing(v(0, 0, len * 0.1), fwd, out, fore, 0.05, 1.35, rings, spokes, MAT.insect, refl);
    w.wing(v(0, 0, -len * 0.05), fwd, out, hind, -1.2, 0.05, rings, spokes, MAT.insect, refl);
    wings.push({ geo: w.build(), side });
  }
  void r;
  return { body: body.build(), wings };
}

function beetle(g: Genome, r: Rng, detail: number): AnimalParts {
  const S = g.size; // длина
  const b = new GeoBuilder();
  const seg = Math.round(14 * detail);
  b.ellipsoid(v(0, S * 0.22, -S * 0.08), v(S * 0.28, S * 0.2, S * 0.38), seg, Math.round(8 * detail), MAT.insect,
    (u) => g.reflect905 * (Math.abs(Math.sin(u * Math.PI * 2)) < 0.08 ? 0.3 : stripe(g, u * 3, 0))); // шов надкрылий
  b.ellipsoid(v(0, S * 0.2, S * 0.3), v(S * 0.2, S * 0.14, S * 0.12), 10, 6, MAT.insect, () => g.reflect905 * 0.8);
  b.ellipsoid(v(0, S * 0.18, S * 0.45), v(S * 0.1, S * 0.08, S * 0.08), 8, 5, MAT.insect, () => 0.5);
  for (let k = 0; k < 3; k++) {
    for (const s of [-1, 1]) {
      const z = S * (0.2 - k * 0.22);
      const leg = [v(s * S * 0.15, S * 0.15, z), v(s * S * 0.38, S * 0.25, z + S * 0.05 * (k - 1)), v(s * S * 0.52, 0, z + S * 0.12 * (k - 1))];
      b.tube(leg, [S * 0.025, S * 0.02, S * 0.015], 3, MAT.insect, () => 0.4);
    }
  }
  for (const s of [-1, 1]) {
    const ant = [v(s * S * 0.04, S * 0.2, S * 0.52), v(s * S * 0.2, S * 0.3, S * 0.75), v(s * S * 0.28, S * 0.28, S * 0.95)];
    b.tube(ant, [S * 0.012, S * 0.01, S * 0.008], 3, MAT.insect, () => 0.4);
  }
  void r;
  return { body: b.build(), wings: [] };
}

function odonate(g: Genome, r: Rng, detail: number): AnimalParts {
  const S = g.size; // размах
  const body = new GeoBuilder();
  const segs = Math.max(6, g.segments);
  const L = S * 0.85;
  const path: V3[] = [];
  for (let i = 0; i <= segs; i++) path.push(v(0, 0, -L * 0.75 + (L * i) / segs));
  body.tube(path, path.map((_, i) => S * (i > segs - 3 ? 0.035 : 0.018) * (1 + 0.25 * (i % 2))), 5, MAT.insect, (t) => g.reflect905 * stripe(g, t * 4, 0));
  for (const s of [-1, 1]) body.ellipsoid(v(s * S * 0.035, S * 0.01, L * 0.28), v(S * 0.035, S * 0.035, S * 0.035), 8, 6, MAT.insect, () => 0.9);
  const wings: AnimalParts['wings'] = [];
  for (const side of [-1, 1] as const) {
    const w = new GeoBuilder();
    const narrow = (th: number) => S * 0.5 * Math.pow(Math.sin(Math.max(0, Math.min(Math.PI, th * 12 + Math.PI / 2))), 0.15) * (0.85 + g.aspect * 0.15);
    for (const dz of [0.14, 0.02]) {
      w.wing(v(0, S * 0.02, L * dz), v(0, 0, 1), v(side, 0, 0), narrow, -0.12, 0.12, Math.round(8 * detail), Math.round(6 * detail), MAT.insect,
        (rr) => 0.35 + 0.3 * Math.abs(Math.sin(rr * 18))); // жилкование
    }
    wings.push({ geo: w.build(), side });
  }
  void r;
  return { body: body.build(), wings };
}

export function buildAnimal(s: Species, seed: number, detail = 1): AnimalParts {
  const r = makeRng(seed);
  switch (s.clade) {
    case 'lepidoptera':
      return butterfly(s.genome, r, detail);
    case 'coleoptera':
      return beetle(s.genome, r, detail);
    case 'odonata':
      return odonate(s.genome, r, detail);
    default:
      throw new Error(`не животное: ${s.clade}`);
  }
}

/** Проставить id вида во всю геометрию (0 — не вид). */
export function tagSpecies(geo: THREE.BufferGeometry, speciesId: number | null): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  geo.setAttribute('aSpecies', new THREE.Float32BufferAttribute(new Array(n).fill(speciesId === null ? 0 : speciesId + 1), 1));
  return geo;
}

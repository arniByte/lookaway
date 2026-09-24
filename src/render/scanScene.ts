// Сцена, которую «видит» лидар. Игроку она не показывается никогда: только снимается в кубическую
// карту из точки импульса. Каждый пиксель: дистанция, материал + вид, интенсивность, радиальная скорость.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { config } from '../config';
import { buildAnimal, buildBeacon, buildFigure, buildGrass, buildLog, buildPebble, buildPlant, buildRock, buildShrub, buildStump, MAT, POSES, tagSpecies, type AnimalParts, type PoseName } from '../world/meshes';
import { makeRng } from '../world/random';
import type { World } from '../world/worldgen';

const SCAN_VERT = /* glsl */ `
  attribute float aRefl;
  attribute float aMat;
  attribute float aSpecies;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vRefl;
  varying float vCode;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vRefl = aRefl;
    vCode = aMat + aSpecies * 16.0;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const SCAN_FRAG = /* glsl */ `
  uniform vec3 uOrigin;
  uniform vec3 uVel;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vRefl;
  varying float vCode;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    vec3 d = vWorld - uOrigin;
    float dist = length(d);
    vec3 dir = d / max(dist, 1e-4);
    float cosi = abs(dot(normalize(vNormalW), dir));
    float intensity = clamp(vRefl * (0.25 + 0.75 * cosi), 0.0, 1.5);
    // Фактура: подстилка на земле, лишайник на камнях — пятна отражения, как в реальном скане.
    float mat = mod(vCode, 16.0);
    if (mat < 1.5) {
      vec2 p = vWorld.xz;
      intensity *= 0.62 + 0.42 * vnoise(p * 0.9) + 0.3 * vnoise(p * 4.3) - 0.12 * step(0.82, vnoise(p * 11.0));
    } else if (mat < 2.5) {
      intensity *= 0.75 + 0.5 * vnoise(vWorld.xz * 5.0 + vWorld.y * 3.0);
    }
    gl_FragColor = vec4(dist, vCode, intensity, dot(uVel, dir));
  }
`;

/** Общая «лидарная» ShaderMaterial. uOrigin общий объект — один на все материалы сцены. */
export function scanMaterial(origin: { value: THREE.Vector3 }, vel = new THREE.Vector3()): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SCAN_VERT,
    fragmentShader: SCAN_FRAG,
    side: THREE.DoubleSide,
    uniforms: { uOrigin: origin, uVel: { value: vel } },
  });
}

export interface AnimalRig {
  id: number;
  species: number;
  root: THREE.Group;
  wings: { pivot: THREE.Group; side: 1 | -1 }[];
  vel: THREE.Vector3;
}

/** Силуэт: одна фигура на каждую позу, видима одна. Скорость — для доплера. */
export interface StalkerRig {
  root: THREE.Group;
  poses: Map<PoseName, THREE.Mesh>;
  vel: THREE.Vector3;
  setPose(p: PoseName): void;
}

export class ScanScene {
  readonly scene = new THREE.Scene();
  readonly origin = { value: new THREE.Vector3() };
  readonly staticMat: THREE.ShaderMaterial;
  readonly animals = new Map<number, AnimalRig>();
  readonly stalker: StalkerRig;

  constructor(world: World, onProgress?: (k: number) => void) {
    this.staticMat = scanMaterial(this.origin);
    this.scene.add(this.buildTerrain(world));
    for (const mesh of this.buildTiles(world, onProgress)) this.scene.add(mesh);
    const beacon = new THREE.Mesh(tagSpecies(buildBeacon(), null), this.staticMat);
    beacon.position.set(world.beacon.x, world.beacon.y, world.beacon.z);
    this.scene.add(beacon);
    this.buildAnimals(world);

    // Силуэт: выше экспедиции, руки длиннее, длинные пальцы, без рюкзака — приметы для внимательных.
    const vel = new THREE.Vector3();
    const mat = scanMaterial(this.origin, vel);
    const root = new THREE.Group();
    const poses = new Map<PoseName, THREE.Mesh>();
    const sc = config.stalker;
    for (const name of Object.keys(POSES) as PoseName[]) {
      const m = new THREE.Mesh(tagSpecies(buildFigure(POSES[name], { height: 1.78 * sc.heightMul, armMul: sc.armMul, backpack: false, fingers: true }), null), mat);
      m.visible = name === 'stand';
      root.add(m);
      poses.set(name, m);
    }
    root.position.set(world.stalkerSpawn.x, world.stalkerSpawn.y, world.stalkerSpawn.z);
    this.scene.add(root);
    this.stalker = {
      root,
      poses,
      vel,
      setPose: (p) => {
        for (const [n, m] of poses) m.visible = n === p;
      },
    };
  }

  /** Освободить GPU-буферы: мир пересоздаётся на каждый забег. */
  dispose(): void {
    const mats = new Set<THREE.Material>();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        mats.add(o.material as THREE.Material);
      }
    });
    for (const m of mats) m.dispose();
  }

  private buildTerrain(world: World): THREE.Mesh {
    const R = world.radius + 18;
    const seg = Math.round((R * 2) / config.world.terrainStep);
    const g = new THREE.PlaneGeometry(R * 2, R * 2, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute('position');
    const rnd = makeRng(world.seed ^ 0x7e11);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, world.height(x, z));
    }
    g.computeVertexNormals();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', pos);
    geo.setAttribute('normal', g.getAttribute('normal'));
    const refl = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) refl[i] = 0.3 + 0.18 * rnd() + 0.12 * world.clearing(pos.getX(i), pos.getZ(i));
    geo.setAttribute('aRefl', new THREE.BufferAttribute(refl, 1));
    geo.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(pos.count).fill(MAT.terrain), 1));
    geo.setAttribute('aSpecies', new THREE.BufferAttribute(new Float32Array(pos.count), 1));
    geo.setIndex(g.getIndex());
    return new THREE.Mesh(geo, this.staticMat);
  }

  /** Статика слита по тайлам: один draw call на тайл, отсечение по фрустуму работает на тайлах. */
  private buildTiles(world: World, onProgress?: (k: number) => void): THREE.Mesh[] {
    const T = config.world.tileSize;
    const tiles = new Map<string, THREE.BufferGeometry[]>();
    const put = (x: number, z: number, g: THREE.BufferGeometry) => {
      const key = `${Math.floor(x / T)},${Math.floor(z / T)}`;
      let list = tiles.get(key);
      if (!list) tiles.set(key, (list = []));
      list.push(g);
    };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const place = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rot: number, scale: number) => {
      q.setFromAxisAngle(up, rot);
      s.setScalar(scale);
      m.compose(new THREE.Vector3(x, y, z), q, s);
      return geo.clone().applyMatrix4(m);
    };

    const variants = new Map<string, THREE.BufferGeometry>();
    const variant = (species: number, v: number) => {
      const key = `${species}:${v}`;
      let g = variants.get(key);
      if (!g) {
        g = tagSpecies(buildPlant(world.species[species], world.seed * 31 + species * 97 + v), species);
        variants.set(key, g);
      }
      return g;
    };
    const total = world.plants.length + world.rocks.length + world.grass.length;
    let done = 0;
    for (const p of world.plants) {
      put(p.x, p.z, place(variant(p.species, p.variant), p.x, p.y, p.z, p.rot, p.scale));
      if (++done % 200 === 0) onProgress?.(done / total);
    }
    for (const r of world.rocks) {
      put(r.x, r.z, place(tagSpecies(buildRock(r.seed, r.r), null), r.x, r.y - r.r * 0.15, r.z, 0, 1));
    }
    for (const l of world.logs) {
      m.compose(new THREE.Vector3(l.x, l.y - l.r * 0.35, l.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, l.yaw, l.tilt, 'YXZ')), new THREE.Vector3(1, 1, 1));
      put(l.x, l.z, tagSpecies(buildLog(l.seed, l.len, l.r), null).applyMatrix4(m));
    }
    for (const st of world.stumps) put(st.x, st.z, place(tagSpecies(buildStump(st.seed, st.scale), null), st.x, st.y, st.z, st.rot, 1));
    for (const f of world.statues) {
      put(f.x, f.z, place(tagSpecies(buildFigure(POSES[f.pose], { height: f.height, armMul: 1, backpack: true, fingers: false }), null), f.x, f.y, f.z, f.yaw, 1));
    }
    const shrubVariants = Array.from({ length: 5 }, (_, i) => tagSpecies(buildShrub(makeRng(world.seed * 7 + i), 1), null));
    world.shrubs.forEach((c, i) => put(c.x, c.z, place(shrubVariants[i % shrubVariants.length], c.x, c.y, c.z, c.rot, c.scale)));
    const pebbleVariants = Array.from({ length: 6 }, (_, i) => tagSpecies(buildPebble(makeRng(world.seed * 11 + i), 1), null));
    world.pebbles.forEach((c, i) => put(c.x, c.z, place(pebbleVariants[i % pebbleVariants.length], c.x, c.y, c.z, c.rot, c.scale)));
    const grassVariants = Array.from({ length: 6 }, (_, i) => tagSpecies(buildGrass(makeRng(world.seed + i)), null));
    world.grass.forEach((c, i) => {
      put(c.x, c.z, place(grassVariants[i % grassVariants.length], c.x, c.y, c.z, c.rot, c.scale));
      if (++done % 500 === 0) onProgress?.(done / total);
    });

    const meshes: THREE.Mesh[] = [];
    for (const list of tiles.values()) {
      const merged = mergeGeometries(list);
      for (const g of list) g.dispose();
      merged.computeBoundingSphere();
      meshes.push(new THREE.Mesh(merged, this.staticMat));
    }
    for (const g of [...variants.values(), ...grassVariants, ...shrubVariants, ...pebbleVariants]) g.dispose();
    onProgress?.(1);
    return meshes;
  }

  private buildAnimals(world: World): void {
    for (const a of world.animals) {
      const sp = world.species[a.species];
      const parts: AnimalParts = buildAnimal(sp, world.seed * 13 + a.species);
      const vel = new THREE.Vector3();
      const mat = scanMaterial(this.origin, vel);
      const root = new THREE.Group();
      root.add(new THREE.Mesh(tagSpecies(parts.body, sp.id), mat));
      const wings = parts.wings.map((w) => {
        const pivot = new THREE.Group();
        pivot.add(new THREE.Mesh(tagSpecies(w.geo, sp.id), mat));
        root.add(pivot);
        return { pivot, side: w.side };
      });
      root.position.set(a.x, a.y, a.z);
      this.scene.add(root);
      this.animals.set(a.id, { id: a.id, species: a.species, root, wings, vel });
    }
  }
}

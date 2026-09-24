// Сцена, которую «видит» лидар. Игроку она не показывается никогда: только снимается в кубическую
// карту из точки импульса. Каждый пиксель: дистанция, материал + вид, интенсивность, радиальная скорость.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { config } from '../config';
import { buildAnimal, buildBeacon, buildGrass, buildPlant, buildRock, MAT, tagSpecies, type AnimalParts } from '../world/meshes';
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
  void main() {
    vec3 d = vWorld - uOrigin;
    float dist = length(d);
    vec3 dir = d / max(dist, 1e-4);
    float cosi = abs(dot(normalize(vNormalW), dir));
    float intensity = clamp(vRefl * (0.25 + 0.75 * cosi), 0.0, 1.5);
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

/** Чёрная материя: поглощает лучи — возврата нет (дистанция 0), но заслоняет то, что за ней. */
const VOID_FRAG = /* glsl */ `void main() { gl_FragColor = vec4(0.0); }`;

export interface AnimalRig {
  id: number;
  species: number;
  root: THREE.Group;
  wings: { pivot: THREE.Group; side: 1 | -1 }[];
  vel: THREE.Vector3;
}

export class ScanScene {
  readonly scene = new THREE.Scene();
  readonly origin = { value: new THREE.Vector3() };
  readonly staticMat: THREE.ShaderMaterial;
  readonly animals = new Map<number, AnimalRig>();
  readonly dark: THREE.Mesh;

  constructor(world: World, onProgress?: (k: number) => void) {
    this.staticMat = scanMaterial(this.origin);
    this.scene.add(this.buildTerrain(world));
    for (const mesh of this.buildTiles(world, onProgress)) this.scene.add(mesh);
    const beacon = new THREE.Mesh(tagSpecies(buildBeacon(), null), this.staticMat);
    beacon.position.set(world.beacon.x, world.beacon.y, world.beacon.z);
    this.scene.add(beacon);
    this.buildAnimals(world);

    const darkGeo = new THREE.IcosahedronGeometry(1, 3);
    const p = darkGeo.getAttribute('position');
    const rnd = makeRng(world.seed ^ 0xdead);
    for (let i = 0; i < p.count; i++) {
      const k = 1 + (rnd() - 0.5) * 0.25;
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 1.25, p.getZ(i) * k);
    }
    this.dark = new THREE.Mesh(darkGeo, new THREE.ShaderMaterial({ vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}', fragmentShader: VOID_FRAG, side: THREE.DoubleSide }));
    this.dark.scale.setScalar(config.dark.radius);
    this.dark.position.set(world.darkSpawn.x, world.darkSpawn.y + config.dark.radius, world.darkSpawn.z);
    this.scene.add(this.dark);
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
    for (const g of variants.values()) g.dispose();
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

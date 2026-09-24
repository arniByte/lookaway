// Детальный скан образца (GDD → Наука): поворотный стол, облако плотнеет, три прохода окраски.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { config } from '../config';
import { buildAnimal, buildPlant } from '../world/meshes';
import { makeRng } from '../world/random';
import { sampleSurface } from '../world/sample';
import type { Species } from '../world/species';

const VERT = /* glsl */ `
  attribute vec3 aNormal;
  attribute float aRefl;
  attribute float aRand;
  uniform float uProgress;
  uniform float uTime;
  uniform vec3 uLum;
  uniform float uHasLum;
  uniform float uSize;
  uniform float uLook;      // ≥0 — показать проход целиком (титул), иначе по uProgress
  varying vec3 vColor;
  varying float vAlpha;
  varying float vDepth;

  vec3 ramp(float t) { // viridis: та же шкала, что у палитры «высота»
    t = clamp(t, 0.0, 1.0) * 5.0;
    vec3 c0 = vec3(0.267, 0.005, 0.329), c1 = vec3(0.255, 0.267, 0.529), c2 = vec3(0.165, 0.471, 0.557);
    vec3 c3 = vec3(0.133, 0.659, 0.518), c4 = vec3(0.478, 0.820, 0.318), c5 = vec3(0.992, 0.906, 0.145);
    if (t < 1.0) return mix(c0, c1, t);
    if (t < 2.0) return mix(c1, c2, t - 1.0);
    if (t < 3.0) return mix(c2, c3, t - 2.0);
    if (t < 4.0) return mix(c3, c4, t - 3.0);
    return mix(c4, c5, t - 4.0);
  }

  void main() {
    float shown = uLook >= 0.0 ? 1.0 : clamp(uProgress * 1.25, 0.0, 1.0); // плотнеет в первые 80% скана
    if (aRand > shown) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize;
    vDepth = log2(1.0 + max(-mv.z, 0.0) * 8.0); // образец мелкий: растянуть глубину для контуров
    vec3 n = normalize(normalMatrix * aNormal);
    float facing = abs(n.z);
    vec3 geo = mix(vec3(0.16, 0.16, 0.17), vec3(0.95, 0.94, 0.9), facing);
    vec3 refl = ramp(aRefl);
    float pulse = 0.6 + 0.4 * sin(uTime * 3.0 + aRand * 20.0);
    vec3 lum = uHasLum > 0.5 ? uLum * (0.5 + pulse * aRefl) : refl * (0.25 + 0.2 * facing); // не светится — приглушённое отражение
    float p = uLook >= 0.0 ? uLook : uProgress * 3.0;
    vec3 c = p < 1.0 ? geo : p < 2.0 ? mix(geo, refl, clamp((p - 1.0) * 3.0, 0.0, 1.0)) : mix(refl, lum, clamp((p - 2.0) * 3.0, 0.0, 1.0));
    float fresh = smoothstep(shown - 0.03, shown, aRand);        // только что пойманные точки ярче
    vColor = c + fresh * 0.6;
    vAlpha = 0.85;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vDepth;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    gl_FragColor = vec4(vColor * vAlpha, vDepth); // alpha — log-глубина для EDL (composer.ts)
  }
`;

/** Длина волны (нм) → приблизительный RGB. */
export function wavelengthColor(nm: number): THREE.Color {
  const stops: [number, number, number, number][] = [
    [420, 0.45, 0.2, 1],
    [470, 0.1, 0.5, 1],
    [500, 0.1, 1, 0.8],
    [540, 0.4, 1, 0.2],
    [580, 1, 0.9, 0.1],
    [620, 1, 0.45, 0.1],
  ];
  if (nm <= stops[0][0]) return new THREE.Color(stops[0][1], stops[0][2], stops[0][3]);
  for (let i = 1; i < stops.length; i++) {
    if (nm <= stops[i][0]) {
      const [a, ar, ag, ab] = stops[i - 1];
      const [b, br, bg, bb] = stops[i];
      const k = (nm - a) / (b - a);
      return new THREE.Color(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k);
    }
  }
  const l = stops[stops.length - 1];
  return new THREE.Color(l[1], l[2], l[3]);
}

export class SpecimenView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  private holder = new THREE.Group();
  private points: THREE.Points | null = null;
  private mat: THREE.ShaderMaterial;
  private spin = 0;
  active = false;

  constructor() {
    this.scene.add(this.holder);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      // Обычное смешивание: в плотном облаке аддитив выжигает цвета проходов в белый.
      transparent: false,
      depthWrite: true,
      uniforms: {
        uProgress: { value: 0 },
        uTime: { value: 0 },
        uLum: { value: new THREE.Color() },
        uHasLum: { value: 0 },
        uSize: { value: 2 },
        uLook: { value: -1 },
      },
    });
  }

  open(s: Species, seed: number): void {
    let geo: THREE.BufferGeometry;
    if (s.kingdom === 'plant') {
      geo = buildPlant(s, seed, 2);
    } else {
      const parts = buildAnimal(s, seed, 3);
      const wings = parts.wings.map((w) => w.geo.clone().rotateZ(w.side * 0.35)); // крылья приподняты
      geo = mergeGeometries([parts.body, ...wings]);
    }
    this.load(geo, seed, s.kingdom === 'animal' ? 0.5 : 0.15, s.genome.lumPeak);
  }

  /** Произвольная геометрия (фон титула: силуэт). */
  openGeometry(geo: THREE.BufferGeometry, seed: number, tilt = 0.05): void {
    this.load(geo, seed, tilt, 0);
  }

  private load(geo: THREE.BufferGeometry, seed: number, tilt: number, lumPeak: number): void {
    this.close();
    geo.computeBoundingSphere();
    const bs = geo.boundingSphere!;
    geo.translate(-bs.center.x, -bs.center.y, -bs.center.z);
    const n = config.research.specimenPoints;
    const smp = sampleSurface(geo, n, makeRng(seed ^ 0x51ec));
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(smp.pos, 3));
    pg.setAttribute('aNormal', new THREE.BufferAttribute(smp.nrm, 3));
    pg.setAttribute('aRefl', new THREE.BufferAttribute(smp.refl, 1));
    pg.setAttribute('aRand', new THREE.BufferAttribute(smp.rand, 1));
    this.points = new THREE.Points(pg, this.mat);
    this.points.frustumCulled = false;
    this.holder.add(this.points);
    this.holder.rotation.set(tilt, 0, 0);
    const dist = bs.radius / Math.sin(((this.camera.fov / 2) * Math.PI) / 180) * 1.15;
    this.camera.position.set(0, 0, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 4;
    this.camera.lookAt(0, 0, 0);
    this.mat.uniforms.uHasLum.value = lumPeak ? 1 : 0;
    (this.mat.uniforms.uLum.value as THREE.Color).copy(wavelengthColor(lumPeak || 500));
    this.mat.uniforms.uProgress.value = 0;
    geo.dispose();
    this.active = true;
  }

  close(): void {
    if (this.points) {
      this.holder.remove(this.points);
      this.points.geometry.dispose();
      this.points = null;
    }
    this.active = false;
  }

  /** drag — поворот мышью (рад), progress — 0..1; look ≥ 0 — фиксированный вид прохода (0..3). */
  update(progress: number, dtMs: number, time: number, drag: number, look = -1): void {
    this.spin += dtMs * 0.00035 + drag;
    this.holder.rotation.y = this.spin;
    this.mat.uniforms.uProgress.value = progress;
    this.mat.uniforms.uTime.value = time / 1000;
    this.mat.uniforms.uLook.value = look;
  }

  /** Подготовить камеру к кадру. shift — сдвиг образца по экрану (доля ширины, + вправо). */
  prepare(renderer: THREE.WebGLRenderer, shift = 0): void {
    const size = renderer.getSize(new THREE.Vector2());
    this.camera.aspect = size.x / size.y;
    if (shift) this.camera.setViewOffset(size.x, size.y, -shift * size.x, 0, size.x, size.y);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.mat.uniforms.uSize.value = Math.max(1.5, (size.y / 720) * 2.2) * renderer.getPixelRatio();
  }
}

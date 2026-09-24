// Детальный скан образца (GDD → Наука): поворотный стол, облако плотнеет, три прохода окраски.
import * as THREE from 'three';
import { config } from '../config';
import { buildAnimal, buildPlant, type AnimalParts } from '../world/meshes';
import { makeRng } from '../world/random';
import { sampleSurface, surfaceArea } from '../world/sample';
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
  uniform float uPattern;   // рисунок отражения в монохромном проходе (жилки, глазки)
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
    vec3 geo = mix(vec3(0.16, 0.16, 0.17), vec3(0.95, 0.94, 0.9), facing) * mix(1.0, 0.22 + 0.9 * clamp(aRefl, 0.0, 1.2), uPattern);
    vec3 refl = ramp(aRefl);
    float pulse = 0.6 + 0.4 * sin(uTime * 3.0 + aRand * 20.0);
    vec3 lum = uHasLum > 0.5 ? uLum * (0.5 + pulse * aRefl) : refl * (0.25 + 0.2 * facing); // не светится — приглушённое отражение
    float p = uLook >= 0.0 ? uLook : uProgress * 3.0;
    vec3 c = p < 1.0 ? geo : p < 2.0 ? mix(geo, refl, clamp((p - 1.0) * 3.0, 0.0, 1.0)) : mix(refl, lum, clamp((p - 2.0) * 3.0, 0.0, 1.0));
    float fresh = uLook >= 0.0 ? 0.0 : smoothstep(shown - 0.03, shown, aRand); // только что пойманные точки ярче
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
  private model = new THREE.Group();
  private clouds: THREE.Points[] = [];
  private wings: { pivot: THREE.Group; side: 1 | -1 }[] = [];
  private mat: THREE.ShaderMaterial;
  private spin = 0;
  active = false;

  constructor() {
    this.holder.add(this.model);
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
        uPattern: { value: 0.5 },
      },
    });
  }

  open(s: Species, seed: number): void {
    if (s.kingdom === 'plant') this.load([{ geo: buildPlant(s, seed, 2) }], seed, 0.15, s.genome.lumPeak);
    else this.openAnimal(buildAnimal(s, seed, 3), seed, s.genome.lumPeak);
  }

  /** Животное по частям: крылья — отдельные облака на шарнирах, машут. */
  openAnimal(parts: AnimalParts, seed: number, lumPeak = 0, tilt = 0.5, points = config.research.specimenPoints): void {
    this.load([{ geo: parts.body }, ...parts.wings.map((w) => ({ geo: w.geo, side: w.side }))], seed, tilt, lumPeak, points);
  }

  /** Произвольная геометрия. */
  openGeometry(geo: THREE.BufferGeometry, seed: number, tilt = 0.05): void {
    this.load([{ geo }], seed, tilt, 0);
  }

  private load(parts: { geo: THREE.BufferGeometry; side?: 1 | -1 }[], seed: number, tilt: number, lumPeak: number, points = config.research.specimenPoints): void {
    this.close();
    const box = new THREE.Box3();
    for (const p of parts) {
      p.geo.computeBoundingBox();
      box.union(p.geo.boundingBox!);
    }
    const bs = box.getBoundingSphere(new THREE.Sphere());
    this.model.position.copy(bs.center).negate();
    const areas = parts.map((p) => surfaceArea(p.geo));
    const total = areas.reduce((a, b) => a + b, 0) || 1;
    parts.forEach((p, i) => {
      const smp = sampleSurface(p.geo, Math.max(200, Math.round((points * areas[i]) / total)), makeRng((seed ^ 0x51ec) + i));
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(smp.pos, 3));
      pg.setAttribute('aNormal', new THREE.BufferAttribute(smp.nrm, 3));
      pg.setAttribute('aRefl', new THREE.BufferAttribute(smp.refl, 1));
      pg.setAttribute('aRand', new THREE.BufferAttribute(smp.rand, 1));
      const pts = new THREE.Points(pg, this.mat);
      pts.frustumCulled = false;
      if (p.side) {
        // Шарнир — ось тела (Z): крыло поворачивается вокруг неё.
        const pivot = new THREE.Group();
        pivot.add(pts);
        this.model.add(pivot);
        this.wings.push({ pivot, side: p.side });
      } else {
        this.model.add(pts);
      }
      this.clouds.push(pts);
      p.geo.dispose();
    });
    this.holder.rotation.set(tilt, 0, 0);
    const dist = (bs.radius / Math.sin(((this.camera.fov / 2) * Math.PI) / 180)) * 1.15;
    this.camera.position.set(0, 0, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 4;
    this.camera.lookAt(0, 0, 0);
    this.mat.uniforms.uHasLum.value = lumPeak ? 1 : 0;
    (this.mat.uniforms.uLum.value as THREE.Color).copy(wavelengthColor(lumPeak || 500));
    this.mat.uniforms.uProgress.value = 0;
    this.active = true;
  }

  close(): void {
    for (const c of this.clouds) c.geometry.dispose();
    this.model.clear();
    this.clouds = [];
    this.wings = [];
    this.active = false;
  }

  /**
   * drag — поворот мышью (рад), progress — 0..1. opts: look ≥ 0 — фиксированный проход (0..3);
   * flap — размах взмаха крыльев, рад; yaw/tilt — задать ракурс вместо вращения; pattern — рисунок в монохроме.
   */
  update(progress: number, dtMs: number, time: number, drag: number, opts: { look?: number; flap?: number; yaw?: number; tilt?: number; pattern?: number } = {}): void {
    this.spin += dtMs * 0.00035 + drag;
    this.holder.rotation.y = opts.yaw ?? this.spin;
    if (opts.tilt !== undefined) this.holder.rotation.x = opts.tilt;
    const t = time / 1000;
    const flap = opts.flap ?? 0.18;
    for (const w of this.wings) w.pivot.rotation.z = w.side * (0.3 + flap * Math.sin(t * 1.6));
    this.mat.uniforms.uProgress.value = progress;
    this.mat.uniforms.uTime.value = t;
    this.mat.uniforms.uLook.value = opts.look ?? -1;
    this.mat.uniforms.uPattern.value = opts.pattern ?? 0.5;
  }

  /** Подготовить камеру к кадру. shift — сдвиг образца по экрану (доля ширины, + вправо). */
  prepare(renderer: THREE.WebGLRenderer, shift = 0, sizeMul = 1): void {
    const size = renderer.getSize(new THREE.Vector2());
    this.camera.aspect = size.x / size.y;
    if (shift) this.camera.setViewOffset(size.x, size.y, -shift * size.x, 0, size.x, size.y);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.mat.uniforms.uSize.value = Math.max(1.2, (size.y / 720) * 2.2 * sizeMul) * renderer.getPixelRatio();
  }
}

// Лидар (GDD → Лидар): импульс = снимок сцены в кубическую карту; облако = N направлений,
// вершинный шейдер берёт дистанцию из куба и ставит точку в мир. Облако привязано к миру и живёт,
// пока его не сотрут моргания и время.
import * as THREE from 'three';
import { config } from '../config';
import type { ScanScene } from './scanScene';

const POINT_VERT = /* glsl */ `
  attribute vec3 dir;
  attribute float seed;
  uniform samplerCube uCube;
  uniform mat3 uRot;
  uniform vec3 uOrigin;
  uniform float uAge;        // с момента импульса, с
  uniform float uWave;       // скорость фронта, м/с
  uniform float uRange;
  uniform float uErosion;    // 0..1: доля стёртых морганиями
  uniform float uAlpha;
  uniform float uScale;
  uniform vec3 uDark;        // позиция чёрной материи на момент импульса
  uniform float uDarkOn;
  uniform float uLensAngle;
  uniform float uLensStrength;
  uniform float uUnknown[16];
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec3 d = normalize(uRot * dir);
    vec4 s = texture(uCube, d);
    float dist = s.r;
    float front = uAge * uWave;
    if (dist < 0.05 || dist > uRange || dist > front || seed < uErosion) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec3 world = uOrigin + d * dist;

    // Гравитационное линзирование: точки рядом с чёрной материей тянет к ней.
    if (uDarkOn > 0.5) {
      vec3 toDark = uDark - uOrigin;
      float dd = length(toDark);
      float ang = acos(clamp(dot(d, toDark / dd), -1.0, 1.0));
      float k = 1.0 - smoothstep(0.0, uLensAngle, ang);
      if (k > 0.0 && dist > dd * 0.6) world += normalize(uDark - world) * uLensStrength * k * k;
    }

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uScale / max(-mv.z, 0.05), 1.0, 4.5);

    float code = s.g;
    float sp = floor(code / 16.0 + 0.01);
    float mat = code - sp * 16.0;
    float inten = s.b;
    float vel = s.a;

    vec3 col = mix(vec3(0.06, 0.26, 0.34), vec3(0.72, 0.96, 1.0), clamp(inten, 0.0, 1.0));
    if (mat < 1.5) col *= 0.7;                                   // рельеф тусклее
    if (mat > 7.5) col = vec3(1.0, 0.82, 0.42) * 1.3;            // маяк
    if (sp > 0.5) {
      int si = int(sp) - 1;
      float unknown = si < 16 ? uUnknown[si] : 0.0;
      float bio = mat > 6.5 ? 1.0 : (mat > 4.5 ? 0.85 : (mat > 3.5 ? 0.45 : 0.25));
      col = mix(col, vec3(1.0, 0.6, 0.24) * (0.6 + 0.6 * inten), unknown * bio * 0.7);
    }
    float dop = clamp(abs(vel) * 1.4, 0.0, 0.9);
    col = mix(col, vel > 0.0 ? vec3(1.0, 0.28, 0.22) : vec3(0.3, 0.5, 1.0), dop);

    float glow = exp(-(front - dist) * 1.2);                     // свежие отражения у фронта
    col += vec3(0.5, 0.8, 1.0) * glow * 0.8;
    float fall = 1.0 - smoothstep(uRange * 0.45, uRange, dist);
    vColor = col * (0.4 + 0.6 * fall);
    vAlpha = uAlpha * (0.35 + 0.65 * fall);
  }
`;

const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = dot(c, c);
    if (r > 0.25) discard;
    gl_FragColor = vec4(vColor, vAlpha * (1.0 - r * 2.5));
  }
`;

/** Направления лучей: сфера Фибоначчи, сгущённая к горизонту (там почти вся информация). */
export function scanDirections(n: number, horizonBias: number): { dir: Float32Array; seed: Float32Array } {
  const dir = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  let s = 12345;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    let y = 1 - (2 * (i + 0.5)) / n; // −1..1 равномерно по площади
    y = y * (1 - horizonBias) + y * y * y * horizonBias; // к горизонту, плотность конечная (без яркой линии)
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    dir[i * 3] = Math.cos(th) * r;
    dir[i * 3 + 1] = y;
    dir[i * 3 + 2] = Math.sin(th) * r;
    seed[i] = rnd();
  }
  return { dir, seed };
}

export interface ScanRecord {
  id: number;
  time: number; // мс, игровое время импульса
  origin: THREE.Vector3;
  erosion: number;
  rt: THREE.WebGLCubeRenderTarget;
  points: THREE.Points;
  mat: THREE.ShaderMaterial;
}

export class Lidar {
  readonly group = new THREE.Group();
  readonly scans: ScanRecord[] = [];
  private geo: THREE.BufferGeometry;
  private cubeCam: THREE.CubeCamera;
  private pool: THREE.WebGLCubeRenderTarget[] = [];
  private nextId = 1;
  /** 1 — вид не задокументирован (биосигнатура тёплая). */
  readonly unknown = new Array(16).fill(1);

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scanScene: ScanScene,
  ) {
    const lc = config.lidar;
    const { dir, seed } = scanDirections(lc.points, lc.horizonBias);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('dir', new THREE.BufferAttribute(dir, 3));
    this.geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    // Позиции считает шейдер; фиктивный position и огромная сфера — чтобы три не отсекал облако.
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lc.points * 3), 3));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const rt = this.makeTarget();
    this.cubeCam = new THREE.CubeCamera(0.05, lc.range, rt);
    this.pool.push(rt);
  }

  private makeTarget(): THREE.WebGLCubeRenderTarget {
    return new THREE.WebGLCubeRenderTarget(config.lidar.cubeSize, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
  }

  /** Импульс из точки origin в момент time. dark — позиция чёрной материи (для линзирования) или null. */
  pulse(origin: THREE.Vector3, time: number, dark: THREE.Vector3 | null): ScanRecord {
    const lc = config.lidar;
    while (this.scans.length >= lc.maxScans) this.drop(this.scans[0]);
    const rt = this.pool.pop() ?? this.makeTarget();

    this.scanScene.origin.value.copy(origin);
    (this.cubeCam as unknown as { renderTarget: THREE.WebGLCubeRenderTarget }).renderTarget = rt;
    this.cubeCam.position.copy(origin);
    this.cubeCam.updateMatrixWorld();
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    this.cubeCam.update(this.renderer, this.scanScene.scene);
    this.renderer.setClearColor(prevClear, prevAlpha);

    // Случайный поворот сетки лучей: соседние импульсы не повторяют узор.
    const rot = new THREE.Matrix3().setFromMatrix4(
      new THREE.Matrix4().makeRotationY(Math.random() * Math.PI * 2).multiply(new THREE.Matrix4().makeRotationX((Math.random() - 0.5) * 0.02)),
    );
    const mat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uCube: { value: rt.texture },
        uRot: { value: rot },
        uOrigin: { value: origin.clone() },
        uAge: { value: 0 },
        uWave: { value: lc.waveSpeed },
        uRange: { value: lc.range },
        uErosion: { value: 0 },
        uAlpha: { value: 1 },
        uScale: { value: lc.pointScale * this.renderer.getPixelRatio() * 10 },
        uDark: { value: dark ? dark.clone() : new THREE.Vector3() },
        uDarkOn: { value: dark ? 1 : 0 },
        uLensAngle: { value: lc.lensAngle },
        uLensStrength: { value: lc.lensStrength },
        uUnknown: { value: this.unknown },
      },
    });
    const points = new THREE.Points(this.geo, mat);
    points.frustumCulled = false;
    this.group.add(points);
    const rec: ScanRecord = { id: this.nextId++, time, origin: origin.clone(), erosion: 0, rt, points, mat };
    this.scans.push(rec);
    return rec;
  }

  /** Моргание: каждое облако теряет долю оставшихся точек. */
  blink(): void {
    for (const s of this.scans) s.erosion += (1 - s.erosion) * config.lidar.blinkErase;
  }

  private drop(s: ScanRecord): void {
    this.group.remove(s.points);
    s.mat.dispose();
    this.pool.push(s.rt);
    this.scans.splice(this.scans.indexOf(s), 1);
  }

  /** now — игровое время, мс. */
  update(now: number): void {
    const lc = config.lidar;
    for (const s of [...this.scans]) {
      const age = now - s.time;
      const k = age / lc.persistMs;
      if (k >= 1 || s.erosion > 0.995) {
        this.drop(s);
        continue;
      }
      const u = s.mat.uniforms;
      u.uAge.value = age / 1000;
      u.uErosion.value = s.erosion;
      u.uAlpha.value = k < lc.fadeFrom ? 1 : 1 - (k - lc.fadeFrom) / (1 - lc.fadeFrom);
    }
  }

  clear(): void {
    for (const s of [...this.scans]) this.drop(s);
  }
}

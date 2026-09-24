// Лидар (GDD → Лидар): импульс = снимок сцены в кубическую карту; облако = N лучей,
// вершинный шейдер берёт дистанцию из куба и ставит точку в мир. Облако привязано к миру и живёт,
// пока его не сотрут моргания и время. Точки непрозрачные: пишут цвет и log-глубину для EDL (composer.ts).
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
  uniform float uAlive;      // 1..0: угасание к концу жизни (растворение)
  uniform float uMemory;     // 0..1: возраст облака (старое — тусклее и серее)
  uniform float uDim;
  uniform float uFoot;       // угловой шаг лучей × заполнение, рад
  uniform float uProj;       // пикс. на единицу tan угла (высота буфера / 2tg(fov/2))
  uniform float uMaxSize;
  uniform vec3 uDark;        // позиция чёрной материи на момент импульса
  uniform float uDarkOn;
  uniform float uLensAngle;
  uniform float uLensStrength;
  uniform float uUnknown[16];
  uniform int uPalette;      // 0 — интенсивность, 1 — высота, 2 — классы
  uniform float uGround;     // высота земли под точкой импульса
  uniform float uGain;       // усиление интенсивности (типичный возврат 0.1..0.6)
  varying vec3 vColor;
  varying float vDepth;

  vec3 viridis(float t) {
    t = clamp(t, 0.0, 1.0) * 5.0;
    vec3 c0 = vec3(0.267, 0.005, 0.329), c1 = vec3(0.255, 0.267, 0.529), c2 = vec3(0.165, 0.471, 0.557);
    vec3 c3 = vec3(0.133, 0.659, 0.518), c4 = vec3(0.478, 0.820, 0.318), c5 = vec3(0.992, 0.906, 0.145);
    if (t < 1.0) return mix(c0, c1, t);
    if (t < 2.0) return mix(c1, c2, t - 1.0);
    if (t < 3.0) return mix(c2, c3, t - 2.0);
    if (t < 4.0) return mix(c3, c4, t - 3.0);
    return mix(c4, c5, t - 4.0);
  }

  vec3 classColor(float mat) {
    if (mat < 1.5) return vec3(0.62, 0.52, 0.40);   // земля
    if (mat < 2.5) return vec3(0.60, 0.62, 0.66);   // камень
    if (mat < 3.5) return vec3(0.58, 0.40, 0.28);   // кора
    if (mat < 4.5) return vec3(0.38, 0.66, 0.38);   // листва
    if (mat < 5.5) return vec3(0.90, 0.56, 0.74);   // лепестки
    if (mat < 6.5) return vec3(0.88, 0.78, 0.56);   // грибы
    if (mat < 7.5) return vec3(0.42, 0.78, 0.96);   // насекомые
    return vec3(1.0);                               // маяк
  }

  void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; }

  void main() {
    vec3 d = normalize(uRot * dir);
    vec4 s = texture(uCube, d);
    float dist = s.r;
    float front = uAge * uWave;
    float dissolve = fract(seed * 7.31 + 0.13);
    if (dist < 0.05 || dist > uRange || dist > front || seed < uErosion || dissolve > uAlive) { hide(); return; }
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
    float z = max(-mv.z, 0.05);
    gl_Position = projectionMatrix * mv;
    // Пятно луча растёт с дистанцией от сканера; на экране — делится на дистанцию до глаза.
    gl_PointSize = clamp(uFoot * max(dist, 0.6) * uProj / z, 1.0, uMaxSize);
    vDepth = log2(1.0 + z);

    float code = s.g;
    float sp = floor(code / 16.0 + 0.01);
    float mat = code - sp * 16.0;
    float inten = clamp(s.b, 0.0, 1.2);
    float vel = s.a;

    vec3 col;
    float shadeI = pow(clamp(inten * uGain, 0.0, 1.0), 0.65);
    if (uPalette == 1) {
      col = viridis((world.y - uGround + 1.0) / 14.0) * (0.45 + 0.6 * shadeI);
    } else if (uPalette == 2) {
      col = classColor(mat) * (0.45 + 0.6 * shadeI);
    } else {
      col = mix(vec3(0.085, 0.09, 0.1), vec3(0.95, 0.97, 1.0), shadeI);
      if (mat < 1.5) col *= 0.82;
      if (mat > 7.5) col = vec3(1.0, 0.98, 0.94) * 1.15;          // маяк — ретрорефлектор
    }

    // Неописанная жизнь — «unclassified»: янтарная подпись поверх любой палитры.
    if (sp > 0.5) {
      int si = int(sp) - 1;
      float unknown = si < 16 ? uUnknown[si] : 0.0;
      float bio = mat > 6.5 ? 1.0 : (mat > 4.5 ? 0.9 : (mat > 3.5 ? 0.55 : 0.3));
      col = mix(col, vec3(0.98, 0.70, 0.34) * (0.55 + 0.6 * shadeI), unknown * bio * 0.85);
    }
    // Доплер: движущееся к сканеру — теплее, от него — холоднее.
    float dop = clamp((abs(vel) - 0.05) * 1.2, 0.0, 0.6);
    col = mix(col, vel > 0.0 ? vec3(1.0, 0.35, 0.3) : vec3(0.35, 0.55, 1.0), dop);

    // Фронт волны: только что пойманные отражения вспыхивают.
    float glow = exp(-(front - dist) * 1.6);
    col += vec3(0.75, 0.85, 1.0) * glow * 0.9;
    // Край дальности и память: дальнее и старое гаснет и выцветает.
    float fall = 1.0 - smoothstep(uRange * 0.55, uRange, dist);
    float lum = dot(col, vec3(0.3, 0.55, 0.15));
    col = mix(col, vec3(lum), uMemory * 0.55);
    vColor = col * (0.35 + 0.65 * fall) * (1.0 - 0.4 * uMemory) * uDim;
  }
`;

const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vDepth;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    gl_FragColor = vec4(vColor, vDepth);
  }
`;

/**
 * Лучи как у вращающегося сканера: каналы по углу места (гуще у горизонта), в канале — равный шаг
 * по азимуту. На земле получаются кольца, на стволах — строки развёртки.
 */
export function ringDirections(total: number, channels: number, horizonBias: number): { dir: Float32Array; seed: Float32Array; foot: number } {
  const ys: number[] = [];
  for (let c = 0; c < channels; c++) {
    let y = -0.985 + (1.885 * (c + 0.5)) / channels; // −0.985..0.9: зенит пустой (небо), надир — ноги
    y = y * (1 - horizonBias) + y * y * y * horizonBias;
    ys.push(y);
  }
  const ring = ys.map((y) => Math.sqrt(Math.max(0, 1 - y * y)));
  const k = total / ring.reduce((a, b) => a + b, 0);
  const counts = ring.map((r) => Math.max(6, Math.round(k * r)));
  const n = counts.reduce((a, b) => a + b, 0);
  const dir = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  let s = 12345;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let i = 0;
  ys.forEach((y, c) => {
    const m = counts[c];
    const off = rnd() * Math.PI * 2; // сдвиг азимута канала: без радиальных «спиц»
    for (let j = 0; j < m; j++) {
      const th = off + (j / m) * Math.PI * 2;
      dir[i * 3] = Math.cos(th) * ring[c];
      dir[i * 3 + 1] = y;
      dir[i * 3 + 2] = Math.sin(th) * ring[c];
      seed[i] = rnd();
      i++;
    }
  });
  return { dir, seed, foot: (Math.PI * 2) / k }; // азимутальный шаг у горизонта, рад
}

export interface ScanRecord {
  id: number;
  time: number; // мс, игровое время импульса
  origin: THREE.Vector3;
  range: number;
  erosion: number;
  rt: THREE.WebGLCubeRenderTarget;
  points: THREE.Points;
  mat: THREE.ShaderMaterial;
}

export const PALETTES = ['интенсивность', 'высота', 'классы'] as const;

export class Lidar {
  readonly group = new THREE.Group();
  readonly scans: ScanRecord[] = [];
  private geo: THREE.BufferGeometry;
  private foot: number;
  private cubeCam: THREE.CubeCamera;
  private pool: THREE.WebGLCubeRenderTarget[] = [];
  private nextId = 1;
  /** 1 — вид не задокументирован (янтарная подпись). */
  readonly unknown = new Array(16).fill(1);
  /** Приглушение облака (детальный скан поверх). */
  dim = 1;
  palette = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scanScene: ScanScene,
  ) {
    const lc = config.lidar;
    const { dir, seed, foot } = ringDirections(lc.points, lc.channels, lc.horizonBias);
    this.foot = foot;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('dir', new THREE.BufferAttribute(dir, 3));
    this.geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    // Позиции считает шейдер; фиктивный position и огромная сфера — чтобы три не отсекал облако.
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seed.length * 3), 3));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const rt = this.makeTarget();
    this.cubeCam = new THREE.CubeCamera(0.05, config.scanner.rangeMax + config.scanner.rangePerSpecies * 16, rt);
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

  /** Импульс из origin в момент time на дальность range. dark — позиция чёрной материи (линзирование) или null. */
  pulse(origin: THREE.Vector3, time: number, range: number, ground: number, dark: THREE.Vector3 | null): ScanRecord {
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
      new THREE.Matrix4().makeRotationY(Math.random() * Math.PI * 2).multiply(new THREE.Matrix4().makeRotationX((Math.random() - 0.5) * 0.006)),
    );
    const mat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: {
        uCube: { value: rt.texture },
        uRot: { value: rot },
        uOrigin: { value: origin.clone() },
        uAge: { value: 0 },
        uWave: { value: lc.waveSpeed },
        uRange: { value: range },
        uErosion: { value: 0 },
        uAlive: { value: 1 },
        uMemory: { value: 0 },
        uDim: { value: 1 },
        uFoot: { value: this.foot * lc.pointFill },
        uProj: { value: 1 },
        uMaxSize: { value: lc.maxPointPx },
        uDark: { value: dark ? dark.clone() : new THREE.Vector3() },
        uDarkOn: { value: dark ? 1 : 0 },
        uLensAngle: { value: lc.lensAngle },
        uLensStrength: { value: lc.lensStrength },
        uUnknown: { value: this.unknown },
        uPalette: { value: this.palette },
        uGround: { value: ground },
        uGain: { value: lc.gain },
      },
    });
    const points = new THREE.Points(this.geo, mat);
    points.frustumCulled = false;
    this.group.add(points);
    const rec: ScanRecord = { id: this.nextId++, time, origin: origin.clone(), range, erosion: 0, rt, points, mat };
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

  /** now — игровое время, мс; camera — для перевода размера пятна в пиксели. */
  update(now: number, camera: THREE.PerspectiveCamera): void {
    const lc = config.lidar;
    const h = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    const proj = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const pr = this.renderer.getPixelRatio();
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
      u.uAlive.value = k < lc.fadeFrom ? 1 : 1 - (k - lc.fadeFrom) / (1 - lc.fadeFrom);
      u.uMemory.value = Math.min(1, k / lc.fadeFrom);
      u.uDim.value = this.dim;
      u.uProj.value = proj;
      u.uMaxSize.value = lc.maxPointPx * pr;
      u.uPalette.value = this.palette;
      u.uGain.value = lc.gain;
      u.uFoot.value = this.foot * lc.pointFill;
    }
  }

  clear(): void {
    for (const s of [...this.scans]) this.drop(s);
  }

  dispose(): void {
    this.clear();
    for (const rt of this.pool) rt.dispose();
    this.pool = [];
    this.geo.dispose();
  }
}

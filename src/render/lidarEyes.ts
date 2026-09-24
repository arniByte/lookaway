// Лидар-портрет глаз (калибровка): крупный план глаз игрока облаком точек-полутонов.
// Одно из двух мест, где читается FaceFrame (CLAUDE.md, правило 1) — только для картинки.
// Кадр камеры растеризуется в маленькую сетку здесь же и сразу забывается: пиксели не покидают устройство.
import * as THREE from 'three';
import type { FaceFrame } from '../input/types';
import { ACCENT, INK, MONO, SANS } from '../ui/theme';

// Топология face mesh (478 точек): замкнутые контуры век, брови, радужки.
const EYE_LOOPS = [
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
];
const EYE_LIDS = [
  { corners: [33, 133], top: 159, bottom: 145 },
  { corners: [362, 263], top: 386, bottom: 374 },
];
const BROWS = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300];
const IRISES = [
  { center: 468, ring: [469, 470, 471, 472] },
  { center: 473, ring: [474, 475, 476, 477] },
];

const GW = 200; // сетка точек
const GH = 80;
const ASPECT = GH / GW;

const VERT = /* glsl */ `
  attribute float aLum;
  uniform float uSweep;
  uniform float uSize;
  uniform float uFade;
  uniform float uAspect;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Края окна растворяются: овал, а не прямоугольник.
    float edge = smoothstep(1.0, 0.72, abs(position.x)) * smoothstep(uAspect, uAspect * 0.55, abs(position.y));
    float l = pow(clamp(aLum, 0.0, 1.0), 1.25) * mix(0.25, 1.0, edge);
    float sweep = exp(-abs(position.y - uSweep) * 70.0);
    gl_PointSize = uSize * (0.2 + 0.62 * l + 0.25 * sweep) * edge; // полутон: светлое — крупнее, между точками — зазор
    vColor = (mix(vec3(0.035, 0.04, 0.045), vec3(0.9, 0.93, 0.97), l) + vec3(0.12, 0.14, 0.16) * sweep) * uFade;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

export interface EyesMetrics {
  face: boolean; // лицо видно прямо сейчас
  span: number; // расстояние между внешними уголками глаз, доля ширины кадра
  center: { x: number; y: number }; // середина между глазами, доли кадра
}

interface Crop {
  cx: number; // центр, доли кадра
  cy: number;
  w: number; // ширина окна, пикс. видео
  roll: number; // наклон линии глаз, рад
}

export class LidarEyes {
  readonly el: HTMLDivElement;
  metrics: EyesMetrics = { face: false, span: 0, center: { x: 0.5, y: 0.5 } };
  private gl: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  private sample: CanvasRenderingContext2D;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1 / ASPECT, 0.1, 20);
  private group = new THREE.Group();
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private lum = new Float32Array(GW * GH);
  private relief = new Float32Array(GW * GH);
  private crop: Crop | null = null;
  private lastT = -1;
  private lastSeen = -Infinity;
  private lo = 0.1;
  private hi = 0.7;
  private w = 0;
  private h = 0;

  constructor() {
    this.gl = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    for (const c of [this.gl, this.overlay]) c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    this.el = document.createElement('div');
    this.el.style.position = 'relative';
    this.el.append(this.gl, this.overlay);
    this.octx = this.overlay.getContext('2d')!;
    const sc = document.createElement('canvas');
    sc.width = GW;
    sc.height = GH;
    this.sample = sc.getContext('2d', { willReadFrequently: true })!;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.gl, antialias: false, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const pos = new Float32Array(GW * GH * 3);
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const k = j * GW + i;
        pos[k * 3] = (i / (GW - 1)) * 2 - 1;
        pos[k * 3 + 1] = ASPECT - (j / (GH - 1)) * 2 * ASPECT;
      }
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aLum', new THREE.BufferAttribute(this.lum, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uSweep: { value: 0 }, uSize: { value: 4 }, uFade: { value: 1 }, uAspect: { value: ASPECT } },
    });
    const pts = new THREE.Points(this.geo, this.mat);
    pts.frustumCulled = false;
    this.group.add(pts);
    this.scene.add(this.group);
    const dist = 1 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * ASPECT * 1.08;
    this.camera.position.set(0, 0, dist);
    this.camera.lookAt(0, 0, 0);
  }

  /** Размер в CSS-пикс. (высота = ширина × GH/GW). */
  resize(width: number): void {
    this.w = Math.round(width);
    this.h = Math.round(width * ASPECT);
    this.el.style.width = `${this.w}px`;
    this.el.style.height = `${this.h}px`;
    this.renderer.setSize(this.w, this.h, false);
    const dpr = Math.min(devicePixelRatio, 2);
    this.overlay.width = this.w * dpr;
    this.overlay.height = this.h * dpr;
    this.mat.uniforms.uSize.value = (this.w / GW) * 1.15 * this.renderer.getPixelRatio();
  }

  frame(face: FaceFrame | null, video: HTMLVideoElement | null, now: number): void {
    const vw = video?.videoWidth ?? 0;
    const vh = video?.videoHeight ?? 0;
    const fresh = face && face.t !== this.lastT;
    if (face && fresh && vw && vh) {
      this.lastT = face.t;
      this.lastSeen = now;
      this.updateCrop(face.points, vw, vh);
    }
    const seen = now - this.lastSeen < 400;
    this.metrics.face = seen;
    if (video && vw && vh && this.crop) this.rasterize(video, vw, vh);

    const u = this.mat.uniforms;
    u.uSweep.value = ASPECT - (((now / 2600) % 1.2) - 0.1) * 2 * ASPECT;
    u.uFade.value += ((seen ? 1 : 0.25) - u.uFade.value) * 0.08;
    // Лёгкий объём: облако чуть поворачивается за головой и дышит.
    const yaw = this.crop ? (this.metrics.center.x - 0.5) * 0.5 : 0;
    this.group.rotation.set(0.12 * Math.sin(now / 4100), -yaw + 0.1 * Math.sin(now / 3300), 0);
    this.group.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
    this.annotate(face && seen ? face.points : null, vw, vh, now);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.el.remove();
  }

  private updateCrop(p: Float32Array, vw: number, vh: number): void {
    const X = (i: number) => p[i * 3];
    const Y = (i: number) => p[i * 3 + 1];
    const a = X(33) < X(263) ? 33 : 263; // левый в кадре уголок
    const b = a === 33 ? 263 : 33;
    const dx = (X(b) - X(a)) * vw;
    const dy = (Y(b) - Y(a)) * vh;
    const span = Math.hypot(dx, dy);
    let bx = 0;
    let by = 0;
    for (const i of BROWS) {
      bx += X(i);
      by += Y(i);
    }
    bx /= BROWS.length;
    by /= BROWS.length;
    const mx = (X(a) + X(b)) / 2;
    const my = (Y(a) + Y(b)) / 2;
    const next: Crop = { cx: mx * 0.8 + bx * 0.2, cy: my * 0.8 + by * 0.2, w: span * 1.7, roll: Math.atan2(dy, dx) };
    const c = this.crop;
    const k = 0.35; // сглаживание: окно не дрожит вместе с landmarks
    this.crop = c ? { cx: c.cx + (next.cx - c.cx) * k, cy: c.cy + (next.cy - c.cy) * k, w: c.w + (next.w - c.w) * k, roll: c.roll + (next.roll - c.roll) * k } : next;
    this.metrics.span = span / vw;
    this.metrics.center = { x: mx, y: my };
  }

  /** Видео → сетка GW×GH: зеркально (как в зеркале), глаза горизонтально, контраст по окну. */
  private rasterize(video: HTMLVideoElement, vw: number, vh: number): void {
    const c = this.crop!;
    const g = this.sample;
    const s = GW / c.w;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, GW, GH);
    g.translate(GW / 2, GH / 2);
    g.scale(-s, s);
    g.rotate(-c.roll);
    g.translate(-c.cx * vw, -c.cy * vh);
    g.drawImage(video, 0, 0, vw, vh);
    const d = g.getImageData(0, 0, GW, GH).data;
    let lo = 1;
    let hi = 0;
    for (let k = 0; k < GW * GH; k++) {
      const l = (0.2126 * d[k * 4] + 0.7152 * d[k * 4 + 1] + 0.0722 * d[k * 4 + 2]) / 255;
      this.relief[k] = l;
      if (k % 7 === 0) {
        lo = Math.min(lo, l);
        hi = Math.max(hi, l);
      }
    }
    // Растяжка контраста с инерцией: в тёмной комнате глаза всё равно читаются.
    this.lo += (lo - this.lo) * 0.1;
    this.hi += (Math.max(hi, this.lo + 0.08) - this.hi) * 0.1;
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const span = this.hi - this.lo;
    for (let k = 0; k < GW * GH; k++) {
      const l = Math.min(1, Math.max(0, (this.relief[k] - this.lo) / span));
      this.lum[k] = l;
      const x = arr[k * 3];
      arr[k * 3 + 2] = (l - 0.5) * 0.06 - x * x * 0.12; // рельеф по яркости + изгиб лица
    }
    pos.needsUpdate = true;
    (this.geo.getAttribute('aLum') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Landmark (доли кадра) → CSS-пикс. оверлея через то же окно и ту же 3D-проекцию. */
  private project(x: number, y: number, vw: number, vh: number): [number, number] {
    const c = this.crop!;
    const px = (x - c.cx) * vw;
    const py = (y - c.cy) * vh;
    const cr = Math.cos(-c.roll);
    const sr = Math.sin(-c.roll);
    const rx = px * cr - py * sr;
    const ry = px * sr + py * cr;
    const u = -rx / (c.w / 2);
    const v = -ry / (c.w / 2);
    const gx = Math.round(((u + 1) / 2) * (GW - 1));
    const gy = Math.round(((ASPECT - v) / (2 * ASPECT)) * (GH - 1));
    const k = Math.min(GH - 1, Math.max(0, gy)) * GW + Math.min(GW - 1, Math.max(0, gx));
    const z = (this.lum[k] - 0.5) * 0.06 - u * u * 0.12;
    const p = new THREE.Vector3(u, v, z).applyMatrix4(this.group.matrixWorld).project(this.camera);
    return [((p.x + 1) / 2) * this.w, ((1 - p.y) / 2) * this.h];
  }

  private annotate(p: Float32Array | null, vw: number, vh: number, now: number): void {
    const g = this.octx;
    const dpr = this.overlay.width / Math.max(1, this.w);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);

    // Метки кадра.
    g.strokeStyle = INK(0.35);
    g.lineWidth = 1;
    const m = 10;
    const L = 16;
    for (const [x, y, sx, sy] of [[m, m, 1, 1], [this.w - m, m, -1, 1], [this.w - m, this.h - m, -1, -1], [m, this.h - m, 1, -1]]) {
      g.beginPath();
      g.moveTo(x, y + sy * L);
      g.lineTo(x, y);
      g.lineTo(x + sx * L, y);
      g.stroke();
    }
    g.font = `400 10px ${MONO}`;
    g.fillStyle = INK(0.35);
    g.textAlign = 'left';
    g.fillText(`${GW}×${GH} · зеркально`, m + 4, this.h - m - 6);

    if (!p || !this.crop) {
      g.font = `500 11px ${SANS}`;
      g.letterSpacing = '2px';
      g.fillStyle = INK(0.5);
      g.textAlign = 'center';
      g.fillText('ЛИЦО НЕ НАЙДЕНО', this.w / 2, this.h / 2);
      g.letterSpacing = '0px';
      return;
    }
    const X = (i: number) => p[i * 3];
    const Y = (i: number) => p[i * 3 + 1];
    const P = (i: number) => this.project(X(i), Y(i), vw, vh);

    for (const loop of EYE_LOOPS) {
      g.strokeStyle = INK(0.45);
      g.lineWidth = 1;
      g.beginPath();
      loop.forEach((i, n) => {
        const [x, y] = P(i);
        if (n) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.closePath();
      g.stroke();
    }

    for (const iris of IRISES) {
      // Радужка → ближайший глаз: имена Left/Right в MediaPipe не угадываем (CLAUDE.md → Грабли).
      const cx = X(iris.center);
      const cy = Y(iris.center);
      const eye = EYE_LIDS.map((e) => ({ e, d: Math.hypot(cx - (X(e.corners[0]) + X(e.corners[1])) / 2, cy - (Y(e.corners[0]) + Y(e.corners[1])) / 2) })).sort((a, b) => a.d - b.d)[0].e;
      const widthN = Math.hypot((X(eye.corners[0]) - X(eye.corners[1])) * vw, (Y(eye.corners[0]) - Y(eye.corners[1])) * vh);
      const open = Math.hypot((X(eye.top) - X(eye.bottom)) * vw, (Y(eye.top) - Y(eye.bottom)) * vh) / Math.max(widthN, 1e-6);
      const [sx, sy] = P(iris.center);
      const r = iris.ring.reduce((acc, i) => {
        const [x, y] = P(i);
        return acc + Math.hypot(x - sx, y - sy);
      }, 0) / iris.ring.length;
      const shut = open < 0.12;
      if (!shut) {
        g.strokeStyle = ACCENT(0.95);
        g.lineWidth = 1.25;
        g.beginPath();
        g.arc(sx, sy, r, 0, Math.PI * 2);
        g.stroke();
        g.strokeStyle = ACCENT(0.6);
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2 + Math.PI / 4;
          g.beginPath();
          g.moveTo(sx + Math.cos(a) * (r + 4), sy + Math.sin(a) * (r + 4));
          g.lineTo(sx + Math.cos(a) * (r + 10), sy + Math.sin(a) * (r + 10));
          g.stroke();
        }
        g.fillStyle = ACCENT(1);
        g.beginPath();
        g.arc(sx, sy, 1.6, 0, Math.PI * 2);
        g.fill();
      }
      // В зеркальном виде глаз справа — правый глаз игрока (OD), слева — левый (OS).
      const right = sx > this.w / 2;
      const tx = sx + (right ? 1 : -1) * (r + 22);
      this.tag(right ? 'OD' : 'OS', shut ? 'сомкнут' : `раскрытие ${open.toFixed(2)}`, tx, sy - r - 18, right, shut);
    }
    void now;
  }

  /** Подпись глаза на тёмной подложке: читается поверх светлой кожи. */
  private tag(title: string, value: string, x: number, y: number, right: boolean, alert: boolean): void {
    const g = this.octx;
    g.font = `400 10.5px ${MONO}`;
    const w = Math.max(g.measureText(value).width, 24) + 16;
    const x0 = right ? x : x - w;
    g.fillStyle = 'rgba(5,5,5,0.72)';
    g.beginPath();
    g.roundRect(x0, y - 2, w, 34, 5);
    g.fill();
    g.textAlign = 'left';
    g.font = `500 10.5px ${SANS}`;
    g.letterSpacing = '2px';
    g.fillStyle = INK(0.85);
    g.fillText(title, x0 + 8, y + 12);
    g.letterSpacing = '0px';
    g.font = `400 10.5px ${MONO}`;
    g.fillStyle = alert ? ACCENT(0.95) : INK(0.55);
    g.fillText(value, x0 + 8, y + 26);
  }
}

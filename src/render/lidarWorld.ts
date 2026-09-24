// Лидар мира: облака точек комнаты и врагов по снимку последнего импульса (GDD → Лидар).
// Пока глаза закрыты — сам скан (его видят зрители), после открытия — гаснущий послеобраз.
import * as THREE from 'three';
import { config } from '../config';
import { lanePos, ROOM, roomProps, type Box } from '../game/level';
import type { GameState } from '../game/sim';
import { buildMannequin, placeMannequin, type MannequinRig } from './mannequin';

const VERT = /* glsl */ `
  attribute float aDist;
  uniform float uSize;
  varying float vDist;
  void main() {
    vDist = aDist;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize;
  }
`;

const FRAG = /* glsl */ `
  uniform float uRange;
  uniform float uWave;
  uniform float uOpacity;
  uniform vec3 uColor;
  varying float vDist;
  void main() {
    if (vDist > uRange) discard;
    float ring = uWave > 0.0 ? smoothstep(0.8, 0.0, abs(vDist - uWave)) : 0.0;
    float near = 1.0 - clamp(vDist / 16.0, 0.0, 1.0);
    float a = uOpacity * (0.25 + 0.75 * near + ring);
    gl_FragColor = vec4(uColor * (0.5 + 0.5 * near + ring), a);
  }
`;

function material(color: number, size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uSize: { value: size },
      uRange: { value: 0 },
      uWave: { value: 0 },
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(color) },
    },
  });
}

/** Точки на поверхности бокса (локальные координаты центра), равномерно по площади граней. */
function sampleBox(w: number, h: number, d: number, n: number, rnd: () => number, out: number[], m?: THREE.Matrix4): void {
  const faces = [
    [w * h, 'z'],
    [w * d, 'y'],
    [h * d, 'x'],
  ] as const;
  const total = faces.reduce((s, f) => s + f[0], 0);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    let r = rnd() * total;
    const axis = faces.find((f) => (r -= f[0]) < 0)?.[1] ?? 'x';
    const s = rnd() < 0.5 ? -0.5 : 0.5;
    const a = rnd() - 0.5;
    const b = rnd() - 0.5;
    if (axis === 'z') v.set(a * w, b * h, s * d);
    else if (axis === 'y') v.set(a * w, s * h, b * d);
    else v.set(s * w, a * h, b * d);
    if (m) v.applyMatrix4(m);
    out.push(v.x, v.y, v.z);
  }
}

function withDist(positions: number[], eye: THREE.Vector3): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const dist = new Float32Array(positions.length / 3);
  for (let i = 0; i < dist.length; i++) {
    dist[i] = Math.hypot(positions[i * 3] - eye.x, positions[i * 3 + 1] - eye.y, positions[i * 3 + 2] - eye.z);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
  return geo;
}

export class LidarWorld {
  readonly group = new THREE.Group();
  private roomMat = material(0x4fd8ff, 2);
  private enemyMat = material(0xffe2d6, 3);
  private enemies: THREE.Points[] = [];
  private rig: MannequinRig;
  private eye = new THREE.Vector3(0, config.render.eyeHeight, 0);
  private snapshotKey = '';

  constructor() {
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pts: number[] = [];
    const { halfW, depth, height } = ROOM;
    const plane = (n: number, f: (a: number, b: number) => [number, number, number]) => {
      for (let i = 0; i < n; i++) pts.push(...f(rnd(), rnd()));
    };
    plane(2600, (a, b) => [(a - 0.5) * 2 * halfW, 0, -b * depth]); // пол
    plane(900, (a, b) => [(a - 0.5) * 2 * halfW, b * height, -depth]); // дальняя стена
    plane(700, (a, b) => [-halfW, b * height, -a * depth]);
    plane(700, (a, b) => [halfW, b * height, -a * depth]);
    plane(500, (a, b) => [(a - 0.5) * 2 * halfW, height, -b * depth]); // потолок
    const m = new THREE.Matrix4();
    for (const bx of roomProps() as Box[]) {
      m.makeTranslation(bx.x, bx.y, bx.z);
      sampleBox(bx.w, bx.h, bx.d, Math.round(40 * (bx.w * bx.h + bx.h * bx.d) + 40), rnd, pts, m);
    }
    this.group.add(new THREE.Points(withDist(pts, this.eye), this.roomMat));
    this.rig = buildMannequin(new THREE.MeshBasicMaterial());
    this.group.visible = false;
    this.group.renderOrder = 10;
  }

  private rebuildEnemies(g: GameState): void {
    const snap = g.scan.snapshot ?? [];
    const key = snap.map((e) => `${e.lane}${e.dist.toFixed(3)}${e.pose.toFixed(4)}`).join('|');
    if (key === this.snapshotKey) return;
    this.snapshotKey = key;
    for (const p of this.enemies) {
      p.geometry.dispose();
      this.group.remove(p);
    }
    this.enemies = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const e of snap) {
      const pos = lanePos(e.lane, e.dist);
      placeMannequin(this.rig, pos.x, pos.z, e.pose);
      const pts: number[] = [];
      for (const mesh of this.rig.meshes) {
        const p = (mesh.geometry as THREE.BoxGeometry).parameters;
        sampleBox(p.width, p.height, p.depth, 90, rnd, pts, mesh.matrixWorld);
      }
      const points = new THREE.Points(withDist(pts, this.eye), this.enemyMat);
      this.enemies.push(points);
      this.group.add(points);
    }
  }

  /** closedNow — глаза закрыты прямо сейчас (показываем скан для зрителей). */
  update(g: GameState): void {
    const sc = config.game.scan;
    const scanning = g.phase === 'play' && g.scan.active && g.scan.sweeps > 0;
    const after = g.t < g.afterimageUntil;
    this.group.visible = scanning || after;
    if (!this.group.visible) return;
    this.rebuildEnemies(g);

    let opacity = 1;
    let wave = 0;
    if (scanning) {
      const k = Math.min(1, (g.t - g.scan.lastSweepAt) / sc.sweepMs);
      wave = k * g.scan.range;
    } else {
      // Послеобраз держится ярким, гаснет в последней трети: его надо успеть прочитать.
      const k = (g.afterimageUntil - g.t) / sc.afterimageMs;
      opacity = k > 1 / 3 ? 1 : (3 * k) ** 1.5;
    }
    for (const mat of [this.roomMat, this.enemyMat]) {
      mat.uniforms.uRange.value = mat === this.enemyMat ? 1e3 : g.scan.range;
      mat.uniforms.uWave.value = wave;
      mat.uniforms.uOpacity.value = opacity;
    }
  }
}

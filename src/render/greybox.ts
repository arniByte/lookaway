// Грейбокс M1: комната из боксов, три манекена, фонарик. Без стиля (стиль — M5).
import * as THREE from 'three';
import { config } from '../config';
import { gazeToYaw, lanePos, ROOM, roomProps } from '../game/level';
import { isPinned, type GameState } from '../game/sim';
import { LidarWorld } from './lidarWorld';
import { buildMannequin, placeMannequin, type MannequinRig } from './mannequin';

const SPOT_ANGLE = 0.3;
const SPOT_INTENSITY = 30;

export class GreyboxView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private spot: THREE.SpotLight;
  private rigs = new Map<string, MannequinRig>();
  readonly lidar = new LidarWorld();
  private focus = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1); // трекер делит кадр с рендером (CLAUDE.md → Грабли)
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene.background = new THREE.Color(0x000000);
    this.scene.fog = new THREE.FogExp2(0x000000, 0.07);
    // Никакого ambient: вне луча — полная темнота (GDD → Заморозка).

    this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 60);
    this.camera.position.set(0, config.render.eyeHeight, 0);
    this.camera.lookAt(0, config.render.eyeHeight, -1);
    this.scene.add(this.camera);

    this.spot = new THREE.SpotLight(0xfff0d8, SPOT_INTENSITY, 22, SPOT_ANGLE, 0.5, 1.3);
    this.spot.position.set(0.18, -0.25, 0); // в руке, чуть справа и ниже глаз
    this.spot.castShadow = true;
    this.spot.shadow.mapSize.set(1024, 1024);
    this.spot.shadow.bias = -0.0008;
    this.camera.add(this.spot);
    this.scene.add(this.spot.target);

    this.buildRoom();
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9d2c6, roughness: 0.55 });
    for (const lane of ['L', 'C', 'R']) {
      const rig = buildMannequin(skin);
      this.rigs.set(lane, rig);
      this.scene.add(rig.root);
    }
    this.scene.add(this.lidar.group);
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  private buildRoom(): void {
    const wall = new THREE.MeshStandardMaterial({ color: 0x77736b, roughness: 0.95 });
    const floor = new THREE.MeshStandardMaterial({ color: 0x4d4a45, roughness: 0.9 });
    const { halfW, depth, height } = ROOM;
    const plane = (w: number, h: number, mat: THREE.Material, pos: [number, number, number], rot: [number, number, number]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(...pos);
      m.rotation.set(...rot);
      m.receiveShadow = true;
      this.scene.add(m);
    };
    plane(halfW * 2, depth + 2, floor, [0, 0, -depth / 2 + 1], [-Math.PI / 2, 0, 0]);
    plane(halfW * 2, depth + 2, wall, [0, height, -depth / 2 + 1], [Math.PI / 2, 0, 0]);
    plane(halfW * 2, height, wall, [0, height / 2, -depth], [0, 0, 0]);
    plane(depth + 2, height, wall, [-halfW, height / 2, -depth / 2 + 1], [0, Math.PI / 2, 0]);
    plane(depth + 2, height, wall, [halfW, height / 2, -depth / 2 + 1], [0, -Math.PI / 2, 0]);
    for (const b of roomProps()) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), wall);
      m.position.set(b.x, b.y, b.z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
    }
  }

  private resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Горизонтальный FOV постоянный: дорожки остаются в центрах зон при любом соотношении сторон.
    const hf = (config.render.hfovDeg * Math.PI) / 180;
    this.camera.fov = (2 * Math.atan(Math.tan(hf / 2) / this.camera.aspect) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  /**
   * deathMs — сколько прошло с момента смерти (мигание фонаря на убийцу), иначе null.
   * Мигание: вкл/выкл/вкл из config.render.deathFlickerMs, потом темнота.
   */
  render(g: GameState, deathMs: number | null, dtMs: number): void {
    for (const m of g.mannequins) {
      const rig = this.rigs.get(m.lane)!;
      const p = lanePos(m.lane, m.dist);
      placeMannequin(rig, p.x, p.z, m.pose);
    }

    let beamX = g.beam.x;
    let beamY = g.beam.y;
    let on = g.phase === 'play' && g.beam.on;
    if (deathMs !== null && g.killer) {
      const [a, b, c] = config.render.deathFlickerMs;
      on = (deathMs < a) || (deathMs >= a + b && deathMs < a + b + c);
      beamX = g.killer === 'L' ? -config.gaze.calibTarget : g.killer === 'R' ? config.gaze.calibTarget : 0;
      beamY = -0.15;
    }

    // Пригвождён — луч фокусируется: единственный намёк «сейчас можно моргнуть», без HUD.
    const pinned = g.phase === 'play' && g.mannequins.some((m) => isPinned(g, m));
    this.focus += ((pinned ? 1 : 0) - this.focus) * Math.min(1, dtMs / 250);
    this.spot.angle = SPOT_ANGLE * (1 - 0.18 * this.focus);
    this.spot.intensity = on ? SPOT_INTENSITY * (1 + 0.35 * this.focus) : 0;

    const yaw = gazeToYaw(beamX);
    const vf = (this.camera.fov * Math.PI) / 180;
    const pitch = Math.atan(beamY * Math.tan(vf / 2));
    this.spot.target.position.set(Math.sin(yaw) * 10, config.render.eyeHeight + Math.tan(pitch) * 10, -Math.cos(yaw) * 10);

    this.lidar.update(g);
    this.renderer.render(this.scene, this.camera);
  }
}

// LOOK AWAY v2: полевой лидар (GDD v2). Титул → генерация мира → игра.
import * as THREE from 'three';
import { config } from '../config';
import type { EyeState, SourceKind } from '../input/types';
import { Lidar } from '../render/lidar';
import { ScanScene } from '../render/scanScene';
import { Screens } from '../ui/screens';
import { generateWorld, type World } from '../world/worldgen';
import { KeyboardMouse } from './controls';
import { FixedStep } from './loop';
import { colliderGrid, createPlayer, movePlayer, type Player } from './player';
import { chargeScanner, createScanner, tryPulse, type Scanner } from './scanner';

export interface FieldHooks {
  startCamera(): Promise<string | null>;
  startKeyboard(): Promise<void>;
  recenter(): Promise<string | null>;
}

type Phase = 'title' | 'loading' | 'play';

interface Run {
  world: World;
  scan: ScanScene;
  lidar: Lidar;
  player: Player;
  grid: ReturnType<typeof colliderGrid>;
  scanner: Scanner;
  time: number; // игровое время, мс
}

export class FieldApp {
  private renderer: THREE.WebGLRenderer;
  private display = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 300);
  private screens = new Screens();
  private controls: KeyboardMouse;
  private loop = new FixedStep(1000 / config.game.simHz, config.game.maxFrameMs);
  private phase: Phase = 'title';
  private run: Run | null = null;
  private lastNow = 0;
  private busy = false;

  constructor(
    canvas: HTMLCanvasElement,
    private hooks: FieldHooks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.display.background = new THREE.Color(0x000000);
    this.controls = new KeyboardMouse(canvas);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.showTitle();
  }

  private resize(): void {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  private showTitle(message = ''): void {
    this.phase = 'title';
    this.screens.title(
      () => void this.choose('camera'),
      () => void this.choose('keyboard'),
      message,
    );
  }

  private async choose(mode: 'camera' | 'keyboard'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (mode === 'camera') {
        this.screens.text('Запускаю камеру…');
        const err = await this.hooks.startCamera();
        if (err) return this.showTitle(err);
      } else {
        await this.hooks.startKeyboard();
      }
      await this.newRun((Date.now() ^ Math.floor(Math.random() * 2 ** 31)) >>> 0);
    } finally {
      this.busy = false;
    }
  }

  private async newRun(seed: number): Promise<void> {
    this.phase = 'loading';
    this.screens.text(`Генерация мира · seed ${seed}`);
    await new Promise((r) => setTimeout(r, 30)); // дать экрану перерисоваться
    const world = generateWorld(seed);
    const scan = new ScanScene(world);
    if (this.run) {
      this.display.remove(this.run.lidar.group);
      this.run.lidar.clear();
    }
    const lidar = new Lidar(this.renderer, scan);
    this.display.add(lidar.group);
    this.run = { world, scan, lidar, player: createPlayer(world), grid: colliderGrid(world), scanner: createScanner(), time: 0 };
    this.screens.hide();
    this.phase = 'play';
    // Первый импульс сразу: игрок видит, где он.
    this.pulse();
  }

  private pulse(): void {
    const r = this.run!;
    const p = r.player;
    r.lidar.pulse(new THREE.Vector3(p.x, p.y, p.z), r.time, null);
  }

  frame(eye: EyeState, now: number, kind: SourceKind): void {
    const dt = this.lastNow ? now - this.lastNow : 0;
    this.lastNow = now;
    void kind;
    const r = this.run;
    if (this.phase !== 'play' || !r) return;

    this.screens.paused(eye.lost);
    if (!eye.lost) {
      if (eye.events.includes('blinkStart')) r.lidar.blink();
      const input = this.controls.input();
      this.loop.advance(dt, eye.events, (_events, step) => {
        r.time += step;
        movePlayer(r.player, input, step, r.world, r.grid);
        input.turn = 0;
        input.look = 0;
        chargeScanner(r.scanner, step, eye.closed);
      });
      if (this.controls.consumeScan() && tryPulse(r.scanner)) this.pulse();
      if (this.controls.consumeRecenter()) void this.hooks.recenter();
    }

    r.lidar.update(r.time);
    const p = r.player;
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    this.renderer.render(this.display, this.camera);
  }
}

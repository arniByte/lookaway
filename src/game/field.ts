// LOOK AWAY v2: полевой лидар (GDD v2). Титул → генерация → бриф → забег → финал.
// Игра читает только EyeState (CLAUDE.md, правило 1); чистая логика — в game/*, здесь сборка.
import * as THREE from 'three';
import { FieldSfx } from '../audio/fieldSfx';
import { config } from '../config';
import type { EyeState, SourceKind } from '../input/types';
import { PointComposer, type ComposeOptions } from '../render/composer';
import { Lidar, PALETTES } from '../render/lidar';
import { ScanScene } from '../render/scanScene';
import { SpecimenView } from '../render/specimenView';
import { Hud, type HudTarget } from '../ui/hud';
import { Journal, NotePanel, StudyPanel } from '../ui/journal';
import { Screens } from '../ui/screens';
import { dailySeed, makeRng } from '../world/random';
import { buildFigure, POSES } from '../world/meshes';
import { CLADE_RU } from '../world/species';
import { generateWorld, type PlantInstance, type Statue, type World } from '../world/worldgen';
import { eyePulse, HandsFree, KeyboardMouse } from './controls';
import { createDirector, onPulse, onReveal, stepDirector, type Director } from './director';
import { createFauna, hostIndex, stepFauna, type Critter, type FaunaEnv } from './fauna';
import { SpatialGrid } from './grid';
import { FixedStep } from './loop';
import { bearingTo, headingOf, wrapAngle } from './nav';
import { expeditionNotes, type Note } from './notes';
import { colliderGrid, createPlayer, movePlayer, type Player } from './player';
import { advanceStudy, createResearch, observe, startStudy, type Research, type Study } from './research';
import { chargeScanner, createScanner, pulseRange, releasePulse, scanPower, type Scanner } from './scanner';
import { lineBlocked } from './sight';
import { createStalker, distTo, faceTo, hear, scanPose, stepStalker, type Seen, type Stalker, type StalkerMode } from './stalker';

export interface FieldHooks {
  startCamera(): Promise<string | null>;
  startKeyboard(): Promise<void>;
  recenter(): Promise<string | null>;
}

type Phase = 'title' | 'loading' | 'intro' | 'play';

interface Target {
  kind: 'plant' | 'animal' | 'note';
  id: number;
  species: number;
  dist: number;
  pos: THREE.Vector3; // центр для рамки HUD
  radius: number; // м, для размера рамки
}

interface Run {
  seed: number;
  daily: boolean;
  world: World;
  scan: ScanScene;
  lidar: Lidar;
  player: Player;
  grid: ReturnType<typeof colliderGrid>;
  plants: SpatialGrid<PlantInstance>;
  scanner: Scanner;
  fauna: Critter[];
  faunaEnv: FaunaEnv;
  stalker: Stalker;
  director: Director;
  ai: { mode: StalkerMode; desiredDist: number };
  aiRng: () => number;
  notes: Note[];
  hints: { species: number; until: number }[];
  still: { x: number; z: number; ms: number };
  research: Research;
  time: number;
  pendingPulse: { x: number; z: number } | null;
  studyDoneUntil: number;
  lastStudy: Study | null; // только что завершённый (панель «вид описан»)
  ended: { kind: 'dead' | 'extracted'; at: number; shown: boolean } | null;
}

const fmtTime = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const TITLE_SEED = 20_260_924;

export class FieldApp {
  private renderer: THREE.WebGLRenderer;
  private composer = new PointComposer();
  private display = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 300);
  private screens = new Screens();
  private hud = new Hud();
  private journal = new Journal();
  private studyPanel = new StudyPanel();
  private notePanel = new NotePanel();
  private specimen = new SpecimenView();
  private sfx = new FieldSfx();
  private controls: KeyboardMouse;
  private handsFree = new HandsFree();
  private handsFreeOn = false;
  private loop = new FixedStep(1000 / config.game.simHz, config.game.maxFrameMs);
  private phase: Phase = 'title';
  private run: Run | null = null;
  private lastNow = 0;
  private busy = false;
  private withCamera = false;
  private armed = false;
  private blackout = 0;
  private introAt = 0;
  private palette = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private hooks: FieldHooks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x000000, 1);
    this.controls = new KeyboardMouse(canvas);
    this.hud.visible = false;
    addEventListener('resize', () => this.resize());
    addEventListener('keydown', (e) => this.onKey(e));
    // Клик где угодно (бриф — полноэкранный оверлей поверх канваса).
    addEventListener('click', () => {
      if (this.phase === 'intro') this.begin();
    });
    this.resize();
    this.showTitle();
    // ?debug: доступ к забегу из консоли и автотестов (телепорт, состояние). В обычной игре не виден.
    if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __field: this, __cfg: config });
  }

  private resize(): void {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  private onKey(e: KeyboardEvent): void {
    if (this.phase === 'intro' && e.code === 'Enter') this.begin();
    const r = this.run;
    if (this.phase === 'play' && r?.ended?.shown) {
      if (e.code === 'Enter') void this.newRun(this.freshSeed());
      if (e.code === 'KeyR') void this.newRun(r.seed, r.daily);
    }
  }

  private freshSeed(): number {
    return (Date.now() ^ Math.floor(Math.random() * 2 ** 31)) >>> 0;
  }

  private showTitle(message = ''): void {
    this.phase = 'title';
    this.hud.visible = false;
    // Фон титула: он. Медленно поворачивается, голова набок (облако точек с EDL).
    const sc = config.stalker;
    this.specimen.openGeometry(buildFigure(POSES.tilt, { height: 1.78 * sc.heightMul, armMul: sc.armMul, backpack: false, fingers: true }), TITLE_SEED);
    const today = dailySeed();
    this.screens.title({
      onCamera: () => void this.choose('camera'),
      onKeyboard: () => void this.choose('keyboard'),
      onHandsFree: () => void this.choose('handsfree'),
      onDaily: () => void this.choose('camera', today),
      daily: `Мир дня · № ${today}`,
      message,
    });
  }

  private async choose(mode: 'camera' | 'keyboard' | 'handsfree', seed?: number): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.sfx.unlock();
    this.phase = 'loading'; // титул за калибровкой не рисуется
    this.specimen.close();
    try {
      if (mode !== 'keyboard') {
        this.screens.status('Камера', 'Запускаю камеру и модель…', true);
        const err = await this.hooks.startCamera();
        if (err) return this.showTitle(err);
      } else {
        await this.hooks.startKeyboard();
      }
      this.withCamera = mode !== 'keyboard';
      this.handsFreeOn = mode === 'handsfree';
      this.controls.scanButtons = !this.withCamera;
      await this.newRun(seed ?? this.freshSeed(), seed !== undefined);
    } finally {
      this.busy = false;
    }
  }

  private async newRun(seed: number, daily = false): Promise<void> {
    this.phase = 'loading';
    this.hud.visible = false;
    this.journal.close();
    this.studyPanel.hide();
    this.notePanel.hide();
    this.specimen.close();
    this.sfx.silence();
    this.controls.unlock();
    this.screens.paused(false);
    this.screens.status('Генерация мира', `№ ${seed}`, true);
    await new Promise((r) => setTimeout(r, 60)); // дать экрану перерисоваться
    if (this.run) {
      // Каждый забег — новые буферы на GPU: старые освободить, иначе рестарты копят видеопамять.
      this.display.remove(this.run.lidar.group);
      this.run.lidar.dispose();
      this.run.scan.dispose();
    }
    const world = generateWorld(seed);
    const scan = new ScanScene(world);
    const lidar = new Lidar(this.renderer, scan);
    lidar.palette = this.palette;
    this.display.add(lidar.group);
    this.run = {
      seed,
      daily,
      world,
      scan,
      lidar,
      player: createPlayer(world),
      grid: colliderGrid(world),
      plants: new SpatialGrid(4, world.plants),
      scanner: createScanner(),
      fauna: createFauna(world),
      faunaEnv: { time: 0, world, hosts: hostIndex(world), pulse: null, rng: makeRng(seed ^ 0xfa0a) },
      stalker: createStalker(world),
      director: createDirector(),
      ai: { mode: 'dormant', desiredDist: config.director.farDist },
      aiRng: makeRng(seed ^ 0x5a1c),
      notes: expeditionNotes(world),
      hints: [],
      still: { x: world.spawn.x, z: world.spawn.z, ms: 0 },
      research: createResearch(),
      time: 0,
      pendingPulse: null,
      studyDoneUntil: 0,
      lastStudy: null,
      ended: null,
    };
    this.phase = 'intro';
    this.armed = false;
    this.blackout = 0;
    this.introAt = performance.now();
    // Первый снимок — сразу, за брифом: видно, куда попал. Слышно его станет, когда начнётся время.
    this.syncScanScene(this.run);
    const p = this.run.player;
    lidar.pulse(new THREE.Vector3(p.x, p.y, p.z), 0, pulseRange(config.scanner.firstPower, 0), world.height(p.x, p.z));
    this.sfx.pulse(config.scanner.firstPower);
    this.screens.brief({ seed, daily, goal: config.research.documentGoal, camera: this.withCamera, handsFree: this.handsFreeOn });
  }

  private begin(): void {
    const r = this.run;
    if (this.phase !== 'intro' || !r) return;
    this.sfx.unlock();
    this.screens.hide();
    this.hud.visible = true;
    this.phase = 'play';
    this.lastNow = 0;
    void this.canvas.requestPointerLock?.();
    // Облако брифа остаётся свежим; с этого момента импульс слышит силуэт.
    const first = r.lidar.scans[r.lidar.scans.length - 1];
    if (first) first.time = -Math.min(performance.now() - this.introAt, 1500);
    r.scanner.pulses = 1;
    r.scanner.charge = 0;
    hear(r.stalker, r.player.x, r.player.z, config.stalker.hearing);
  }

  private syncScanScene(r: Run): void {
    for (const c of r.fauna) {
      const rig = r.scan.animals.get(c.id);
      if (!rig) continue;
      rig.root.position.set(c.x, c.y, c.z);
      rig.root.rotation.set(0, c.heading, 0);
      const clade = r.world.species[c.species].clade;
      const amp = clade === 'lepidoptera' ? 1.1 : 0.35;
      for (const w of rig.wings) w.pivot.rotation.z = w.side * (0.2 + amp * (0.5 + 0.5 * Math.sin(c.flap)));
      rig.vel.set(c.vx, c.vy, c.vz);
    }
    const s = r.scan.stalker;
    s.root.position.set(r.stalker.x, r.stalker.y, r.stalker.z);
    s.setPose(scanPose(r.stalker, r.player.x, r.player.z));
    s.root.rotation.set(0, r.stalker.heading, 0);
    s.vel.set(r.stalker.vx, 0, r.stalker.vz);
  }

  private pulse(power: number, now: number): void {
    const r = this.run!;
    const p = r.player;
    this.syncScanScene(r);
    const range = pulseRange(power, r.research.documented.size);
    const origin = new THREE.Vector3(p.x, p.y, p.z);
    r.lidar.pulse(origin, r.time, range, r.world.height(p.x, p.z));
    r.pendingPulse = { x: p.x, z: p.z };
    this.sfx.pulse(power);
    // Скан поймал силуэт: в дальности и не за стволом. Близко — удар и передышка, далеко — укол.
    const st = r.stalker;
    const sd = distTo(st, p.x, p.z);
    if (st.awake && sd < range && !lineBlocked(r.grid, p.x, p.z, st.x, st.z)) {
      const close = sd < config.stalker.revealDist;
      this.sfx.sting(close);
      if (close && r.research.documented.size < config.research.documentGoal) onReveal(r.director, r.time);
    }
    hear(st, p.x, p.z, config.stalker.hearing);
    onPulse(r.director);
    // Наблюдения поведения — только то, что попало в скан.
    for (const c of r.fauna) {
      const sp = r.world.species[c.species];
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d > range) continue;
      if (sp.genome.flees && d < config.fauna.fleeRadius) this.note(r, sp.id, 'пугается импульсов лидара', now);
      if (sp.genome.hostPlant !== null && c.mode === 'perch') {
        const host = r.plants.near(c.x, c.z, 1.2).find((pl) => pl.species === sp.genome.hostPlant);
        if (host) this.note(r, sp.id, `кормится на ${r.world.species[host.species].name}`, now);
      }
    }
  }

  private note(r: Run, species: number, text: string, now: number): void {
    if (!observe(r.research, species, text)) return;
    const sp = r.world.species[species];
    if (r.research.documented.has(species)) this.hud.toast('Наблюдение', sp.name, text, now, 4000, true);
  }

  /** Ближайший образец в досягаемости: сначала неописанные виды, потом ближние. */
  private target(r: Run): Target | null {
    const p = r.player;
    let best: Target | null = null;
    // Сначала новое (неописанный вид, непрочитанная запись), потом ближнее.
    const done = (t: Target) => (t.kind === 'note' ? r.research.notesRead.has(t.id) : r.research.documented.has(t.species)) ? 1 : 0;
    const better = (t: Target, b: Target | null) => {
      if (!b) return true;
      return done(t) !== done(b) ? done(t) < done(b) : t.dist < b.dist;
    };
    for (const f of r.world.statues) {
      const d = Math.hypot(f.x - p.x, f.z - p.z);
      if (d < config.expedition.reach) {
        const t: Target = { kind: 'note', id: f.id, species: -1, dist: d, pos: new THREE.Vector3(f.x, f.y + f.height * 0.55, f.z), radius: f.height * 0.55 };
        if (better(t, best)) best = t;
      }
    }
    for (const c of r.fauna) {
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < config.research.reachAnimal && Math.abs(c.y - (p.y - 0.8)) < 2) {
        const size = r.world.species[c.species].genome.size;
        const t: Target = { kind: 'animal', id: c.id, species: c.species, dist: d, pos: new THREE.Vector3(c.x, c.y, c.z), radius: Math.max(0.12, size * 0.8) };
        if (better(t, best)) best = t;
      }
    }
    for (const pl of r.plants.near(p.x, p.z, config.research.reachPlant + 1)) {
      const d = Math.hypot(pl.x - p.x, pl.z - p.z) - pl.collider;
      if (d < config.research.reachPlant) {
        const size = r.world.species[pl.species].genome.size * pl.scale;
        const h = Math.min(size, 2.2) * 0.5; // у дерева — рамка на уровне глаз, не на всю крону
        const t: Target = { kind: 'plant', id: pl.id, species: pl.species, dist: Math.max(0, d), pos: new THREE.Vector3(pl.x, pl.y + h, pl.z), radius: Math.max(0.15, h) };
        if (better(t, best)) best = t;
      }
    }
    return best;
  }

  private nearBeacon(r: Run): boolean {
    const p = r.player;
    return Math.hypot(p.x - r.world.beacon.x, p.z - r.world.beacon.z) < config.research.extractRadius;
  }

  private canExtract(r: Run): boolean {
    return this.nearBeacon(r) && r.research.documented.size >= config.research.documentGoal;
  }

  /**
   * Смотрит ли игрок на силуэт: глаза закрыты или он за стволом — нет; в конусе обзора — «на виду»
   * (крадётся); взгляд (без камеры — центр экрана) в пределах gazeHoldAngle — «в упор» (стоит).
   */
  private seenStalker(r: Run, eye: EyeState): Seen {
    const st = r.stalker;
    if (eye.blink || eye.closed || eye.lost) return 'none';
    const p = r.player;
    if (lineBlocked(r.grid, p.x, p.z, st.x, st.z)) return 'none';
    const toS = new THREE.Vector3(st.x, st.y + 1.5, st.z).sub(this.camera.position);
    const horiz = Math.abs(wrapAngle(Math.atan2(toS.x, -toS.z) - headingOf(p.yaw)));
    if (horiz > config.stalker.viewHalfAngle) return 'none';
    const g = this.withCamera ? eye.gaze : { x: 0, y: 0 };
    const ray = new THREE.Vector3(g.x, g.y, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    return ray.angleTo(toS.normalize()) < config.stalker.gazeHoldAngle ? 'gaze' : 'view';
  }

  /** Он дотянулся: последний скан — он прямо перед тобой, тянет руку. */
  private caught(r: Run, now: number): void {
    const p = r.player;
    const st = r.stalker;
    st.x = p.x - Math.sin(p.yaw) * 0.95;
    st.z = p.z - Math.cos(p.yaw) * 0.95;
    st.y = r.world.height(st.x, st.z);
    st.vx = st.vz = 0;
    st.mode = 'hunt';
    st.heading = faceTo(st, p.x, p.z);
    this.syncScanScene(r);
    this.blackout = 0;
    r.lidar.pulse(new THREE.Vector3(p.x, p.y, p.z), r.time, 14, r.world.height(p.x, p.z));
    this.end(r, 'dead', now);
  }

  /** Прочитать запись экспедиции: текст, звук бумаги, подсказка на компас. */
  private readNote(r: Run, statue: Statue): void {
    const n = r.notes.find((x) => x.statue === statue.id);
    if (!n) return;
    r.research.notesRead.add(statue.id);
    this.notePanel.show(n.text, statue.id + 1, r.world.statues.length, n.hint !== null ? r.world.species[n.hint].name : null);
    this.sfx.note();
    if (n.hint !== null && !r.research.documented.has(n.hint)) r.hints.push({ species: n.hint, until: r.time + config.expedition.hintMs });
  }

  /** Метки подсказок на компасе: ближайший экземпляр вида. */
  private hintMarkers(r: Run): { bearing: number; dist: number; label: string }[] {
    const p = r.player;
    r.hints = r.hints.filter((h) => h.until > r.time && !r.research.documented.has(h.species));
    return r.hints.flatMap((h) => {
      const pts: { x: number; z: number }[] = r.world.species[h.species].kingdom === 'plant' ? r.world.plants.filter((pl) => pl.species === h.species) : r.fauna.filter((c) => c.species === h.species);
      let best: { x: number; z: number } | null = null;
      let bd = Infinity;
      for (const q of pts) {
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
      return best ? [{ bearing: bearingTo(best.x - p.x, best.z - p.z), dist: bd, label: 'образец' }] : [];
    });
  }

  /** Мировая точка → CSS-пикс. и масштаб (пикс. на метр на этой дистанции); null — за спиной. */
  private toScreen(pos: THREE.Vector3): { x: number; y: number; ppm: number } | null {
    const v = pos.clone().project(this.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) return null;
    const dist = pos.distanceTo(this.camera.position);
    const ppm = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / Math.max(dist, 0.1);
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight, ppm };
  }

  private end(r: Run, kind: 'dead' | 'extracted', now: number): void {
    r.ended = { kind, at: now, shown: false };
    r.research.study = null;
    this.specimen.close();
    this.studyPanel.hide();
    this.notePanel.hide();
    this.sfx.silence();
    if (kind === 'dead') this.sfx.death();
    else this.sfx.chime();
  }

  private showEnd(r: Run): void {
    const e = r.ended!;
    e.shown = true;
    this.controls.unlock();
    this.hud.visible = false;
    this.screens.paused(false);
    const docs = r.world.species.filter((s) => r.research.documented.has(s.id));
    this.screens.end({
      dead: e.kind === 'dead',
      time: fmtTime(r.time),
      documented: docs.map((s) => ({ name: s.name, ru: s.ru })),
      total: r.world.species.length,
      pulses: r.scanner.pulses,
      seed: r.seed,
      camera: this.withCamera,
      onNew: () => void this.newRun(this.freshSeed()),
      onSame: () => void this.newRun(r.seed, r.daily),
    });
  }

  private hudTarget(r: Run): HudTarget | null {
    const docN = r.research.documented.size;
    const goal = config.research.documentGoal;
    const b = r.world.beacon;
    const beaconNear = Math.hypot(r.player.x - b.x, r.player.z - b.z) < config.research.extractRadius + 3;
    const dwell = this.handsFreeOn ? this.handsFree.dwellProgress : 0;
    const act = (text: string) => (this.handsFreeOn ? { key: null, text: `задержи взгляд — ${text}` } : { key: 'E', text });
    const t = this.target(r);
    if (beaconNear && (docN >= goal || !t)) {
      const s = this.toScreen(new THREE.Vector3(b.x, b.y + 1.6, b.z));
      if (!s) return null;
      const ready = docN >= goal;
      return {
        x: s.x,
        y: s.y,
        half: 1.1 * s.ppm,
        title: 'Маяк',
        latin: false,
        sub: ready ? 'данных достаточно' : `нужно ещё видов: ${goal - docN}`,
        action: ready && this.nearBeacon(r) ? act('эвакуация') : null,
        tone: 'beacon',
        dwell: ready ? dwell : 0,
      };
    }
    if (!t) return null;
    const s = this.toScreen(t.pos);
    if (!s) return null;
    if (t.kind === 'note') {
      const read = r.research.notesRead.has(t.id);
      return {
        x: s.x,
        y: s.y,
        half: t.radius * s.ppm,
        title: 'Участник экспедиции',
        latin: false,
        sub: read ? 'запись прочитана' : 'у ног — полевой журнал',
        action: read ? null : act('прочитать запись'),
        tone: read ? 'known' : 'beacon',
        dwell: read ? 0 : dwell,
      };
    }
    const sp = r.world.species[t.species];
    const known = r.research.documented.has(t.species);
    return {
      x: s.x,
      y: s.y,
      half: t.radius * s.ppm,
      title: known ? sp.name : 'Неизвестный вид',
      latin: known,
      sub: known ? `${sp.ru} · в журнале` : `${CLADE_RU[sp.clade]} · ${t.dist.toFixed(1)} м`,
      action: known ? null : act('взять образец'),
      tone: known ? 'known' : 'unknown',
      dwell: known ? 0 : dwell,
    };
  }

  frame(eye: EyeState, now: number, kind: SourceKind): void {
    const dt = this.lastNow ? now - this.lastNow : 0;
    this.lastNow = now;
    void kind;
    const r = this.run;

    if (this.phase === 'title' && this.specimen.active) {
      this.specimen.update(1, dt, now, 0, 0.6);
      this.specimen.prepare(this.renderer, 0.2);
      this.composer.render(this.renderer, this.specimen.scene, this.specimen.camera, { strength: 0.9, time: now });
      return;
    }

    // Старт и рестарт глазами: закрыть и открыть.
    if (this.withCamera && (this.phase === 'intro' || r?.ended?.shown)) {
      if (eye.events.includes('closeStart')) this.armed = true;
      if (this.armed && eye.events.includes('closeEnd')) {
        this.armed = false;
        if (this.phase === 'intro') this.begin();
        else if (r) void this.newRun(this.freshSeed());
        return;
      }
    }
    if (!r) return;
    if (this.phase === 'intro') {
      this.placeCamera(r.player);
      // Облако за брифом не растворяется, сколько ни читай.
      r.lidar.update(Math.min(performance.now() - this.introAt, config.lidar.persistMs * config.lidar.fadeFrom * 0.8), this.camera);
      this.composer.render(this.renderer, this.display, this.camera, this.look(now, 0.55));
      return;
    }
    if (this.phase !== 'play') return;

    if (r.ended) {
      if (!r.ended.shown && now - r.ended.at > 1400) this.showEnd(r);
      r.lidar.update(r.time + (now - r.ended.at), this.camera);
      this.composer.render(this.renderer, this.display, this.camera, this.look(now, r.ended.kind === 'dead' ? 0.5 : 0.8));
      return;
    }

    if (this.controls.consumeJournal()) {
      this.journal.toggle(r.research, r.world.species, r.seed, r.notes.map((n) => n.text));
      this.hud.visible = !this.journal.open;
      if (this.journal.open) {
        this.controls.unlock();
        r.studyDoneUntil = 0;
      }
    }
    if (this.controls.consumePalette()) {
      this.palette = (this.palette + 1) % PALETTES.length;
      r.lidar.palette = this.palette;
      this.hud.toast('Палитра', PALETTES[this.palette], '', now, 1800);
    }
    const paused = eye.lost || this.journal.open;
    this.screens.paused(eye.lost);

    let drag = 0;
    let charging = false;
    if (!paused) {
      const blink = eye.events.includes('blinkStart');
      if (blink) r.lidar.blink();
      const input = this.controls.input();
      let hfInteract = false;
      if (this.handsFreeOn) {
        // Во время детального скана взгляд и так в центре — задержка взгляда его не прерывает.
        const hf = this.handsFree.update(eye, dt, !r.research.study && !!(this.target(r) || this.canExtract(r)));
        input.forward = Math.max(-1, Math.min(1, input.forward + hf.input.forward));
        input.turn += hf.input.turn;
        input.look += hf.input.look;
        hfInteract = hf.interact;
      }
      if (r.research.study) {
        drag = input.turn;
        input.forward = input.strafe = input.turn = input.look = 0;
      }
      // Импульс: глаза закрыты (или кнопка без камеры) — копим; открылись — выпуск.
      const ep = eyePulse(eye);
      const blind = ep.charging || this.controls.scanHeld;
      charging = blind && !r.research.study;
      const release = (ep.release || this.controls.consumeScanRelease()) && !r.research.study;
      const interact = this.controls.consumeInteract() || hfInteract;
      if (this.controls.consumeRecenter() && this.withCamera) void this.hooks.recenter();
      const seen = this.seenStalker(r, eye);
      const st = r.stalker;

      let firstStep = true;
      this.loop.advance(dt, eye.events, (_events, step) => {
        if (r.ended) return;
        r.time += step;
        if (movePlayer(r.player, input, step, r.world, r.grid)) this.sfx.footstep(input.run);
        input.turn = 0;
        input.look = 0;
        chargeScanner(r.scanner, step, charging);
        r.faunaEnv.time = r.time;
        r.faunaEnv.pulse = r.pendingPulse;
        stepFauna(r.fauna, step, r.faunaEnv);
        r.faunaEnv.pulse = null;
        r.pendingPulse = null;
        // Директор решает, что делать силуэту; силуэт делает, если на него не смотрят.
        const pl = r.player;
        if (Math.hypot(pl.x - r.still.x, pl.z - r.still.z) > 1.5) r.still = { x: pl.x, z: pl.z, ms: 0 };
        else r.still.ms += step;
        if (input.run && pl.speed > config.player.walk + 0.5) hear(st, pl.x, pl.z, config.stalker.hearRun);
        const docs = r.research.documented.size;
        r.ai = stepDirector(r.director, {
          time: r.time,
          dtMs: step,
          awake: st.awake,
          stalkerDist: distTo(st, pl.x, pl.z),
          documented: docs,
          extractReady: docs >= config.research.documentGoal,
          studying: !!r.research.study,
          eyesClosed: blind,
          stillMs: r.still.ms,
        });
        const act = stepStalker(st, step, { time: r.time, player: pl, eyesClosed: blind, blinkStart: blink && firstStep, seen, mode: r.ai.mode, desiredDist: r.ai.desiredDist }, r.world, r.grid, r.aiRng);
        firstStep = false;
        if (act === 'kill') return this.caught(r, now);
        if (act === 'step') this.sfx.stalkerStep(new THREE.Vector3(st.x, st.y, st.z));
        const studied = r.research.study;
        const done = advanceStudy(r.research, step, r.time);
        if (done !== null) {
          const sp = r.world.species[done];
          r.lidar.unknown[done] = 0;
          r.studyDoneUntil = r.time + 1800;
          r.lastStudy = studied ? { ...studied, progress: 1 } : null;
          this.hud.toast('Новый вид', sp.name, `${sp.ru} · дальность сканера +${config.scanner.rangePerSpecies} м`, now, 5000, true);
          this.sfx.chime();
          if (r.research.documented.size === config.research.documentGoal) this.hud.toast('Достаточно данных', 'Возвращайся к маяку', '', now + 1, 6000);
        }
      });
      if (r.ended) return;

      if (release) {
        const power = releasePulse(r.scanner);
        if (power !== null) {
          this.pulse(power, now);
          this.blackout = 0; // открыл глаза — скан виден сразу
        } else {
          this.sfx.denied();
        }
      } else if (!charging) {
        r.scanner.hold = 0;
      }

      if (interact) {
        if (this.notePanel.open) {
          this.notePanel.hide();
        } else if (r.research.study) {
          r.research.study = null;
          this.specimen.close();
        } else if (this.canExtract(r)) {
          this.end(r, 'extracted', now);
          return;
        } else {
          const t = this.target(r);
          if (t?.kind === 'note') {
            if (!r.research.notesRead.has(t.id)) this.readNote(r, r.world.statues[t.id]);
          } else if (t && !r.research.documented.has(t.species)) {
            startStudy(r.research, t.species, { kind: t.kind, id: t.id });
            this.specimen.open(r.world.species[t.species], r.seed * 13 + t.species);
          }
        }
      }
    }

    // Темнота: глаза закрыты — экран гаснет. Без камеры видно и моргание (с камерой его не увидеть).
    const dark = paused ? 0 : charging ? 1 : !this.withCamera && eye.blink ? 0.85 : 0;
    this.blackout += (dark - this.blackout) * Math.min(1, dt / (dark > this.blackout ? 60 : 90));

    // Камера и отрисовка.
    const p = r.player;
    this.placeCamera(p);
    const studying = r.research.study;
    r.lidar.dim = studying ? 0.28 : 1;
    r.lidar.update(r.time, this.camera);
    this.composer.render(this.renderer, this.display, this.camera, this.look(now, 1 - this.blackout));
    let specimenOn = false;
    if (studying) {
      this.specimen.update(studying.progress, dt, r.time, drag);
      this.studyPanel.show(studying, r.world.species[studying.species], false);
      specimenOn = true;
    } else if (r.time < r.studyDoneUntil && this.specimen.active && !this.journal.open && r.lastStudy) {
      this.specimen.update(1, dt, r.time, 0);
      this.studyPanel.show(r.lastStudy, r.world.species[r.lastStudy.species], true);
      specimenOn = true;
    } else {
      if (this.specimen.active) this.specimen.close();
      this.studyPanel.hide();
    }
    if (specimenOn) {
      this.specimen.prepare(this.renderer, -0.08);
      this.composer.render(this.renderer, this.specimen.scene, this.specimen.camera, { overlay: true, strength: 0.9 });
    }

    // HUD.
    const docN = r.research.documented.size;
    const st = r.stalker;
    const sd = distTo(st, p.x, p.z);
    const power = scanPower(r.scanner);
    const bx = r.world.beacon.x - p.x;
    const bz = r.world.beacon.z - p.z;
    this.hud.draw(
      {
        heading: headingOf(p.yaw),
        beacon: { bearing: bearingTo(bx, bz), dist: Math.hypot(bx, bz) },
        extractReady: docN >= config.research.documentGoal,
        documented: docN,
        goal: config.research.documentGoal,
        total: r.world.species.length,
        palette: PALETTES[this.palette],
        charge: r.scanner.charge,
        power,
        charging,
        range: pulseRange(power, docN),
        hint: r.scanner.pulses < 4 ? (this.withCamera ? 'закрой глаза — копить импульс, открой — скан' : 'удерживай ЛКМ, F или C — копить импульс') : '',
        blackout: this.blackout,
        target: studying || this.journal.open || paused ? null : this.hudTarget(r),
        markers: this.hintMarkers(r),
        danger: st.awake ? Math.max(0, 1 - sd / 7) : 0,
      },
      now,
    );

    // Звук.
    this.sfx.listen(this.camera);
    // Лес затихает рядом с ним; сердце — от близости и напряжения.
    const tension = r.director.tension;
    this.sfx.ambient({
      tension,
      hush: st.awake ? Math.min(1, Math.max(0, 1 - (sd - 6) / 16)) : 0,
      heart: Math.max(st.awake ? Math.max(0, 1 - sd / 18) : 0, (tension - 0.55) * 1.6),
      eyesClosed: charging,
      paused,
    });
    this.sfx.charge(charging && r.scanner.charge >= 1 && !paused, power);
    this.sfx.stalkerBreath(new THREE.Vector3(st.x, st.y, st.z), sd, st.awake && !paused);
    const near = r.fauna
      .filter((c) => c.mode !== 'perch' && r.world.species[c.species].clade !== 'coleoptera')
      .map((c) => ({ c, d: Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) }))
      .filter((x) => x.d < 8)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map(({ c }) => ({ id: c.id, pos: new THREE.Vector3(c.x, c.y, c.z), hz: r.world.species[c.species].clade === 'odonata' ? 170 : 55 }));
    this.sfx.insects(paused ? [] : near);
    this.sfx.study(!!studying && !paused, studying?.progress ?? 0);
  }

  private placeCamera(p: Player): void {
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
  }

  private look(now: number, exposure: number): ComposeOptions {
    const lc = config.lidar;
    return { exposure, strength: lc.edlStrength, radius: lc.edlRadius, floor: lc.edlFloor, time: now };
  }
}

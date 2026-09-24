// LOOK AWAY v2: полевой лидар (GDD v2). Титул → генерация → вступление → забег → финал.
// Игра читает только EyeState (CLAUDE.md, правило 1); чистая логика — в game/*, здесь сборка.
import * as THREE from 'three';
import { FieldSfx } from '../audio/fieldSfx';
import { config } from '../config';
import type { EyeState, SourceKind } from '../input/types';
import { Lidar } from '../render/lidar';
import { ScanScene } from '../render/scanScene';
import { SpecimenView } from '../render/specimenView';
import { Hud } from '../ui/hud';
import { Journal, StudyPanel } from '../ui/journal';
import { Screens } from '../ui/screens';
import { makeRng } from '../world/random';
import { CLADE_RU } from '../world/species';
import { generateWorld, type PlantInstance, type World } from '../world/worldgen';
import { HandsFree, KeyboardMouse } from './controls';
import { createDark, distTo, hearPulse, stepDark, type DarkMatter } from './darkMatter';
import { createFauna, hostIndex, stepFauna, type Critter, type FaunaEnv } from './fauna';
import { SpatialGrid } from './grid';
import { FixedStep } from './loop';
import { colliderGrid, createPlayer, movePlayer, type Player } from './player';
import { advanceStudy, createResearch, observe, startStudy, type Research, type Study } from './research';
import { chargeScanner, createScanner, tryPulse, type Scanner } from './scanner';

export interface FieldHooks {
  startCamera(): Promise<string | null>;
  startKeyboard(): Promise<void>;
  recenter(): Promise<string | null>;
}

type Phase = 'title' | 'loading' | 'intro' | 'play';

interface Target {
  kind: 'plant' | 'animal';
  id: number;
  species: number;
  dist: number;
}

interface Run {
  seed: number;
  world: World;
  scan: ScanScene;
  lidar: Lidar;
  player: Player;
  grid: ReturnType<typeof colliderGrid>;
  plants: SpatialGrid<PlantInstance>;
  scanner: Scanner;
  fauna: Critter[];
  faunaEnv: FaunaEnv;
  dark: DarkMatter;
  research: Research;
  time: number;
  pendingPulse: { x: number; z: number } | null;
  studyDoneUntil: number;
  lastStudy: Study | null; // только что завершённый (панель «вид описан»)
  ended: { kind: 'dead' | 'extracted'; at: number; shown: boolean } | null;
}

const fmtTime = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export class FieldApp {
  private renderer: THREE.WebGLRenderer;
  private display = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 300);
  private screens = new Screens();
  private hud = new Hud();
  private journal = new Journal();
  private studyPanel = new StudyPanel();
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

  constructor(
    private canvas: HTMLCanvasElement,
    private hooks: FieldHooks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.display.background = new THREE.Color(0x000000);
    this.controls = new KeyboardMouse(canvas);
    this.hud.visible = false;
    addEventListener('resize', () => this.resize());
    addEventListener('keydown', (e) => this.onKey(e));
    // Клик где угодно (вступление — полноэкранный оверлей поверх канваса).
    addEventListener('click', () => {
      if (this.phase === 'intro') this.begin();
    });
    this.resize();
    this.showTitle();
    // ?debug: доступ к забегу из консоли и автотестов (телепорт, состояние). В обычной игре не виден.
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __field: FieldApp }).__field = this;
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
      if (e.code === 'KeyR') void this.newRun(r.seed);
    }
  }

  private freshSeed(): number {
    return (Date.now() ^ Math.floor(Math.random() * 2 ** 31)) >>> 0;
  }

  private showTitle(message = ''): void {
    this.phase = 'title';
    this.hud.visible = false;
    this.screens.title(
      () => void this.choose('camera'),
      () => void this.choose('keyboard'),
      message,
      () => void this.choose('handsfree'),
    );
  }

  private async choose(mode: 'camera' | 'keyboard' | 'handsfree'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.sfx.unlock();
    try {
      if (mode !== 'keyboard') {
        this.screens.text('Запускаю камеру…');
        const err = await this.hooks.startCamera();
        if (err) return this.showTitle(err);
      } else {
        await this.hooks.startKeyboard();
      }
      this.withCamera = mode !== 'keyboard';
      this.handsFreeOn = mode === 'handsfree';
      await this.newRun(this.freshSeed());
    } finally {
      this.busy = false;
    }
  }

  private async newRun(seed: number): Promise<void> {
    this.phase = 'loading';
    this.hud.visible = false;
    this.journal.close();
    this.studyPanel.hide();
    this.specimen.close();
    this.sfx.silence();
    this.controls.unlock();
    this.screens.text(`Генерация мира · seed ${seed}`);
    await new Promise((r) => setTimeout(r, 30)); // дать экрану перерисоваться
    if (this.run) {
      this.display.remove(this.run.lidar.group);
      this.run.lidar.clear();
    }
    const world = generateWorld(seed);
    const scan = new ScanScene(world);
    const lidar = new Lidar(this.renderer, scan);
    this.display.add(lidar.group);
    this.run = {
      seed,
      world,
      scan,
      lidar,
      player: createPlayer(world),
      grid: colliderGrid(world),
      plants: new SpatialGrid(4, world.plants),
      scanner: createScanner(),
      fauna: createFauna(world),
      faunaEnv: { time: 0, world, hosts: hostIndex(world), pulse: null, rng: makeRng(seed ^ 0xfa0a) },
      dark: createDark(world),
      research: createResearch(),
      time: 0,
      pendingPulse: null,
      studyDoneUntil: 0,
      lastStudy: null,
      ended: null,
    };
    this.phase = 'intro';
    this.armed = false;
    const goal = config.research.documentGoal;
    this.screens.text(
      `Полевая станция · мир ${seed}\n\n` +
        'Долина без света. Ты видишь только то, что отсканировал.\n' +
        'Облако держится, пока не моргаешь: каждое моргание стирает его часть.\n' +
        'Тёплые точки — живое, ещё не описанное. Подойди, возьми образец, дождись детального скана.\n' +
        'Импульс слышит чёрная материя. В скане она — дыра, вокруг которой гнётся пространство.\n' +
        'Посмотри на неё — она замрёт. Ненадолго.\n\n' +
        `Опиши ${goal} видов и вернись к маяку.\n\n` +
        (this.handsFreeOn
          ? 'HANDS-FREE: держи глаза закрытыми — идёшь вперёд вслепую · открыл — импульс\n' +
            'взгляд у края экрана — поворот · задержи взгляд в центре — образец / эвакуация\n'
          : '') +
        'WASD — идти · Shift — бежать · мышь или ←→ — обзор · ЛКМ или F — импульс\n' +
        'E — образец / эвакуация · Tab — журнал' +
        (this.withCamera ? ' · R — перецентровать взгляд' : '\nбез камеры: Space — моргнуть, держать C — закрыть глаза; глаза моргают и сами') +
        '\n\nКлик — начать' +
        (this.withCamera ? ' (или закрой и открой глаза)' : ''),
    );
  }

  private begin(): void {
    if (this.phase !== 'intro' || !this.run) return;
    this.sfx.unlock();
    this.screens.hide();
    this.hud.visible = true;
    this.phase = 'play';
    this.lastNow = 0;
    void this.canvas.requestPointerLock?.();
    this.pulse(); // первый импульс сразу: видно, где ты — и тебя слышно
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
    r.scan.dark.position.set(r.dark.x, r.dark.y, r.dark.z);
  }

  private pulse(): void {
    const r = this.run!;
    const p = r.player;
    this.syncScanScene(r);
    const origin = new THREE.Vector3(p.x, p.y, p.z);
    const dark = new THREE.Vector3(r.dark.x, r.dark.y, r.dark.z);
    r.lidar.pulse(origin, r.time, dark.distanceTo(origin) < config.lidar.range + 5 ? dark : null);
    r.pendingPulse = { x: p.x, z: p.z };
    hearPulse(r.dark, p.x, p.z);
    this.sfx.pulse();
    // Наблюдение поведения: пугливые рядом разлетаются — это видно в скане.
    for (const c of r.fauna) {
      const sp = r.world.species[c.species];
      if (sp.genome.flees && Math.hypot(c.x - p.x, c.z - p.z) < config.fauna.fleeRadius) observe(r.research, sp.id, 'пугается импульсов лидара');
    }
  }

  /** Ближайший образец в досягаемости: сначала неописанные виды, потом ближние. */
  private target(r: Run): Target | null {
    const p = r.player;
    let best: Target | null = null;
    const better = (t: Target, b: Target | null) => {
      if (!b) return true;
      const ua = r.research.documented.has(t.species) ? 1 : 0;
      const ub = r.research.documented.has(b.species) ? 1 : 0;
      return ua !== ub ? ua < ub : t.dist < b.dist;
    };
    for (const c of r.fauna) {
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < config.research.reachAnimal && Math.abs(c.y - (p.y - 0.8)) < 2) {
        const t: Target = { kind: 'animal', id: c.id, species: c.species, dist: d };
        if (better(t, best)) best = t;
      }
    }
    for (const pl of r.plants.near(p.x, p.z, config.research.reachPlant + 1)) {
      const d = Math.hypot(pl.x - p.x, pl.z - p.z) - pl.collider;
      if (d < config.research.reachPlant) {
        const t: Target = { kind: 'plant', id: pl.id, species: pl.species, dist: Math.max(0, d) };
        if (better(t, best)) best = t;
      }
    }
    return best;
  }

  private canExtract(r: Run): boolean {
    const p = r.player;
    return (
      Math.hypot(p.x - r.world.beacon.x, p.z - r.world.beacon.z) < config.research.extractRadius &&
      r.research.documented.size >= config.research.documentGoal
    );
  }

  private gazeOnDark(r: Run, eye: EyeState): boolean {
    if (!r.dark.awake || eye.blink || eye.closed || eye.lost) return false;
    const dpos = new THREE.Vector3(r.dark.x, r.dark.y, r.dark.z);
    if (dpos.distanceTo(this.camera.position) > 40) return false;
    const g = this.withCamera ? eye.gaze : { x: 0, y: 0 };
    const ray = new THREE.Vector3(g.x, g.y, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const toDark = dpos.sub(this.camera.position).normalize();
    return ray.angleTo(toDark) < config.dark.gazeHoldAngle;
  }

  private end(r: Run, kind: 'dead' | 'extracted', now: number): void {
    r.ended = { kind, at: now, shown: false };
    r.research.study = null;
    this.specimen.close();
    this.studyPanel.hide();
    this.sfx.silence();
    if (kind === 'dead') this.sfx.death();
    else this.sfx.chime();
  }

  private showEnd(r: Run): void {
    const e = r.ended!;
    e.shown = true;
    this.controls.unlock();
    this.hud.visible = false;
    const docs = r.world.species.filter((s) => r.research.documented.has(s.id));
    this.screens.text(
      (e.kind === 'dead' ? 'Чёрная материя.\n\n' : 'Эвакуация.\n\n') +
        `${fmtTime(r.time)} · описано ${docs.length} из ${r.world.species.length} · импульсов ${r.scanner.pulses} · мир ${r.seed}\n\n` +
        docs.map((s) => `${s.name} — ${s.ru}`).join('\n') +
        '\n\nEnter — новый мир · R — этот же мир' +
        (this.withCamera ? ' · или закрой и открой глаза' : ''),
    );
  }

  frame(eye: EyeState, now: number, kind: SourceKind): void {
    const dt = this.lastNow ? now - this.lastNow : 0;
    this.lastNow = now;
    void kind;
    const r = this.run;

    // Hands-free старт и рестарт: закрыть и открыть глаза.
    if (this.withCamera && (this.phase === 'intro' || r?.ended?.shown)) {
      if (eye.events.includes('closeStart')) this.armed = true;
      if (this.armed && eye.events.includes('closeEnd')) {
        this.armed = false;
        if (this.phase === 'intro') this.begin();
        else if (r) void this.newRun(this.freshSeed());
        return;
      }
    }
    if (this.phase !== 'play' || !r) return;

    if (r.ended) {
      if (!r.ended.shown && now - r.ended.at > 1400) this.showEnd(r);
      r.lidar.update(r.time + (now - r.ended.at));
      this.renderer.render(this.display, this.camera);
      return;
    }

    if (this.controls.consumeJournal()) {
      this.journal.toggle(r.research, r.world.species, r.seed);
      if (this.journal.open) {
        this.controls.unlock();
        r.studyDoneUntil = 0;
      }
    }
    const paused = eye.lost || this.journal.open;
    this.screens.paused(eye.lost);

    let gazeOn = false;
    let drag = 0;
    if (!paused) {
      const blink = eye.events.includes('blinkStart');
      if (blink) r.lidar.blink();
      const input = this.controls.input();
      let hfScan = false;
      let hfInteract = false;
      if (this.handsFreeOn) {
        // Во время детального скана взгляд и так в центре — задержка взгляда его не прерывает.
        const hf = this.handsFree.update(eye, dt, !r.research.study && !!(this.target(r) || this.canExtract(r)));
        input.forward = Math.max(-1, Math.min(1, input.forward + hf.input.forward));
        input.turn += hf.input.turn;
        input.look += hf.input.look;
        hfScan = hf.scan;
        hfInteract = hf.interact;
      }
      if (r.research.study) {
        drag = input.turn;
        input.forward = input.strafe = input.turn = input.look = 0;
      }
      const scanReq = this.controls.consumeScan() || hfScan;
      const interact = this.controls.consumeInteract() || hfInteract;
      if (this.controls.consumeRecenter() && this.withCamera) void this.hooks.recenter();
      gazeOn = this.gazeOnDark(r, eye);

      let firstStep = true;
      this.loop.advance(dt, eye.events, (_events, step) => {
        if (r.ended) return;
        r.time += step;
        if (movePlayer(r.player, input, step, r.world, r.grid)) this.sfx.footstep(input.run);
        input.turn = 0;
        input.look = 0;
        chargeScanner(r.scanner, step, eye.closed);
        r.faunaEnv.time = r.time;
        r.faunaEnv.pulse = r.pendingPulse;
        stepFauna(r.fauna, step, r.faunaEnv);
        r.faunaEnv.pulse = null;
        r.pendingPulse = null;
        const hit = stepDark(r.dark, step, { player: r.player, eyesClosed: eye.closed, blinkStart: blink && firstStep, gazeOn }, r.world);
        firstStep = false;
        if (hit === 'kill') return this.end(r, 'dead', now);
        const studied = r.research.study;
        const done = advanceStudy(r.research, step, r.time);
        if (done !== null) {
          const sp = r.world.species[done];
          r.lidar.unknown[done] = 0;
          r.studyDoneUntil = r.time + 1800;
          r.lastStudy = studied ? { ...studied, progress: 1 } : null;
          this.hud.toast(`Новый вид: ${sp.name} — ${sp.ru}`, now, 5000);
          this.sfx.chime();
          if (r.research.documented.size === config.research.documentGoal) this.hud.toast('Достаточно данных. Возвращайся к маяку.', now + 1, 6000);
        }
      });
      if (r.ended) return;

      if (scanReq && !r.research.study && tryPulse(r.scanner)) this.pulse();

      if (interact) {
        const p = r.player;
        const nearBeacon = Math.hypot(p.x - r.world.beacon.x, p.z - r.world.beacon.z) < config.research.extractRadius;
        if (r.research.study) {
          r.research.study = null;
          this.specimen.close();
        } else if (nearBeacon && r.research.documented.size >= config.research.documentGoal) {
          this.end(r, 'extracted', now);
          return;
        } else {
          const t = this.target(r);
          if (t && !r.research.documented.has(t.species)) {
            startStudy(r.research, t.species, { kind: t.kind, id: t.id });
            this.specimen.open(r.world.species[t.species], r.seed * 13 + t.species);
          }
        }
      }
    }

    // Камера и отрисовка.
    const p = r.player;
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
    const studying = r.research.study;
    r.lidar.dim = studying ? 0.3 : 1;
    r.lidar.update(r.time);
    this.renderer.render(this.display, this.camera);
    if (studying) {
      this.specimen.update(studying.progress, dt, r.time, drag);
      this.specimen.render(this.renderer);
      this.studyPanel.show(studying, r.world.species[studying.species], false);
    } else if (r.time < r.studyDoneUntil && this.specimen.active && !this.journal.open && r.lastStudy) {
      this.specimen.update(1, dt, r.time, 0);
      this.specimen.render(this.renderer);
      this.studyPanel.show(r.lastStudy, r.world.species[r.lastStudy.species], true);
    } else {
      if (this.specimen.active) this.specimen.close();
      this.studyPanel.hide();
    }

    // HUD.
    const t = studying ? null : this.target(r);
    const docN = r.research.documented.size;
    const goal = config.research.documentGoal;
    const bx = r.world.beacon.x - p.x;
    const bz = r.world.beacon.z - p.z;
    const right = bx * Math.cos(p.yaw) - bz * Math.sin(p.yaw);
    const fwd = -bx * Math.sin(p.yaw) - bz * Math.cos(p.yaw);
    const nearBeacon = Math.hypot(bx, bz) < config.research.extractRadius;
    let prompt = '';
    if (nearBeacon && docN >= goal) prompt = 'E — эвакуация';
    else if (t) {
      const sp = r.world.species[t.species];
      prompt = r.research.documented.has(t.species)
        ? `${sp.name} — уже в журнале`
        : `E — образец: неизвестный вид (${CLADE_RU[sp.clade]}) · ${t.dist.toFixed(1)} м`;
    }
    const darkDist = distTo(r.dark, p.x, p.z);
    this.hud.draw(
      {
        charge: r.scanner.charge,
        beaconBearing: Math.atan2(-right, fwd),
        documented: docN,
        goal,
        total: r.world.species.length,
        prompt,
        gaze: this.withCamera && !eye.lost && !eye.blink && !eye.closed ? eye.gaze : null,
        danger: r.dark.awake ? Math.max(0, 1 - darkDist / 20) : 0,
        holding: gazeOn && r.dark.held,
        extractReady: docN >= goal,
      },
      now,
    );

    // Звук.
    this.sfx.listen(this.camera);
    this.sfx.ambient(true, now);
    this.sfx.darkMatter(new THREE.Vector3(r.dark.x, r.dark.y, r.dark.z), darkDist, r.dark.awake);
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
}

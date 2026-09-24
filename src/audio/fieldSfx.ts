// Звук поля (GDD → Звук): главный канал между сканами. Всё синтезировано (без сэмплов), общий движок
// engine.ts: компрессор + процедурная реверберация леса. Объём — HRTF-панорамы, слушатель = камера.
// Слои: лес (ветер, шелест, сверчки, далёкие события) → гул напряжения → сердце → игрок → силуэт.
import * as THREE from 'three';
import { audio, unlockAudio, type Engine } from './engine';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export interface AmbientState {
  tension: number; // 0..1 от директора
  hush: number; // 0..1: лес затихает (силуэт рядом)
  heart: number; // 0..1: сердцебиение
  eyesClosed: boolean; // в темноте слух острее: фон тише
  paused: boolean;
}

interface Cricket {
  panner: PannerNode;
  gain: GainNode;
  osc: OscillatorNode;
  next: number;
  x: number;
  z: number;
}

interface Ambience {
  bus: GainNode;
  windGain: GainNode;
  windBand: BiquadFilterNode;
  airBand: BiquadFilterNode;
  airPan: StereoPannerNode;
  leaves: GainNode;
  insects: GainNode;
  crickets: Cricket[];
  drone: GainNode;
  droneLp: BiquadFilterNode;
  shimmer: GainNode;
  nextGust: number;
  nextEvent: number;
  nextHeart: number;
}

export class FieldSfx {
  private e: Engine | null = null;
  private amb: Ambience | null = null;
  private tone: { gain: GainNode; lp: BiquadFilterNode; saws: OscillatorNode[]; whine: OscillatorNode; whineGain: GainNode } | null = null;
  private hum: { gain: GainNode; osc: OscillatorNode; last: number; nextTick: number } | null = null;
  private breath: { panner: PannerNode; gain: GainNode; band: BiquadFilterNode; src: AudioBufferSourceNode; next: number } | null = null;
  private buzz = new Map<number, { panner: PannerNode; gain: GainNode; osc: OscillatorNode }>();

  unlock(): void {
    this.e = unlockAudio();
  }

  private get ctx(): AudioContext | null {
    this.e ??= audio();
    return this.e?.ctx ?? null;
  }

  // ─── Кирпичики ──────────────────────────────────────────────────────────────

  /** Подключить к выходу: сухо + доля в реверберацию. */
  private out(node: AudioNode, wet = 0.15, dest?: AudioNode): void {
    const e = this.e!;
    node.connect(dest ?? e.bus);
    if (wet > 0) {
      const s = e.ctx.createGain();
      s.gain.value = wet;
      node.connect(s).connect(e.send);
    }
  }

  private env(g: AudioParam, at: number, peak: number, attack: number, decay: number): void {
    g.setValueAtTime(0.0001, at);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + attack);
    g.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  }

  private noise(buf: AudioBuffer, at: number, dur: number, rate = 1, loop = false): AudioBufferSourceNode {
    const s = this.e!.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    s.playbackRate.value = rate;
    s.start(at, Math.random() * (buf.duration - dur - 0.1));
    if (!loop) s.stop(at + dur + 0.05);
    return s;
  }

  private panner(x: number, y: number, z: number, ref = 2, roll = 1.2): PannerNode {
    const p = this.e!.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = roll;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    return p;
  }

  private filter(type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
    const b = this.e!.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  private osc(type: OscillatorType, f: number, at: number, dur: number): OscillatorNode {
    const o = this.e!.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, at);
    o.start(at);
    o.stop(at + dur + 0.05);
    return o;
  }

  /** Слушатель = камера. */
  listen(cam: THREE.Camera): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const t = ctx.currentTime;
    l.positionX.setTargetAtTime(cam.position.x, t, 0.02);
    l.positionY.setTargetAtTime(cam.position.y, t, 0.02);
    l.positionZ.setTargetAtTime(cam.position.z, t, 0.02);
    l.forwardX.setTargetAtTime(f.x, t, 0.02);
    l.forwardY.setTargetAtTime(f.y, t, 0.02);
    l.forwardZ.setTargetAtTime(f.z, t, 0.02);
    l.upX.setTargetAtTime(u.x, t, 0.02);
    l.upY.setTargetAtTime(u.y, t, 0.02);
    l.upZ.setTargetAtTime(u.z, t, 0.02);
  }

  // ─── Лес и напряжение ───────────────────────────────────────────────────────

  private buildAmbience(): Ambience {
    const e = this.e!;
    const ctx = e.ctx;
    const t = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.gain.setTargetAtTime(1, t, 1.5);
    this.out(bus, 0.12);

    // Ветер: тело (розовый шум, полоса гуляет) + воздух (узкая полоса, панорама дрейфует).
    const windGain = ctx.createGain();
    windGain.gain.value = 0.05;
    const windBand = this.filter('bandpass', 380, 0.6);
    this.noise(e.pink, t, 0, 1, true).connect(windBand).connect(windGain).connect(bus);
    const airBand = this.filter('bandpass', 1400, 4);
    const airGain = ctx.createGain();
    airGain.gain.value = 0.012;
    const airPan = ctx.createStereoPanner();
    this.noise(e.pink, t, 0, 1, true).connect(airBand).connect(airGain).connect(airPan).connect(bus);

    // Шелест листвы: верхний шум, громкость дёргает медленный коричневый шум.
    const leaves = ctx.createGain();
    leaves.gain.value = 0.006;
    const mod = ctx.createGain();
    mod.gain.value = 0.012;
    this.noise(e.brown, t, 0, 0.08, true).connect(mod).connect(leaves.gain);
    this.noise(e.white, t, 0, 1, true).connect(this.filter('highpass', 3800, 0.5)).connect(leaves).connect(bus);

    // Сверчки: несколько голосов в мире вокруг слушателя, трели по расписанию.
    const insects = ctx.createGain();
    insects.connect(bus);
    const crickets: Cricket[] = [];
    for (let i = 0; i < 5; i++) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = this.panner(0, 0, 0, 6, 1);
      const osc = ctx.createOscillator();
      osc.frequency.value = rnd(4200, 5600);
      osc.connect(gain).connect(panner).connect(insects);
      osc.start();
      crickets.push({ panner, gain, osc, next: t + rnd(0, 2), x: NaN, z: NaN });
    }

    // Гул: две близкие низкие + квинта через фильтр; сверху — диссонирующее мерцание на пике.
    const drone = ctx.createGain();
    drone.gain.value = 0;
    const droneLp = this.filter('lowpass', 260, 0.9);
    for (const [type, f] of [['sine', 55], ['sine', 55.7], ['triangle', 82.4], ['sawtooth', 110.3]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = type === 'sawtooth' ? 0.15 : 0.5;
      o.connect(g).connect(droneLp);
      o.start();
    }
    droneLp.connect(drone).connect(bus);
    const shimmer = ctx.createGain();
    shimmer.gain.value = 0;
    for (const f of [1480, 1568, 2217]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rnd(0.15, 0.4);
      const depth = ctx.createGain();
      depth.gain.value = 0.3;
      const g = ctx.createGain();
      g.gain.value = 0.35;
      lfo.connect(depth).connect(g.gain);
      o.connect(g).connect(shimmer);
      o.start();
      lfo.start();
    }
    this.out(shimmer, 0.8, bus);

    return { bus, windGain, windBand, airBand, airPan, leaves, insects, crickets, drone, droneLp, shimmer, nextGust: 0, nextEvent: t + 6, nextHeart: 0 };
  }

  /** Раз в кадр: лес живёт, гул следует за напряжением, сердце — за страхом. */
  ambient(s: AmbientState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.amb ??= this.buildAmbience();
    const a = this.amb;
    const t = ctx.currentTime;
    const hush = clamp01(s.hush);
    a.bus.gain.setTargetAtTime(s.paused ? 0.25 : s.eyesClosed ? 0.7 : 1, t, 0.4);

    if (t > a.nextGust) {
      a.nextGust = t + rnd(2, 6);
      const gust = rnd(0.3, 1);
      a.windGain.gain.setTargetAtTime(0.03 + 0.05 * gust, t, rnd(0.8, 2));
      a.windBand.frequency.setTargetAtTime(260 + 320 * gust, t, 1.5);
      a.airBand.frequency.setTargetAtTime(rnd(900, 2200), t, 2);
      a.airPan.pan.setTargetAtTime(rnd(-0.8, 0.8), t, 2.5);
      a.leaves.gain.setTargetAtTime(0.003 + 0.01 * gust, t, 1);
    }

    // Сверчки: переставить далёкие, спеть по расписанию. Рядом с силуэтом — замолкают.
    a.insects.gain.setTargetAtTime(0.9 * (1 - hush) ** 2, t, hush > 0.5 ? 0.6 : 2);
    const l = ctx.listener;
    const lx = l.positionX.value;
    const lz = l.positionZ.value;
    for (const c of a.crickets) {
      if (!(Math.hypot(c.x - lx, c.z - lz) < 32)) {
        const ang = rnd(0, Math.PI * 2);
        const d = rnd(9, 26);
        c.x = lx + Math.cos(ang) * d;
        c.z = lz + Math.sin(ang) * d;
        c.panner.positionX.value = c.x;
        c.panner.positionY.value = l.positionY.value - 1.4;
        c.panner.positionZ.value = c.z;
      }
      if (t > c.next) {
        const pulses = Math.round(rnd(2, 5));
        const rate = rnd(0.035, 0.055);
        for (let k = 0; k < pulses; k++) this.env(c.gain.gain, t + k * rate, 0.02, 0.004, rate * 0.6);
        c.next = t + pulses * rate + rnd(0.4, 2.2);
      }
    }

    a.drone.gain.setTargetAtTime(0.012 + 0.07 * s.tension ** 1.5, t, 1.2);
    a.droneLp.frequency.setTargetAtTime(180 + 420 * s.tension, t, 1.5);
    a.shimmer.gain.setTargetAtTime(s.tension > 0.6 ? 0.012 * (s.tension - 0.6) / 0.4 : 0, t, 2);

    if (!s.paused && t > a.nextEvent) {
      a.nextEvent = t + rnd(7, 18) * (hush > 0.5 ? 0.6 : 1);
      this.distantEvent(hush);
    }

    // Сердце: изнутри головы (без панорамы), чаще и громче со страхом.
    if (s.heart > 0.08 && !s.paused && t > a.nextHeart) {
      const k = clamp01(s.heart);
      const at = Math.max(t + 0.02, a.nextHeart);
      for (const [dt, amp] of [[0, 1], [0.17, 0.55]] as const) {
        const o = this.osc('sine', 62, at + dt, 0.2);
        o.frequency.exponentialRampToValueAtTime(38, at + dt + 0.12);
        const g = ctx.createGain();
        this.env(g.gain, at + dt, (0.06 + 0.3 * k) * amp, 0.008, 0.16);
        o.connect(g);
        this.out(g, 0);
      }
      a.nextHeart = at + 60 / (58 + 72 * k);
    }
  }

  /** Далёкое: треск ветки, скрип ствола, сова. Когда силуэт рядом — только скрип. */
  private distantEvent(hush: number): void {
    const e = this.e!;
    const ctx = e.ctx;
    const t = ctx.currentTime + 0.02;
    const l = ctx.listener;
    const ang = rnd(0, Math.PI * 2);
    const d = rnd(18, 42);
    const p = this.panner(l.positionX.value + Math.cos(ang) * d, l.positionY.value, l.positionZ.value + Math.sin(ang) * d, 4, 0.9);
    this.out(p, 0.7);
    const kind = hush > 0.5 ? 'creak' : (['snap', 'creak', 'owl', 'snap'] as const)[Math.floor(Math.random() * 4)];
    if (kind === 'snap') {
      const g = ctx.createGain();
      this.env(g.gain, t, 0.5, 0.002, 0.06);
      this.noise(e.white, t, 0.08).connect(this.filter('bandpass', rnd(1200, 2600), 1.2)).connect(g).connect(p);
      const g2 = ctx.createGain();
      this.env(g2.gain, t + 0.05, 0.25, 0.002, 0.12);
      this.noise(e.white, t + 0.05, 0.12).connect(this.filter('lowpass', 900)).connect(g2).connect(p);
    } else if (kind === 'creak') {
      const dur = rnd(0.7, 1.6);
      const o = this.osc('sawtooth', rnd(70, 110), t, dur);
      o.frequency.linearRampToValueAtTime(rnd(55, 130), t + dur);
      const vib = this.osc('sine', rnd(18, 32), t, dur);
      const vd = ctx.createGain();
      vd.gain.value = 9;
      vib.connect(vd).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.06, t + dur * 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(this.filter('bandpass', rnd(500, 900), 3)).connect(g).connect(p);
    } else {
      for (const [dt, f] of [[0, 392], [0.42, 349]] as const) {
        const o = this.osc('sine', f, t + dt, 0.45);
        const vib = this.osc('sine', 5, t + dt, 0.45);
        const vd = ctx.createGain();
        vd.gain.value = 4;
        vib.connect(vd).connect(o.frequency);
        const g = ctx.createGain();
        this.env(g.gain, t + dt, 0.05, 0.08, 0.3);
        o.connect(g).connect(p);
      }
    }
  }

  // ─── Игрок ──────────────────────────────────────────────────────────────────

  /** Импульс: суб-удар, чирп, звон, затем «дождь» возвращающихся эхо (дальние — позже и тише). */
  pulse(power = 0.5): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const e = this.e!;
    const t = ctx.currentTime + 0.01;
    const sub = this.osc('sine', 72, t, 0.45);
    sub.frequency.exponentialRampToValueAtTime(34, t + 0.35);
    const sg = ctx.createGain();
    this.env(sg.gain, t, 0.32 + 0.2 * power, 0.005, 0.38);
    sub.connect(sg);
    this.out(sg, 0.05);

    const chirp = this.osc('sine', 2600 - power * 500, t, 0.35);
    chirp.frequency.exponentialRampToValueAtTime(420 - power * 160, t + 0.16 + power * 0.1);
    const cg = ctx.createGain();
    this.env(cg.gain, t, 0.12, 0.004, 0.22 + power * 0.1);
    chirp.connect(cg);
    this.out(cg, 0.35);

    const ping = this.osc('triangle', 1760, t + 0.02, 0.5);
    const pg = ctx.createGain();
    this.env(pg.gain, t + 0.02, 0.045, 0.003, 0.45);
    ping.connect(pg);
    this.out(pg, 0.9);

    // Возвраты: щелчки со случайных направлений, всё реже и тише.
    const n = Math.round(24 + 34 * power);
    const span = 0.8 + 0.7 * power;
    for (let i = 0; i < n; i++) {
      const k = Math.random() ** 0.7;
      const at = t + 0.05 + k * span;
      const g = ctx.createGain();
      this.env(g.gain, at, 0.05 * (1 - k * 0.8), 0.001, 0.012 + Math.random() * 0.02);
      const pan = ctx.createStereoPanner();
      pan.pan.value = rnd(-1, 1);
      this.noise(e.white, at, 0.04).connect(this.filter('bandpass', rnd(1800, 6500), 2.5)).connect(g).connect(pan);
      this.out(pan, 0.35);
    }
    const sweep = this.filter('bandpass', 6000, 2);
    sweep.frequency.setValueAtTime(6000, t);
    sweep.frequency.exponentialRampToValueAtTime(900, t + span);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.04, t + 0.08);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + span + 0.1);
    this.noise(e.white, t, span + 0.2).connect(sweep).connect(ng);
    this.out(ng, 0.4);
  }

  /** Накопление импульса с закрытыми глазами: пад поднимается и светлеет, сверху — тонкий писк. */
  charge(on: boolean, power: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (on && !this.tone) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const lp = this.filter('lowpass', 300, 2);
      const saws = [110, 110.8, 165.2].map((f) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.connect(lp);
        o.start();
        return o;
      });
      lp.connect(gain);
      this.out(gain, 0.4);
      const whine = ctx.createOscillator();
      whine.frequency.value = 2400;
      const whineGain = ctx.createGain();
      whineGain.gain.value = 0;
      whine.connect(whineGain);
      this.out(whineGain, 0.2);
      whine.start();
      this.tone = { gain, lp, saws, whine, whineGain };
    }
    if (!this.tone) return;
    const k = 1 + power * 0.5;
    this.tone.saws.forEach((o, i) => o.frequency.setTargetAtTime([110, 110.8, 165.2][i] * k, t, 0.1));
    this.tone.lp.frequency.setTargetAtTime(300 + 2400 * power, t, 0.1);
    this.tone.gain.gain.setTargetAtTime(on ? 0.018 + 0.03 * power : 0, t, on ? 0.12 : 0.03);
    this.tone.whine.frequency.setTargetAtTime(2400 + 1600 * power, t, 0.1);
    this.tone.whineGain.gain.setTargetAtTime(on ? 0.002 + 0.006 * power : 0, t, 0.1);
    if (!on) {
      for (const o of [...this.tone.saws, this.tone.whine]) o.stop(t + 0.3);
      this.tone = null;
    }
  }

  /** Открыл глаза без заряда: глухой щелчок. */
  denied(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    const o = this.osc('square', 110, t, 0.1);
    const g = ctx.createGain();
    this.env(g.gain, t, 0.05, 0.004, 0.06);
    o.connect(this.filter('lowpass', 600)).connect(g);
    this.out(g, 0.1);
  }

  /** Шаг по подстилке: хруст + мягкий удар. */
  footstep(run: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const e = this.e!;
    const t = ctx.currentTime + 0.005;
    const g = ctx.createGain();
    this.env(g.gain, t, run ? 0.09 : 0.06, 0.004, rnd(0.07, 0.11));
    const pan = ctx.createStereoPanner();
    pan.pan.value = rnd(-0.15, 0.15);
    this.noise(e.white, t, 0.15, rnd(0.7, 1.2)).connect(this.filter('bandpass', rnd(1800, 3800), 0.8)).connect(g).connect(pan);
    this.out(pan, 0.06);
    const th = this.osc('sine', rnd(70, 95), t, 0.08);
    const tg = ctx.createGain();
    this.env(tg.gain, t, run ? 0.08 : 0.05, 0.004, 0.05);
    th.connect(tg);
    this.out(tg, 0);
  }

  /** Бумага: чтение записи экспедиции. */
  note(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    for (let i = 0; i < 3; i++) {
      const g = ctx.createGain();
      this.env(g.gain, t + i * 0.09, 0.05, 0.01, 0.08);
      this.noise(this.e!.white, t + i * 0.09, 0.12, 0.8).connect(this.filter('bandpass', rnd(3000, 6000), 1.4)).connect(g);
      this.out(g, 0.2);
    }
  }

  // ─── Силуэт ─────────────────────────────────────────────────────────────────

  /** Его шаг: тяжелее и ниже твоего, в объёме. Замолкают — значит, он замер (ты смотришь). */
  stalkerStep(pos: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const e = this.e!;
    const t = ctx.currentTime + 0.01;
    const p = this.panner(pos.x, pos.y + 0.1, pos.z, 3, 1.05);
    this.out(p, 0.3);
    const g = ctx.createGain();
    this.env(g.gain, t, 0.22, 0.006, rnd(0.1, 0.16));
    this.noise(e.white, t, 0.2, rnd(0.5, 0.8)).connect(this.filter('lowpass', 1500, 0.7)).connect(this.filter('peaking', 600, 1)).connect(g).connect(p);
    const th = this.osc('sine', rnd(48, 60), t, 0.12);
    const tg = ctx.createGain();
    this.env(tg.gain, t, 0.2, 0.006, 0.09);
    th.connect(tg).connect(p);
  }

  /** Дыхание вблизи: медленные влажные вдохи. dist > 9 — тишина. */
  stalkerBreath(pos: THREE.Vector3, dist: number, on: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const e = this.e!;
    const t = ctx.currentTime;
    const want = on && dist < 9;
    if (want && !this.breath) {
      const panner = this.panner(pos.x, pos.y + 1.7, pos.z, 1.2, 1.4);
      const band = this.filter('bandpass', 800, 1.6);
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      const src = this.noise(e.pink, t, 0, 1, true);
      src.connect(band).connect(gain).connect(panner);
      this.out(panner, 0.25);
      this.breath = { panner, gain, band, src, next: t };
    }
    const b = this.breath;
    if (!b) return;
    b.panner.positionX.setTargetAtTime(pos.x, t, 0.05);
    b.panner.positionY.setTargetAtTime(pos.y + 1.7, t, 0.05);
    b.panner.positionZ.setTargetAtTime(pos.z, t, 0.05);
    if (!want) {
      b.gain.gain.cancelScheduledValues(t);
      b.gain.gain.setTargetAtTime(0.0001, t, 0.3);
      b.src.stop(t + 1.5);
      this.breath = null;
      return;
    }
    if (t >= b.next) {
      const peak = 0.05 + 0.12 * clamp01(1 - dist / 9);
      b.gain.gain.cancelScheduledValues(t);
      b.gain.gain.setValueAtTime(0.0001, t);
      b.gain.gain.exponentialRampToValueAtTime(peak, t + 0.9); // вдох
      b.gain.gain.exponentialRampToValueAtTime(0.0002, t + 1.5);
      b.gain.gain.exponentialRampToValueAtTime(peak * 0.8, t + 1.9); // выдох
      b.gain.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
      b.band.frequency.setValueAtTime(1100, t);
      b.band.frequency.linearRampToValueAtTime(700, t + 1.5);
      b.band.frequency.linearRampToValueAtTime(520, t + 3.2);
      b.next = t + rnd(3.4, 4.2);
    }
  }

  /** Скан поймал его: близко — диссонирующий удар и вздох шума, далеко — тихий укол. */
  sting(close: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const e = this.e!;
    const t = ctx.currentTime + 0.01;
    const lvl = close ? 1 : 0.35;
    for (const f of close ? [233, 247.5, 370, 523, 555] : [311, 330]) {
      const o = this.osc(close ? 'sawtooth' : 'sine', f * rnd(0.995, 1.005), t, 2.6);
      const g = ctx.createGain();
      this.env(g.gain, t, 0.06 * lvl, 0.01, close ? 2.4 : 1.4);
      o.connect(this.filter('lowpass', 2400)).connect(g);
      this.out(g, 0.7);
    }
    if (close) {
      const boom = this.osc('sine', 60, t, 1.2);
      boom.frequency.exponentialRampToValueAtTime(28, t + 1);
      const bg = ctx.createGain();
      this.env(bg.gain, t, 0.5, 0.01, 1.1);
      boom.connect(bg);
      this.out(bg, 0.2);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t - 0.01);
      ng.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      this.noise(e.pink, t, 1).connect(this.filter('highpass', 900)).connect(ng);
      this.out(ng, 0.6);
    }
  }

  /** Он дотянулся: крик сквозь шум, удар, потом тишина. */
  caught(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const e = this.e!;
    const t = ctx.currentTime + 0.01;
    const scream = this.osc('sawtooth', 620, t, 1.1);
    scream.frequency.exponentialRampToValueAtTime(1300, t + 0.25);
    scream.frequency.exponentialRampToValueAtTime(480, t + 1);
    const vib = this.osc('sine', 13, t, 1.1);
    const vd = ctx.createGain();
    vd.gain.value = 40;
    vib.connect(vd).connect(scream.frequency);
    const sg = ctx.createGain();
    this.env(sg.gain, t, 0.22, 0.01, 1);
    scream.connect(this.filter('bandpass', 1100, 1.5)).connect(sg);
    this.out(sg, 0.6);
    const ng = ctx.createGain();
    this.env(ng.gain, t, 0.35, 0.005, 0.8);
    this.noise(e.white, t, 0.9).connect(this.filter('highpass', 400)).connect(ng);
    this.out(ng, 0.5);
    this.sting(true);
  }

  // ─── Наука и прочее ─────────────────────────────────────────────────────────

  /** Жужжание летающих рядом (до 3 ближайших). */
  insects(near: { id: number; pos: THREE.Vector3; hz: number }[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const keep = new Set(near.map((n) => n.id));
    for (const [id, b] of this.buzz) {
      if (!keep.has(id)) {
        b.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
        b.osc.stop(ctx.currentTime + 0.5);
        this.buzz.delete(id);
      }
    }
    for (const n of near) {
      let b = this.buzz.get(n.id);
      if (!b) {
        const panner = this.panner(n.pos.x, n.pos.y, n.pos.z, 0.6);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.connect(this.filter('bandpass', 900)).connect(gain).connect(panner);
        this.out(panner, 0.05);
        osc.start();
        b = { panner, gain, osc };
        this.buzz.set(n.id, b);
      }
      const t = ctx.currentTime;
      b.panner.positionX.setTargetAtTime(n.pos.x, t, 0.03);
      b.panner.positionY.setTargetAtTime(n.pos.y, t, 0.03);
      b.panner.positionZ.setTargetAtTime(n.pos.z, t, 0.03);
      b.osc.frequency.setTargetAtTime(n.hz * rnd(0.97, 1.03), t, 0.05);
      b.gain.gain.setTargetAtTime(n.hz > 0 ? 0.05 : 0, t, 0.1);
    }
  }

  /** Детальный скан: гудение растёт с прогрессом, щелчки данных, отметка на смене прохода. */
  study(on: boolean, progress: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (on && !this.hum) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      this.out(gain, 0.2);
      osc.start();
      this.hum = { gain, osc, last: progress, nextTick: t };
    }
    const h = this.hum;
    if (!h) return;
    h.osc.frequency.setTargetAtTime(220 + progress * 440, t, 0.1);
    h.gain.gain.setTargetAtTime(on ? 0.03 : 0, t, 0.1);
    if (on && t > h.nextTick) {
      const g = ctx.createGain();
      this.env(g.gain, t, 0.025, 0.001, 0.015);
      this.osc('square', rnd(2000, 5000), t, 0.03).connect(g);
      this.out(g, 0.1);
      h.nextTick = t + rnd(0.05, 0.14);
    }
    if (on && Math.floor(progress * 3) > Math.floor(h.last * 3) && progress < 1) this.bell([988], 0.06);
    h.last = progress;
    if (!on) {
      h.osc.stop(t + 0.5);
      this.hum = null;
    }
  }

  /** Колокольчик: негармонические партиалы с долгим хвостом. */
  private bell(freqs: number[], level: number, gap = 0.1): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.01;
    freqs.forEach((f, i) => {
      for (const [ratio, amp, dec] of [[1, 1, 1.4], [2.76, 0.35, 0.7], [5.4, 0.15, 0.4]] as const) {
        const o = this.osc('sine', f * ratio, t + i * gap, dec + 0.1);
        const g = ctx.createGain();
        this.env(g.gain, t + i * gap, level * amp, 0.004, dec);
        o.connect(g);
        this.out(g, 0.5);
      }
    });
  }

  /** Новый вид. */
  chime(): void {
    if (!this.ctx) return;
    this.bell([659, 831, 988], 0.07);
  }

  /** Конец забега: смерть. Мир глохнет. */
  death(): void {
    this.caught();
    this.ambient({ tension: 0, hush: 1, heart: 0, eyesClosed: false, paused: true });
  }

  /** Всё постоянное — выключить (конец забега, новый мир). */
  silence(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.insects([]);
    this.study(false, 0);
    this.charge(false, 0);
    if (this.breath) this.stalkerBreath(new THREE.Vector3(), 99, false);
    if (this.amb) this.amb.bus.gain.setTargetAtTime(0.2, ctx.currentTime, 0.5);
  }
}

// Звук поля (GDD → Звук): главный канал между сканами. Синтез WebAudio, объём — HRTF-панорамы.
import * as THREE from 'three';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class FieldSfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private wind: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private dark: { panner: PannerNode; gain: GainNode; osc: OscillatorNode; osc2: OscillatorNode; noise: AudioBufferSourceNode } | null = null;
  private buzz = new Map<number, { panner: PannerNode; gain: GainNode; osc: OscillatorNode }>();
  private hum: { gain: GainNode; osc: OscillatorNode } | null = null;
  private nextBeat = 0;
  private nextChirp = 0;

  unlock(): void {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(ctx.destination);
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
  }

  private env(g: GainNode, at: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  }

  private panner(x: number, y: number, z: number): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 2;
    p.rolloffFactor = 1.2;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    return p;
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

  /** Импульс: чирп вниз + шорох отражений, растянутый на время прихода волны. */
  pulse(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(2400, t);
    o.frequency.exponentialRampToValueAtTime(380, t + 0.18);
    const g = ctx.createGain();
    o.connect(g).connect(this.master);
    this.env(g, t, 0.18, 0.005, 0.2);
    o.start(t);
    o.stop(t + 0.25);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(6000, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.9);
    bp.Q.value = 2;
    const ng = ctx.createGain();
    src.connect(bp).connect(ng).connect(this.master);
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.09, t + 0.08);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    src.start(t, Math.random());
    src.stop(t + 1);
  }

  footstep(run: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800 + Math.random() * 1500;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    src.connect(f).connect(g).connect(this.master);
    this.env(g, t, run ? 0.07 : 0.045, 0.01, 0.12);
    src.start(t, Math.random());
    src.stop(t + 0.2);
  }

  /** Ветер и далёкие насекомые — чтобы тишина не была цифровой. */
  ambient(on: boolean, now: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    if (on && !this.wind) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 400;
      filter.Q.value = 0.6;
      const gain = ctx.createGain();
      gain.gain.value = 0.035;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      this.wind = { gain, filter };
    }
    if (!on || !this.wind) return;
    const t = ctx.currentTime;
    this.wind.filter.frequency.setTargetAtTime(300 + 250 * (0.5 + 0.5 * Math.sin(now / 4300)), t, 0.5);
    this.wind.gain.gain.setTargetAtTime(0.025 + 0.02 * (0.5 + 0.5 * Math.sin(now / 2900)), t, 0.5);
    if (now > this.nextChirp) {
      this.nextChirp = now + 1500 + Math.random() * 5000;
      const a = Math.random() * Math.PI * 2;
      const l = ctx.listener;
      const p = this.panner(l.positionX.value + Math.cos(a) * 25, l.positionY.value, l.positionZ.value + Math.sin(a) * 25);
      const g = ctx.createGain();
      p.connect(this.master);
      g.connect(p);
      const o = ctx.createOscillator();
      o.frequency.value = 3200 + Math.random() * 2500;
      o.connect(g);
      const at = t + 0.01;
      for (let k = 0; k < 3; k++) this.env(g, at + k * 0.09, 0.03, 0.005, 0.05);
      o.start(at);
      o.stop(at + 0.35);
    }
  }

  /** Гул чёрной материи: позиция, громкость от дистанции; сердцебиение ближе 15 м. */
  darkMatter(pos: THREE.Vector3 | null, dist: number, awake: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    if (!this.dark && pos && awake) {
      const panner = this.panner(pos.x, pos.y, pos.z);
      panner.refDistance = 4;
      panner.rolloffFactor = 1.6;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(panner).connect(this.master);
      const osc = ctx.createOscillator();
      osc.frequency.value = 38;
      const osc2 = ctx.createOscillator();
      osc2.frequency.value = 38.7;
      osc2.type = 'sawtooth';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 160;
      osc.connect(gain);
      osc2.connect(lp).connect(gain);
      const noise = ctx.createBufferSource();
      noise.buffer = this.noise;
      noise.loop = true;
      const nf = ctx.createBiquadFilter();
      nf.type = 'lowpass';
      nf.frequency.value = 90;
      noise.connect(nf).connect(gain);
      osc.start();
      osc2.start();
      noise.start();
      this.dark = { panner, gain, osc, osc2, noise };
    }
    const t = ctx.currentTime;
    if (this.dark) {
      if (pos) {
        this.dark.panner.positionX.setTargetAtTime(pos.x, t, 0.05);
        this.dark.panner.positionY.setTargetAtTime(pos.y, t, 0.05);
        this.dark.panner.positionZ.setTargetAtTime(pos.z, t, 0.05);
      }
      this.dark.gain.gain.setTargetAtTime(awake ? 0.5 * clamp01(1 - dist / 60) : 0, t, 0.3);
    }
    if (awake && dist < 15 && ctx.currentTime + 0.1 > this.nextBeat) {
      const close = clamp01(1 - dist / 15);
      if (this.nextBeat < ctx.currentTime) this.nextBeat = ctx.currentTime + 0.05;
      for (const [dt, k] of [[0, 1], [0.15, 0.6]] as const) {
        const at = this.nextBeat + dt;
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(60, at);
        o.frequency.exponentialRampToValueAtTime(38, at + 0.12);
        const g = ctx.createGain();
        o.connect(g).connect(this.master);
        this.env(g, at, (0.08 + 0.35 * close) * k, 0.01, 0.14);
        o.start(at);
        o.stop(at + 0.2);
      }
      this.nextBeat += 1.1 - 0.65 * close;
    }
  }

  /** Жужжание летающих рядом (до 3 ближайших). */
  insects(near: { id: number; pos: THREE.Vector3; hz: number }[]): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
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
        const panner = this.panner(n.pos.x, n.pos.y, n.pos.z);
        panner.refDistance = 0.6;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 900;
        osc.connect(f).connect(gain).connect(panner).connect(this.master);
        osc.start();
        b = { panner, gain, osc };
        this.buzz.set(n.id, b);
      }
      const t = ctx.currentTime;
      b.panner.positionX.setTargetAtTime(n.pos.x, t, 0.03);
      b.panner.positionY.setTargetAtTime(n.pos.y, t, 0.03);
      b.panner.positionZ.setTargetAtTime(n.pos.z, t, 0.03);
      b.osc.frequency.setTargetAtTime(n.hz, t, 0.05);
      b.gain.gain.setTargetAtTime(n.hz > 0 ? 0.05 : 0, t, 0.1);
    }
  }

  study(on: boolean, progress: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (on && !this.hum) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.master);
      osc.start();
      this.hum = { gain, osc };
    }
    if (!this.hum) return;
    const t = ctx.currentTime;
    this.hum.osc.frequency.setTargetAtTime(220 + progress * 440, t, 0.1);
    this.hum.gain.gain.setTargetAtTime(on ? 0.035 : 0, t, 0.1);
    if (!on) {
      this.hum.osc.stop(t + 0.5);
      this.hum = null;
    }
  }

  chime(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + 0.01;
    [660, 880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      o.connect(g).connect(this.master!);
      this.env(g, t + i * 0.09, 0.08, 0.01, 0.5);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.6);
    });
  }

  death(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(120, t);
    lp.frequency.exponentialRampToValueAtTime(2500, t + 0.8);
    const g = ctx.createGain();
    src.connect(lp).connect(g).connect(this.master);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.7);
    g.gain.setValueAtTime(0.0001, t + 0.85);
    src.start(t);
    src.stop(t + 0.9);
  }

  /** Всё постоянное — выключить (конец забега). */
  silence(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (this.dark) {
      this.dark.gain.gain.setTargetAtTime(0, t, 0.2);
      this.dark.osc.stop(t + 1);
      this.dark.osc2.stop(t + 1);
      this.dark.noise.stop(t + 1);
      this.dark = null;
    }
    this.insects([]);
    this.study(false, 0);
  }
}

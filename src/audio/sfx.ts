// Минимальный синтезированный звук грейбокса (ROADMAP → M1). Без ассетов, только WebAudio.
// Враги звучат только когда двигаются (GDD → Звук). Сторона — стерео-панорама по дорожке.
import { config } from '../config';
import type { GameEvent, GameState } from '../game/sim';
import { nearestDist } from '../game/sim';
import type { Zone } from '../input/types';

const PAN: Record<Zone, number> = { L: -0.85, C: 0, R: 0.85 };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private drone: { stop(): void } | null = null;
  private nextBeat = 0;

  /** Вызывать из обработчика жеста пользователя. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
  }

  private out(pan: number): GainNode | null {
    if (!this.ctx || !this.master) return null;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.master);
    return g;
  }

  private env(g: GainNode, at: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  }

  private distGain(dist: number): number {
    return clamp01(1.4 / (0.5 + dist * 0.4));
  }

  /** Шорох пластика + глухой удар: шаг манекена. */
  step(lane: Zone, dist: number, cause: 'walk' | 'blink' | 'push'): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime + 0.005;
    const vol = this.distGain(dist) * (cause === 'push' ? 0.45 : 0.8);
    const g = this.out(PAN[lane]);
    if (!g) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = cause === 'push' ? 500 : 900 + Math.random() * 900;
    bp.Q.value = 1.2;
    src.connect(bp).connect(g);
    this.env(g, t, vol, 0.006, cause === 'push' ? 0.35 : 0.11);
    src.start(t, Math.random() * 0.5, 0.5);

    const thud = ctx.createOscillator();
    thud.frequency.setValueAtTime(cause === 'push' ? 60 : 95, t);
    thud.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const tg = this.out(PAN[lane])!;
    thud.connect(tg);
    this.env(tg, t, vol * 0.7, 0.004, 0.12);
    thud.start(t);
    thud.stop(t + 0.2);
  }

  /** Импульс скана — центр, мягкий. */
  ping(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.005;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1600, t);
    o.frequency.exponentialRampToValueAtTime(900, t + 0.08);
    const g = this.out(0)!;
    o.connect(g);
    this.env(g, t, 0.12, 0.004, 0.09);
    o.start(t);
    o.stop(t + 0.12);
  }

  /** Эхо: сторона — панорама, дистанция — задержка, высота и громкость. */
  echo(lane: Zone, dist: number, delayMs: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delayMs / 1000;
    const near = clamp01(1 - dist / 12);
    const vol = 0.08 + 0.45 * near;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 420 + 900 * near;
    const g = this.out(PAN[lane])!;
    o.connect(g);
    this.env(g, t, vol, 0.004, 0.07 + 0.08 * near);
    o.start(t);
    o.stop(t + 0.2);
  }

  /** Тихий «щелчок фокуса»: пригвоздил. */
  pinned(lane: Zone): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.005;
    const o = ctx.createOscillator();
    o.frequency.value = 2400;
    const g = this.out(PAN[lane] * 0.5)!;
    o.connect(g);
    this.env(g, t, 0.03, 0.002, 0.04);
    o.start(t);
    o.stop(t + 0.06);
  }

  death(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(1800, t + 0.6);
    const g = this.out(0)!;
    src.connect(lp).connect(g);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.5);
    g.gain.setValueAtTime(0.0001, t + 0.66);
    src.start(t);
    src.stop(t + 0.7);
  }

  setDrone(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.master) return;
    if (!on) {
      this.drone?.stop();
      this.drone = null;
      return;
    }
    if (this.drone) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 140;
    const g = ctx.createGain();
    g.gain.value = 0.06;
    src.connect(lp).connect(g).connect(this.master);
    const hum = ctx.createOscillator();
    hum.frequency.value = 41;
    const hg = ctx.createGain();
    hg.gain.value = 0.025;
    hum.connect(hg).connect(this.master);
    src.start();
    hum.start();
    this.drone = {
      stop: () => {
        src.stop();
        hum.stop();
      },
    };
  }

  /** Сердцебиение от близости ближайшего. Планируется чуть вперёд, чтобы не зависеть от fps. */
  heartbeat(g: GameState | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!g || g.phase !== 'play') {
      this.nextBeat = 0;
      return;
    }
    const gc = config.game;
    const close = clamp01((gc.startDist[0] - nearestDist(g)) / (gc.startDist[0] - gc.killDist));
    const now = ctx.currentTime;
    if (this.nextBeat < now) this.nextBeat = now + 0.05;
    if (this.nextBeat > now + 0.1) return;
    const interval = 1.15 - 0.72 * close;
    const vol = 0.05 + 0.4 * close * close;
    for (const [dt, k] of [[0, 1], [0.14, 0.6]] as const) {
      const t = this.nextBeat + dt;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(58, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
      const gg = this.out(0)!;
      o.connect(gg);
      this.env(gg, t, vol * k, 0.01, 0.14);
      o.start(t);
      o.stop(t + 0.2);
    }
    this.nextBeat += interval;
  }

  handle(events: readonly GameEvent[]): void {
    for (const e of events) {
      switch (e.kind) {
        case 'step':
          this.step(e.lane, e.dist, e.cause);
          break;
        case 'push':
          this.step(e.lane, e.dist, 'push');
          break;
        case 'ping':
          this.ping();
          break;
        case 'echo':
          this.echo(e.lane, e.dist, e.delayMs);
          break;
        case 'pinned':
          this.pinned(e.lane);
          break;
        case 'death':
          this.death();
          break;
      }
    }
  }
}

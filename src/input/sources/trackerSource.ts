import { config } from '../../config';
import { GazeProcessor } from '../gaze';
import { FaceTracker } from '../tracker';
import type { CalibrationProfile, EyeEvent, EyeSource, EyeState, FaceFrame, RawFrame } from '../types';

/** Камера → FaceTracker → GazeProcessor. Трекинг в своём цикле (requestVideoFrameCallback), игра забирает poll(). */
export class TrackerSource implements EyeSource {
  readonly kind = 'tracker' as const;
  readonly video: HTMLVideoElement;
  readonly gaze: GazeProcessor;
  private tracker: FaceTracker | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private lastRun = -Infinity;
  private pending: EyeEvent[] = [];
  private rawListeners = new Set<(f: RawFrame) => void>();
  private runTimes: number[] = [];
  lastRaw: RawFrame | null = null;
  lastFace: FaceFrame | null = null;
  stats = { inferMs: 0, hz: 0, delegate: '', targetHz: config.tracker.targetHz };
  private fpsLowSince: number | null = null;
  private fpsHighSince: number | null = null;

  /**
   * Трекер и рендер делят кадр (CLAUDE.md → Грабли): рендер просел — снижаем частоту трекинга,
   * отпустило — возвращаем. Вызывать каждый кадр рендера.
   */
  setRenderFps(fps: number, now: number): void {
    const a = config.tracker.adaptive;
    const st = this.stats;
    this.fpsLowSince = fps < a.lowFps ? (this.fpsLowSince ?? now) : null;
    this.fpsHighSince = fps > a.highFps ? (this.fpsHighSince ?? now) : null;
    if (this.fpsLowSince !== null && now - this.fpsLowSince > a.holdMs && st.targetHz > a.minHz) {
      st.targetHz = Math.max(a.minHz, st.targetHz - a.stepHz);
      this.fpsLowSince = now;
    }
    if (this.fpsHighSince !== null && now - this.fpsHighSince > a.holdMs && st.targetHz < config.tracker.targetHz) {
      st.targetHz = Math.min(config.tracker.targetHz, st.targetHz + a.stepHz);
      this.fpsHighSince = now;
    }
  }

  constructor(profile: CalibrationProfile) {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.gaze = new GazeProcessor(profile);
  }

  onRaw(cb: (f: RawFrame) => void): () => void {
    this.rawListeners.add(cb);
    return () => this.rawListeners.delete(cb);
  }

  async start(): Promise<void> {
    const v = config.tracker.video;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: v.width },
        height: { ideal: v.height },
        frameRate: { ideal: v.frameRate },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.tracker ??= await FaceTracker.create();
    this.stats.delegate = this.tracker.delegate;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  poll(): EyeState {
    const events = this.pending;
    this.pending = [];
    return { ...this.gaze.current, events };
  }

  private schedule(): void {
    if (!this.running) return;
    if ('requestVideoFrameCallback' in this.video) this.video.requestVideoFrameCallback(() => this.tick());
    else requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    if (!this.running || !this.tracker) return;
    const now = performance.now();
    const minGap = 1000 / this.stats.targetHz - 2;
    if (now - this.lastRun >= minGap && this.video.readyState >= 2) {
      this.lastRun = now;
      const { raw, face } = this.tracker.detect(this.video, now);
      const dt = performance.now() - now;
      this.stats.inferMs = this.stats.inferMs ? this.stats.inferMs * 0.9 + dt * 0.1 : dt;
      this.runTimes.push(now);
      while (this.runTimes.length && this.runTimes[0] < now - 1000) this.runTimes.shift();
      this.stats.hz = this.runTimes.length;

      this.lastRaw = raw;
      this.lastFace = face;
      this.pending.push(...this.gaze.process(raw).events);
      for (const cb of this.rawListeners) cb(raw);
    }
    this.schedule();
  }
}

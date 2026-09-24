import { config as defaultConfig, type Config } from '../../config';
import { GazeProcessor } from '../gaze';
import type { EyeEvent, EyeSource, EyeState, Fixture, RawFrame } from '../types';

/** Проигрывает RawFrame фикстуры в реальном времени через тот же GazeProcessor, что и трекер. */
export class ReplaySource implements EyeSource {
  readonly kind = 'replay' as const;
  readonly gaze: GazeProcessor;
  private i = 0;
  private startAt: number | null = null;
  private pending: EyeEvent[] = [];
  private rawListeners = new Set<(f: RawFrame) => void>();
  lastRaw: RawFrame | null = null;

  constructor(
    readonly fixture: Fixture,
    cfg: Config = defaultConfig,
  ) {
    this.gaze = new GazeProcessor(fixture.meta.profile, cfg);
  }

  get done(): boolean {
    return this.i >= this.fixture.frames.length;
  }

  onRaw(cb: (f: RawFrame) => void): () => void {
    this.rawListeners.add(cb);
    return () => this.rawListeners.delete(cb);
  }

  async start(): Promise<void> {
    this.startAt = null;
  }

  stop(): void {}

  poll(now: number): EyeState {
    this.startAt ??= now;
    const frames = this.fixture.frames;
    const t0 = frames[0]?.t ?? 0;
    const elapsed = now - this.startAt;
    while (this.i < frames.length && frames[this.i].t - t0 <= elapsed) {
      const f = frames[this.i++];
      this.pending.push(...this.gaze.process(f).events);
      this.lastRaw = f;
      for (const cb of this.rawListeners) cb(f);
    }
    const events = this.pending;
    this.pending = [];
    return { ...this.gaze.current, events };
  }
}

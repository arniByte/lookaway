import type { Fixture, FixtureMeta, RawFrame } from './types';

/** Копит RawFrame с временем от начала записи. Кадры в памяти, наружу — только через сохранение файла. */
export class Recorder {
  private frames: RawFrame[] = [];
  private t0 = 0;
  active = false;

  begin(t0: number): void {
    this.frames = [];
    this.t0 = t0;
    this.active = true;
  }

  push(f: RawFrame): void {
    if (this.active) this.frames.push({ ...f, t: f.t - this.t0 });
  }

  finish(meta: Omit<FixtureMeta, 'durationMs' | 'recordedAt'>, durationMs: number): Fixture {
    this.active = false;
    return {
      version: 1,
      meta: { ...meta, durationMs, recordedAt: new Date().toISOString() },
      frames: this.frames.filter((f) => f.t >= 0 && f.t <= durationMs),
    };
  }
}

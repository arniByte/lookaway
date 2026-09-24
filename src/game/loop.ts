import type { EyeEvent } from '../input/types';

/**
 * Фиксированный шаг симуляции поверх переменной частоты кадров.
 * События EyeState копятся и уходят в первый шаг после прихода: кадр без шагов их не теряет.
 */
export class FixedStep {
  private acc = 0;
  private pending: EyeEvent[] = [];

  constructor(
    readonly stepMs: number,
    readonly maxFrameMs: number,
  ) {}

  advance(frameMs: number, events: readonly EyeEvent[], step: (events: EyeEvent[], dtMs: number) => void): number {
    this.pending.push(...events);
    this.acc += Math.min(Math.max(frameMs, 0), this.maxFrameMs);
    let n = 0;
    while (this.acc >= this.stepMs) {
      this.acc -= this.stepMs;
      const ev = this.pending;
      this.pending = [];
      step(ev, this.stepMs);
      n++;
    }
    return n;
  }
}

import type { EyeEvent } from './types';

export type LidPhase = 'open' | 'blink' | 'closed';

export interface LidParams {
  onThreshold: number;
  offThreshold: number;
  confirmFrames: number;
  closedMs: number;
}

/**
 * Автомат век. Любое смыкание начинается как blink; дольше closedMs — становится closed.
 * open → blink: blinkStart; blink → open: blinkEnd; blink → closed: closeStart; closed → open: closeEnd.
 */
export class LidMachine {
  phase: LidPhase = 'open';
  shutAt = 0;
  lastOpenAt = -Infinity;
  private over = 0;

  constructor(public params: LidParams) {}

  /** score: 0 = открыты, 1 = закрыты. */
  update(score: number, t: number, events: EyeEvent[]): LidPhase {
    const p = this.params;
    switch (this.phase) {
      case 'open':
        this.over = score >= p.onThreshold ? this.over + 1 : 0;
        if (this.over >= p.confirmFrames) {
          this.over = 0;
          this.phase = 'blink';
          this.shutAt = t;
          events.push('blinkStart');
        }
        break;
      case 'blink':
        if (score <= p.offThreshold) {
          this.phase = 'open';
          this.lastOpenAt = t;
          events.push('blinkEnd');
        } else if (t - this.shutAt >= p.closedMs) {
          this.phase = 'closed';
          events.push('closeStart');
        }
        break;
      case 'closed':
        if (score <= p.offThreshold) {
          this.phase = 'open';
          this.lastOpenAt = t;
          events.push('closeEnd');
        }
        break;
    }
    return this.phase;
  }

  /** Закрыть открытый интервал парным событием (перед signalLost). */
  reset(t: number, events: EyeEvent[]): void {
    if (this.phase === 'blink') events.push('blinkEnd');
    if (this.phase === 'closed') events.push('closeEnd');
    if (this.phase !== 'open') this.lastOpenAt = t;
    this.phase = 'open';
    this.over = 0;
  }
}

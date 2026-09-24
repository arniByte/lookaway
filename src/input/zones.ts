import type { EyeEvent, Zone } from './types';

export interface ZoneParams {
  boundary: number; // граница C/L и C/R по |x|
  hysteresis: number; // вход в зону дальше границы на h, выход — ближе на h
  dwellMs: number; // сколько кандидат должен продержаться до смены
}

export class ZoneTracker {
  zone: Zone = 'C';
  private candidate: Zone | null = null;
  private since = 0;

  constructor(public params: ZoneParams) {}

  private target(x: number): Zone {
    const { boundary: b, hysteresis: h } = this.params;
    if (x > b + h) return 'R';
    if (x < -b - h) return 'L';
    if (this.zone === 'R' && x > b - h) return 'R';
    if (this.zone === 'L' && x < -b + h) return 'L';
    return 'C';
  }

  update(x: number, t: number, events: EyeEvent[]): Zone {
    const target = this.target(x);
    if (target === this.zone) {
      this.candidate = null;
      return this.zone;
    }
    if (this.candidate !== target) {
      this.candidate = target;
      this.since = t;
    }
    if (t - this.since >= this.params.dwellMs) {
      this.zone = target;
      this.candidate = null;
      events.push('zoneChange');
    }
    return this.zone;
  }
}

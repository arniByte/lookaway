import { config } from '../../config';
import { initialEyeState } from '../gaze';
import { LidMachine } from '../lid';
import type { EyeEvent, EyeSource, EyeState } from '../types';
import { ZoneTracker } from '../zones';

/**
 * Мышь = взгляд, Space = моргание, удержание C = закрытые глаза, удержание L = потеря сигнала.
 * Веки идут через тот же LidMachine, что и трекер: последовательности событий одинаковые.
 */
export class FallbackSource implements EyeSource {
  readonly kind = 'fallback' as const;
  private mouse = { x: 0, y: 0 };
  private blinkUntil = -Infinity;
  private closeHeld = false;
  private lostHeld = false;
  private lost = false;
  private lid = new LidMachine({
    onThreshold: config.lid.onThreshold,
    offThreshold: config.lid.offThreshold,
    confirmFrames: 1,
    closedMs: config.lid.closedMsDefault,
  });
  private zones = new ZoneTracker({ ...config.zones, dwellMs: config.fallback.zoneDwellMs });
  private state: EyeState = initialEyeState(0, false);

  private onMove = (e: PointerEvent) => {
    this.mouse = { x: (e.clientX / innerWidth) * 2 - 1, y: 1 - (e.clientY / innerHeight) * 2 };
  };

  private onKey = (e: KeyboardEvent) => {
    const down = e.type === 'keydown';
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (down && !e.repeat) this.blinkUntil = performance.now() + config.fallback.blinkMs;
        break;
      case 'KeyC':
        this.closeHeld = down;
        break;
      case 'KeyL':
        this.lostHeld = down;
        break;
    }
  };

  private onBlur = () => {
    this.closeHeld = false;
    this.lostHeld = false;
  };

  async start(): Promise<void> {
    addEventListener('pointermove', this.onMove);
    addEventListener('keydown', this.onKey);
    addEventListener('keyup', this.onKey);
    addEventListener('blur', this.onBlur);
  }

  stop(): void {
    removeEventListener('pointermove', this.onMove);
    removeEventListener('keydown', this.onKey);
    removeEventListener('keyup', this.onKey);
    removeEventListener('blur', this.onBlur);
    this.onBlur();
  }

  poll(now: number): EyeState {
    const events: EyeEvent[] = [];
    if (this.lostHeld !== this.lost) {
      if (this.lostHeld) this.lid.reset(now, events);
      this.lost = this.lostHeld;
      events.push(this.lost ? 'signalLost' : 'signalBack');
    }
    if (this.lost) {
      this.state = { ...this.state, t: now, confidence: 0, lost: true, blink: false, closed: false, events };
      return this.state;
    }

    const shut = now < this.blinkUntil || this.closeHeld;
    const phase = this.lid.update(shut ? 1 : 0, now, events);
    let { gaze, zone } = this.state;
    if (phase === 'open') {
      gaze = { ...this.mouse };
      zone = this.zones.update(gaze.x, now, events);
    }
    this.state = {
      t: now,
      confidence: 1,
      lost: false,
      gaze,
      zone,
      blink: phase === 'blink',
      closed: phase === 'closed',
      wink: null,
      wide: 0,
      squint: 0,
      events,
    };
    return this.state;
  }
}

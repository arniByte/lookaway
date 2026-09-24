// Сигналы калибровки и протоколов: с закрытыми глазами игрок слышит, но не видит.
// Идут через общий движок (engine.ts): контекст разбужен первым кликом, а не после запуска камеры.
import { audio } from './engine';

/** Мягкий тон: синус + октава, атака без щелчка, хвост в реверберацию. */
export function beep(freq = 880, ms = 110, delayS = 0, level = 0.28): void {
  const e = audio();
  if (!e) return;
  const { ctx } = e;
  if (ctx.state !== 'running') void ctx.resume();
  const t = ctx.currentTime + 0.01 + delayS;
  const dur = ms / 1000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(level, t + 0.008);
  g.gain.exponentialRampToValueAtTime(level * 0.5, t + dur * 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
  const send = ctx.createGain();
  send.gain.value = 0.35;
  g.connect(e.bus);
  g.connect(send).connect(e.send);
  for (const [mul, amp] of [[1, 1], [2, 0.18]] as const) {
    const o = ctx.createOscillator();
    o.frequency.value = freq * mul;
    const og = ctx.createGain();
    og.gain.value = amp;
    o.connect(og).connect(g);
    o.start(t);
    o.stop(t + dur + 0.3);
  }
}

export const doubleBeep = (): void => {
  beep(660, 90, 0);
  beep(880, 110, 0.16);
};

/** Именованные сигналы калибровки: разные по высоте, чтобы различались с закрытыми глазами. */
export const cue = {
  point: () => beep(1320, 45, 0, 0.16),
  blink: () => beep(880, 120),
  close: () => beep(392, 260, 0, 0.32),
  open: () => doubleBeep(),
  done: () => {
    beep(660, 120, 0, 0.2);
    beep(990, 160, 0.12, 0.2);
  },
};

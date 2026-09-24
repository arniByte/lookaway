// Звуковые сигналы для калибровки и протоколов: с закрытыми глазами игрок слышит, но не видит.
let ctx: AudioContext | null = null;

/** Вызывать из обработчика клика: браузер разрешает звук только после жеста. */
export function unlockAudio(): void {
  ctx ??= new AudioContext();
  void ctx.resume();
}

export function beep(freq = 880, ms = 90, delayS = 0): void {
  if (!ctx) return;
  const t = ctx.currentTime + delayS;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}

export const doubleBeep = (): void => {
  beep(660, 80, 0);
  beep(660, 80, 0.16);
};

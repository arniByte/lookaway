// Сканер: заряд и перезарядка (GDD → Основной цикл). Чистая логика.
import { config as defaultConfig, type Config } from '../config';

export interface Scanner {
  charge: number; // 0..1
  pulses: number;
}

export const createScanner = (): Scanner => ({ charge: 1, pulses: 0 });

/** С закрытыми глазами заряжается быстрее: отдых за слепоту. */
export function chargeScanner(s: Scanner, dtMs: number, eyesClosed: boolean, cfg: Config = defaultConfig): void {
  const mul = eyesClosed ? cfg.scanner.closedRechargeMul : 1;
  s.charge = Math.min(1, s.charge + (dtMs / cfg.scanner.cooldownMs) * mul);
}

export function tryPulse(s: Scanner): boolean {
  if (s.charge < 1) return false;
  s.charge = 0;
  s.pulses++;
  return true;
}

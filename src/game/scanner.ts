// Сканер (GDD → Основной цикл): заряд, накопление импульса с закрытыми глазами, выпуск на открытии.
// Чистая логика.
import { config as defaultConfig, type Config } from '../config';

export interface Scanner {
  charge: number; // 0..1
  hold: number; // мс с закрытыми глазами при полном заряде: копит дальность
  pulses: number;
}

export const createScanner = (): Scanner => ({ charge: 1, hold: 0, pulses: 0 });

/** charging — глаза закрыты (или зажата кнопка без камеры): заряд быстрее, копится дальность. */
export function chargeScanner(s: Scanner, dtMs: number, charging: boolean, cfg: Config = defaultConfig): void {
  const ready = s.charge >= 1;
  const mul = charging ? cfg.scanner.closedRechargeMul : 1;
  s.charge = Math.min(1, s.charge + (dtMs / cfg.scanner.cooldownMs) * mul);
  if (charging && ready) s.hold += dtMs;
}

/** 0..1 — накопленная мощность. */
export const scanPower = (s: Scanner, cfg: Config = defaultConfig): number => Math.min(1, s.hold / cfg.scanner.holdFullMs);

/** Глаза открылись: импульс, если заряжен. Возвращает мощность или null. Накопление сбрасывается всегда. */
export function releasePulse(s: Scanner, cfg: Config = defaultConfig): number | null {
  const power = scanPower(s, cfg);
  s.hold = 0;
  if (s.charge < 1) return null;
  s.charge = 0;
  s.pulses++;
  return power;
}

/** Дальность импульса, м. */
export function pulseRange(power: number, documented: number, cfg: Config = defaultConfig): number {
  const c = cfg.scanner;
  return c.rangeMin + (c.rangeMax - c.rangeMin) * Math.min(1, Math.max(0, power)) + c.rangePerSpecies * documented;
}

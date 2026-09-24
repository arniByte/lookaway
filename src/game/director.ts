// Директор напряжения (GDD → Угроза): решает, что делает силуэт. Ритм как в хорошем хорроре —
// нагнетание, пик, передышка. Напряжение растёт со временем, образцами, закрытыми глазами, близостью;
// близкий контакт (скан поймал его рядом) — передышка: он отступает, чтобы было куда нагнетать снова.
// Все виды описаны — охота до маяка. Чистая логика.
import { config as defaultConfig, type Config } from '../config';
import type { StalkerMode } from './stalker';

export interface Director {
  tension: number; // 0..1
  phase: 'build' | 'relax';
  relaxUntil: number;
  reveals: number;
  documented: number;
}

export interface DirectorCtx {
  time: number; // мс забега
  dtMs: number;
  awake: boolean;
  stalkerDist: number;
  documented: number;
  extractReady: boolean;
  studying: boolean;
  eyesClosed: boolean;
  stillMs: number; // сколько игрок стоит на месте
}

export const createDirector = (): Director => ({ tension: 0, phase: 'build', relaxUntil: 0, reveals: 0, documented: 0 });

/** Импульс шумит: напряжение чуть выше. */
export function onPulse(d: Director, cfg: Config = defaultConfig): void {
  d.tension = Math.min(1, d.tension + cfg.director.perPulse);
}

/** Скан поймал его рядом: передышка (кроме финальной охоты). */
export function onReveal(d: Director, time: number, cfg: Config = defaultConfig): void {
  d.reveals++;
  d.phase = 'relax';
  d.relaxUntil = time + cfg.director.relaxMs;
  d.tension = Math.max(0.15, d.tension - 0.35);
}

export function stepDirector(d: Director, ctx: DirectorCtx, cfg: Config = defaultConfig): { mode: StalkerMode; desiredDist: number } {
  const dc = cfg.director;
  const dt = ctx.dtMs / 1000;
  if (ctx.documented > d.documented) {
    d.tension = Math.min(1, d.tension + dc.perSpecies * (ctx.documented - d.documented));
    d.documented = ctx.documented;
  }
  if (d.phase === 'relax' && ctx.time >= d.relaxUntil) d.phase = 'build';
  if (d.phase === 'relax') {
    d.tension = Math.max(0, d.tension - dc.relaxDecay * dt);
  } else {
    const rate = dc.base + (ctx.studying ? dc.study : 0) + (ctx.eyesClosed ? dc.closed : 0) + (ctx.stalkerDist < dc.nearDist ? dc.near : 0);
    d.tension = Math.min(1, d.tension + rate * dt);
  }

  if (!ctx.awake) return { mode: 'dormant', desiredDist: dc.farDist };
  if (ctx.extractReady) return { mode: 'hunt', desiredDist: 0 };
  if (d.phase === 'relax') return { mode: ctx.stalkerDist < dc.farDist - 5 ? 'retreat' : 'stalk', desiredDist: dc.farDist };
  const desired = dc.farDist + (dc.nearDist2 - dc.farDist) * d.tension;
  if (ctx.time < dc.graceMs) return { mode: 'stalk', desiredDist: Math.max(desired, 35) };
  const approach = d.tension >= dc.approachAt || (ctx.studying && d.tension >= dc.studyApproachAt) || ctx.stillMs >= dc.stillMs;
  return approach ? { mode: 'approach', desiredDist: 5 } : { mode: 'stalk', desiredDist: desired };
}

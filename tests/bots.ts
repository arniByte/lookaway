// Боты для проверки баланса без людей: EyeState по стратегии + физиология моргания.
import { config } from '../src/config';
import { createGame, isPinned, stepGame, type GameEvent, type GameState } from '../src/game/sim';
import type { EyeEvent, EyeState, Zone } from '../src/input/types';
import { mulberry32 } from './synthetic';

export type Strategy = (g: GameState, t: number) => Zone;

export const idle: Strategy = () => 'C';

export const rotate =
  (periodMs = 1500): Strategy =>
  (_g, t) => (['L', 'C', 'R'] as const)[Math.floor(t / periodMs) % 3];

/**
 * Светит на ближайшего. Знает все дистанции — верхняя граница для человека.
 * Решает раз в reactionMs и не перещёлкивается, пока другой не ближе на marginM.
 */
export function greedy(reactionMs = 400, marginM = 1): Strategy {
  let zone: Zone = 'C';
  let nextAt = 0;
  return (g, t) => {
    if (t >= nextAt) {
      nextAt = t + reactionMs;
      const cur = g.mannequins.find((m) => m.lane === zone)!;
      const best = [...g.mannequins].sort((a, b) => a.dist - b.dist)[0];
      if (best.dist < cur.dist - marginM) zone = best.lane;
    }
    return zone;
  };
}

export interface BotOptions {
  seed: number;
  blinksPerMin: number;
  strategy: Strategy;
  blinkMs?: number;
  /** Закрывать глаза на closeMs каждые closeEveryMs (скан). */
  closeEveryMs?: number;
  closeMs?: number;
  maxMs?: number;
  /** Моргать намеренно, когда кто-то пригвождён (и сбрасывать таймер непроизвольного моргания). */
  voluntary?: boolean;
}

export interface BotResult {
  won: boolean;
  timeMs: number;
  events: GameEvent[];
  game: GameState;
}

export function runBot(o: BotOptions): BotResult {
  const dt = 1000 / config.game.simHz;
  const g = createGame(o.seed);
  const rnd = mulberry32(o.seed ^ 0x9e3779b9);
  const blinkMs = o.blinkMs ?? 150;
  const closedMs = config.lid.closedMsDefault;
  const meanGap = 60_000 / Math.max(o.blinksPerMin, 1e-6);
  let nextBlink = -Math.log(1 - rnd()) * meanGap;
  let shutUntil = -1;
  let shutFrom = -1;
  let closedFlag = false;
  let nextClose = o.closeEveryMs ?? Infinity;
  const all: GameEvent[] = [];
  let t = 0;
  const maxMs = o.maxMs ?? config.game.surviveMs + 5000;

  while (t < maxMs && (g.phase === 'play' || g.phase === 'paused')) {
    t += dt;
    const events: EyeEvent[] = [];
    const shut = t < shutUntil;
    if (!shut && shutUntil > 0 && t - dt < shutUntil) {
      events.push(closedFlag ? 'closeEnd' : 'blinkEnd');
      closedFlag = false;
    }
    if (!shut && t >= nextClose) {
      shutFrom = t;
      shutUntil = t + (o.closeMs ?? 1500);
      nextClose += o.closeEveryMs ?? Infinity;
      events.push('blinkStart');
    } else if (!shut && o.voluntary && t - shutUntil > 800 && g.mannequins.some((m) => isPinned(g, m))) {
      shutFrom = t;
      shutUntil = t + blinkMs;
      nextBlink = t + blinkMs - Math.log(1 - rnd()) * meanGap;
      events.push('blinkStart');
    } else if (!shut && t >= nextBlink) {
      shutFrom = t;
      shutUntil = t + blinkMs;
      nextBlink = t + blinkMs - Math.log(1 - rnd()) * meanGap;
      events.push('blinkStart');
    }
    const nowShut = t < shutUntil;
    if (nowShut && !closedFlag && t - shutFrom >= closedMs) {
      closedFlag = true;
      events.push('closeStart');
    }
    const zone = o.strategy(g, t);
    const x = zone === 'L' ? -2 / 3 : zone === 'R' ? 2 / 3 : 0;
    const eye: EyeState = {
      t,
      confidence: 1,
      lost: false,
      gaze: { x, y: 0 },
      zone,
      blink: nowShut && !closedFlag,
      closed: nowShut && closedFlag,
      wink: null,
      wide: 0,
      squint: 0,
      events,
    };
    stepGame(g, eye, events, dt, all);
  }
  return { won: g.phase === 'won', timeMs: g.t, events: all, game: g };
}

/** strategy — фабрика: у стратегий есть состояние, на каждый сид нужен свой экземпляр. */
export function survey(
  opts: Omit<BotOptions, 'seed' | 'strategy'> & { strategy: () => Strategy },
  seeds = 40,
): { winRate: number; medianMs: number } {
  const rs = Array.from({ length: seeds }, (_, i) => runBot({ ...opts, strategy: opts.strategy(), seed: 1000 + i }));
  const times = rs.map((r) => r.timeMs).sort((a, b) => a - b);
  return { winRate: rs.filter((r) => r.won).length / seeds, medianMs: times[seeds >> 1] };
}

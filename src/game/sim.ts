// Симуляция грейбокса. Чистая и детерминированная: seed + поток EyeState → исход (TECH → Директор).
// Читает только EyeState (CLAUDE.md, правило 1). Рендер и звук реагируют на GameEvent.
import { config as defaultConfig, type Config } from '../config';
import type { EyeEvent, EyeState, Zone } from '../input/types';
import { LANES, laneX } from './level';
import { nextRandom, randRange } from './rng';

export interface Mannequin {
  lane: Zone;
  dist: number; // м от игрока
  pose: number; // 0..1, дискретная поза; меняется только вне света (GDD → Враги)
  lit: boolean;
  litSince: number; // с какого t под светом непрерывно
  nextStepAt: number;
}

export interface ScanEcho {
  lane: Zone;
  dist: number;
  pose: number;
}

export type Phase = 'play' | 'paused' | 'dead' | 'won';

export interface GameState {
  t: number; // игровое время, мс; стоит на паузе
  phase: Phase;
  rng: number;
  beam: { x: number; y: number; on: boolean };
  mannequins: Mannequin[];
  scan: {
    active: boolean;
    sweeps: number;
    range: number;
    nextSweepAt: number;
    lastSweepAt: number;
    snapshot: ScanEcho[] | null; // позиции на последнем импульсе
  };
  afterimageUntil: number;
  killer: Zone | null;
  endedAt: number;
  stats: { blinks: number; closes: number; sweeps: number; pushes: number };
}

export type GameEvent =
  | { kind: 'step'; lane: Zone; dist: number; cause: 'walk' | 'blink' }
  | { kind: 'push'; lane: Zone; dist: number }
  | { kind: 'pinned'; lane: Zone }
  | { kind: 'ping'; range: number }
  | { kind: 'echo'; lane: Zone; dist: number; delayMs: number }
  | { kind: 'afterimage' }
  | { kind: 'death'; lane: Zone }
  | { kind: 'win' }
  | { kind: 'pause' }
  | { kind: 'resume' };

export function createGame(seed: number, cfg: Config = defaultConfig): GameState {
  const g: GameState = {
    t: 0,
    phase: 'play',
    rng: seed >>> 0,
    beam: { x: 0, y: 0, on: true },
    mannequins: [],
    scan: { active: false, sweeps: 0, range: 0, nextSweepAt: 0, lastSweepAt: -Infinity, snapshot: null },
    afterimageUntil: -Infinity,
    killer: null,
    endedAt: 0,
    stats: { blinks: 0, closes: 0, sweeps: 0, pushes: 0 },
  };
  const gc = cfg.game;
  g.mannequins = LANES.map((lane) => ({
    lane,
    dist: randRange(g, gc.startDist),
    pose: nextRandom(g),
    lit: false,
    litSince: 0,
    nextStepAt: gc.startGraceMs + randRange(g, gc.stepIntervalMs),
  }));
  return g;
}

export const nearestDist = (g: GameState): number => Math.min(...g.mannequins.map((m) => m.dist));

export const isPinned = (g: GameState, m: Mannequin, cfg: Config = defaultConfig): boolean =>
  m.lit && g.t - m.litSince >= cfg.game.pinMs;

function step(g: GameState, m: Mannequin, len: number, floor: number, cause: 'walk' | 'blink', out: GameEvent[]): void {
  const next = Math.max(m.dist - len, floor);
  if (next >= m.dist) return;
  m.dist = next;
  m.pose = nextRandom(g);
  out.push({ kind: 'step', lane: m.lane, dist: m.dist, cause });
}

function endScan(g: GameState, out: GameEvent[], cfg: Config): void {
  if (g.scan.active && g.scan.sweeps > 0) {
    g.afterimageUntil = g.t + cfg.game.scan.afterimageMs;
    out.push({ kind: 'afterimage' });
  }
  g.scan.active = false;
}

/** Один фиксированный шаг симуляции. events — события EyeState, пришедшие к этому шагу. */
export function stepGame(
  g: GameState,
  eye: EyeState,
  events: readonly EyeEvent[],
  dtMs: number,
  out: GameEvent[],
  cfg: Config = defaultConfig,
): void {
  if (g.phase === 'dead' || g.phase === 'won') return;
  const gc = cfg.game;

  // Потеря сигнала — пауза. Никогда не трактуется как закрытые глаза и никогда не убивает.
  if (eye.lost) {
    if (g.phase === 'play') {
      g.phase = 'paused';
      g.scan.active = false;
      out.push({ kind: 'pause' });
    }
    return;
  }
  if (g.phase === 'paused') {
    g.phase = 'play';
    for (const m of g.mannequins) m.nextStepAt = Math.max(m.nextStepAt, g.t + gc.resumeGraceMs);
    out.push({ kind: 'resume' });
  }

  g.t += dtMs;

  for (const e of events) {
    switch (e) {
      case 'blinkStart':
        // Blink-cut: всё коммитится в этом тике (TECH → Латентность).
        // Пригвождённый светом отступает, остальные получают «бесплатный шаг».
        g.stats.blinks++;
        for (const m of g.mannequins) {
          if (isPinned(g, m, cfg)) {
            m.dist = Math.min(m.dist + gc.pushBack, gc.startDist[1]);
            m.pose = nextRandom(g);
            m.litSince = g.t;
            g.stats.pushes++;
            out.push({ kind: 'push', lane: m.lane, dist: m.dist });
          } else {
            step(g, m, gc.blinkStepLen, gc.killDist + gc.blinkSafeMargin, 'blink', out);
          }
          m.nextStepAt = Math.max(m.nextStepAt, g.t + gc.unlitGraceMs);
        }
        break;
      case 'closeStart':
        g.stats.closes++;
        g.scan.active = true;
        g.scan.sweeps = 0;
        g.scan.range = 0;
        g.scan.nextSweepAt = g.t + gc.scan.firstSweepMs;
        break;
      case 'closeEnd':
        endScan(g, out, cfg);
        break;
    }
  }
  // Страховка: скан живёт, только пока глаза закрыты, даже если closeEnd потерялся (смена источника).
  if (g.scan.active && !eye.closed) endScan(g, out, cfg);

  // Луч: цель — центр зоны плюс доля остаточного шума взгляда, с инерцией.
  const shut = eye.blink || eye.closed;
  g.beam.on = !shut;
  if (!shut) {
    const center = laneX(eye.zone, cfg);
    const tx = center + (eye.gaze.x - center) * gc.beamShake;
    const k = 1 - Math.exp(-dtMs / gc.beamTauMs);
    g.beam.x += (tx - g.beam.x) * k;
    g.beam.y += (eye.gaze.y * gc.beamYMix - g.beam.y) * k;
  }

  for (const m of g.mannequins) {
    const wasPinned = isPinned(g, m, cfg);
    const lit = g.beam.on && Math.abs(g.beam.x - laneX(m.lane, cfg)) < gc.litHalfWidth;
    if (lit && !m.lit) m.litSince = g.t;
    m.lit = lit;
    if (!wasPinned && isPinned(g, m, cfg)) out.push({ kind: 'pinned', lane: m.lane });
    if (m.lit) {
      m.nextStepAt = Math.max(m.nextStepAt, g.t + gc.unlitGraceMs);
    } else if (g.t >= m.nextStepAt) {
      step(g, m, gc.stepLen, 0, 'walk', out);
      m.nextStepAt = g.t + randRange(g, gc.stepIntervalMs);
    }
    if (m.dist <= gc.killDist) {
      g.phase = 'dead';
      g.killer = m.lane;
      g.endedAt = g.t;
      g.scan.active = false;
      out.push({ kind: 'death', lane: m.lane });
      return;
    }
  }

  if (g.scan.active && g.t >= g.scan.nextSweepAt) {
    const s = g.scan;
    s.sweeps++;
    g.stats.sweeps++;
    s.range = gc.scan.baseRange + (s.sweeps - 1) * gc.scan.rangePerSweep;
    s.lastSweepAt = g.t;
    s.nextSweepAt += gc.scan.sweepMs;
    s.snapshot = g.mannequins.filter((m) => m.dist <= s.range).map((m) => ({ lane: m.lane, dist: m.dist, pose: m.pose }));
    out.push({ kind: 'ping', range: s.range });
    for (const e of s.snapshot) {
      out.push({ kind: 'echo', lane: e.lane, dist: e.dist, delayMs: gc.scan.echoBaseMs + e.dist * gc.scan.echoMsPerMeter });
    }
  }

  if (g.t >= gc.surviveMs) {
    g.phase = 'won';
    g.endedAt = g.t;
    out.push({ kind: 'win' });
  }
}

import { config as defaultConfig, type Config } from '../config';
import { GazeProcessor } from './gaze';
import type { Cue, EyeEvent, EyeState, Fixture } from './types';

export interface TimedEvent {
  t: number;
  e: EyeEvent;
}

export interface RunResult {
  states: EyeState[];
  events: TimedEvent[];
}

export function runFixture(fx: Fixture, cfg: Config = defaultConfig): RunResult {
  const gp = new GazeProcessor(fx.meta.profile, cfg);
  const states: EyeState[] = [];
  const events: TimedEvent[] = [];
  for (const f of fx.frames) {
    const s = gp.process(f);
    states.push(s);
    for (const e of s.events) events.push({ t: s.t, e });
  }
  return { states, events };
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Report {
  protocol: string;
  ok: boolean;
  checks: Check[];
  info: string[];
}

const times = (evs: TimedEvent[], e: EyeEvent) => evs.filter((x) => x.e === e).map((x) => x.t);
const inWindow = (t: number, a: number, b: number) => t >= a && t <= b;

function stateAt(states: EyeState[], t: number): EyeState | undefined {
  let found: EyeState | undefined;
  for (const s of states) {
    if (s.t > t) break;
    found = s;
  }
  return found;
}

/** Окна для cue и сколько cue поймано хотя бы одним событием. */
function matchCues(cues: Cue[], ts: number[], win: (c: Cue) => [number, number]) {
  const windows = cues.map(win);
  const hits = windows.filter(([a, b]) => ts.some((t) => inWindow(t, a, b))).length;
  const extras = ts.filter((t) => !windows.some(([a, b]) => inWindow(t, a, b))).length;
  return { hits, extras, windows };
}

export function evaluate(fx: Fixture, cfg: Config = defaultConfig): Report {
  const acc = cfg.acceptance;
  const { states, events } = runFixture(fx, cfg);
  const cues = fx.meta.cues;
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  const blinkStarts = times(events, 'blinkStart');
  const closeStarts = times(events, 'closeStart');
  const lostTs = times(events, 'signalLost');
  const minutes = fx.meta.durationMs / 60_000;
  const info = [
    `кадров ${fx.frames.length}, ${(fx.frames.length / Math.max(fx.meta.durationMs / 1000, 1e-3)).toFixed(1)} Гц`,
    `blinkStart ${blinkStarts.length} (${(blinkStarts.length / Math.max(minutes, 1e-3)).toFixed(1)}/мин), closeStart ${closeStarts.length}, signalLost ${lostTs.length}, zoneChange ${times(events, 'zoneChange').length}`,
  ];

  switch (fx.meta.protocol) {
    case 'calm':
      check('closeStart = 0', closeStarts.length === 0, `${closeStarts.length}`);
      check('signalLost = 0', lostTs.length === 0, `${lostTs.length}`);
      break;

    case 'blinks': {
      const m = matchCues(cues, blinkStarts, (c) => [c.t, c.t + acc.blinkWindowMs]);
      const need = Math.ceil(cues.length * acc.blinkRecall);
      check(`поймано ≥ ${need}/${cues.length}`, m.hits >= need, `${m.hits}/${cues.length}`);
      check(`лишних ≤ ${acc.blinkExtraMax}`, m.extras <= acc.blinkExtraMax, `${m.extras}`);
      check('closeStart = 0', closeStarts.length === 0, `${closeStarts.length}`);
      break;
    }

    case 'zones': {
      let right = 0;
      let expected = 0;
      let prev = 'C';
      const misses: string[] = [];
      for (const c of cues) {
        const s = stateAt(states, c.t + acc.zoneCheckAfterMs);
        if (s && !s.lost && s.zone === c.zone) right++;
        else misses.push(`${(c.t / 1000).toFixed(1)}s ${c.zone}→${s?.lost ? 'lost' : (s?.zone ?? '?')}`);
        if (c.zone !== prev) expected++;
        prev = c.zone ?? prev;
      }
      const need = Math.ceil(cues.length * acc.zoneAccuracy);
      const changes = times(events, 'zoneChange').length;
      const maxChanges = Math.ceil(expected * acc.zoneChangeMaxRatio);
      check(`зона верна ≥ ${need}/${cues.length}`, right >= need, `${right}/${cues.length}${misses.length ? ` (${misses.join(', ')})` : ''}`);
      check(`смен зоны ≤ ${maxChanges}`, changes <= maxChanges, `${changes} (нужно ${expected})`);
      break;
    }

    case 'closed': {
      const m = matchCues(cues, closeStarts, (c) => [c.t, c.t + (c.durMs ?? 0) + acc.closeWindowExtraMs]);
      check(`closeStart на ${cues.length}/${cues.length}`, m.hits === cues.length, `${m.hits}/${cues.length}`);
      check('лишних closeStart = 0', m.extras === 0, `${m.extras}`);
      break;
    }

    case 'lost': {
      const m = matchCues(cues, lostTs, (c) => [c.t, c.t + acc.lostWindowMs]);
      const covered = closeStarts.filter((t) =>
        cues.some((c) => inWindow(t, c.t, c.t + (c.durMs ?? 0) + acc.closeWindowExtraMs)),
      ).length;
      check(`signalLost на ${cues.length}/${cues.length}`, m.hits === cues.length, `${m.hits}/${cues.length}`);
      check('closeStart под рукой = 0', covered === 0, `${covered}`);
      break;
    }
  }

  return { protocol: fx.meta.protocol, ok: checks.every((c) => c.pass), checks, info };
}

export function formatReport(r: Report): string {
  const lines = [`[${r.ok ? 'OK' : 'FAIL'}] ${r.protocol}`];
  for (const c of r.checks) lines.push(`  ${c.pass ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  for (const i of r.info) lines.push(`  · ${i}`);
  return lines.join('\n');
}

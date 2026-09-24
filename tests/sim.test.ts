import { describe, expect, it } from 'vitest';
import { config, type Config } from '../src/config';
import { FixedStep } from '../src/game/loop';
import { createGame, stepGame, type GameEvent, type GameState } from '../src/game/sim';
import { runFixture } from '../src/input/evaluate';
import type { EyeEvent, EyeState, Zone } from '../src/input/types';
import { synthProtocol } from './synthetic';

const DT = 1000 / 60;

function cfgWith(patch: (c: Config) => void): Config {
  const c = structuredClone(config);
  patch(c);
  return c;
}

const eyeOf = (zone: Zone, over: Partial<EyeState> = {}): EyeState => ({
  t: 0, confidence: 1, lost: false,
  gaze: { x: zone === 'L' ? -2 / 3 : zone === 'R' ? 2 / 3 : 0, y: 0 },
  zone, blink: false, closed: false, wink: null, wide: 0, squint: 0, events: [],
  ...over,
});

/** Прогон: ms миллисекунд с одним и тем же eye; events уходят в первый тик. */
function run(g: GameState, ms: number, eye: EyeState, events: EyeEvent[] = [], cfg: Config = config): GameEvent[] {
  const out: GameEvent[] = [];
  for (let t = 0; t < ms; t += DT) stepGame(g, eye, t === 0 ? events : [], DT, out, cfg);
  return out;
}

const byLane = (g: GameState, lane: Zone) => g.mannequins.find((m) => m.lane === lane)!;

describe('sim: свет и шаги', () => {
  it('детерминирована: тот же seed и вход → то же состояние', () => {
    const a = createGame(42);
    const b = createGame(42);
    for (const g of [a, b]) {
      run(g, 5000, eyeOf('L'));
      run(g, 200, eyeOf('L', { blink: true }), ['blinkStart']);
      run(g, 5000, eyeOf('R'), ['blinkEnd']);
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('освещённый стоит, неосвещённые идут', () => {
    const g = createGame(1);
    const l0 = byLane(g, 'L').dist;
    const c0 = byLane(g, 'C').dist;
    run(g, 15_000, eyeOf('L'));
    expect(byLane(g, 'L').dist).toBe(l0);
    expect(byLane(g, 'C').dist).toBeLessThan(c0 - 1);
  });

  it('моргание: бесплатный шаг всем непригвождённым, в этом же тике', () => {
    const g = createGame(2);
    run(g, 500, eyeOf('C'));
    const before = g.mannequins.map((m) => m.dist);
    const out: GameEvent[] = [];
    stepGame(g, eyeOf('C', { blink: true }), ['blinkStart'], DT, out);
    const steps = out.filter((e) => e.kind === 'step' && e.cause === 'blink');
    expect(steps).toHaveLength(3);
    g.mannequins.forEach((m, i) => expect(m.dist).toBeCloseTo(before[i] - config.game.blinkStepLen, 6));
  });

  it('моргание никогда не убивает напрямую', () => {
    const noWalk = cfgWith((c) => {
      c.game.stepIntervalMs = [1e9, 1e9];
    });
    const g = createGame(3, noWalk);
    for (let i = 0; i < 200; i++) {
      run(g, 50, eyeOf('C', { blink: true }), ['blinkStart'], noWalk);
      run(g, 50, eyeOf('C'), ['blinkEnd'], noWalk);
    }
    expect(g.phase).toBe('play');
    for (const m of g.mannequins) expect(m.dist).toBeGreaterThan(noWalk.game.killDist);
  });

  it('пригвождённый (≥ pinMs под светом) на моргании отступает', () => {
    const g = createGame(4);
    run(g, config.game.pinMs + 500, eyeOf('L'));
    const l = byLane(g, 'L');
    l.dist = 5;
    const out = run(g, DT, eyeOf('L', { blink: true }), ['blinkStart']);
    expect(out.some((e) => e.kind === 'push' && e.lane === 'L')).toBe(true);
    expect(l.dist).toBeCloseTo(5 + config.game.pushBack, 6);
    expect(g.stats.pushes).toBe(1);
  });

  it('не дольше pinMs под светом — моргание двигает вперёд', () => {
    const g = createGame(5);
    run(g, 300, eyeOf('R')); // луч доехал, но не пригвоздил
    const r0 = byLane(g, 'R').dist;
    const out = run(g, DT, eyeOf('R', { blink: true }), ['blinkStart']);
    expect(out.some((e) => e.kind === 'push')).toBe(false);
    expect(byLane(g, 'R').dist).toBeLessThan(r0);
  });

  it('смерть при подходе, дальше симуляция стоит', () => {
    const g = createGame(6);
    const out = run(g, 60_000, eyeOf('L'));
    expect(g.phase).toBe('dead');
    expect(g.killer).not.toBe('L');
    expect(out.filter((e) => e.kind === 'death')).toHaveLength(1);
    const frozen = JSON.stringify(g);
    run(g, 1000, eyeOf('C'));
    expect(JSON.stringify(g)).toBe(frozen);
  });

  it('рассвет: победа на surviveMs', () => {
    const quick = cfgWith((c) => {
      c.game.surviveMs = 3000;
    });
    const g = createGame(7, quick);
    const out = run(g, 4000, eyeOf('C'), [], quick);
    expect(g.phase).toBe('won');
    expect(out.filter((e) => e.kind === 'win')).toHaveLength(1);
  });
});

describe('sim: потеря сигнала', () => {
  it('пауза: время стоит, никто не двигается, смерти нет', () => {
    const g = createGame(8);
    run(g, 3000, eyeOf('C'));
    const snap = JSON.stringify(g.mannequins);
    const t = g.t;
    const out = run(g, 120_000, eyeOf('C', { lost: true }));
    expect(g.phase).toBe('paused');
    expect(g.t).toBe(t);
    expect(JSON.stringify(g.mannequins)).toBe(snap);
    expect(out.map((e) => e.kind)).toEqual(['pause']);
  });

  it('после возврата сигнала — фора resumeGraceMs', () => {
    const g = createGame(9);
    run(g, 3000, eyeOf('C'));
    run(g, 1000, eyeOf('C', { lost: true }));
    const out = run(g, config.game.resumeGraceMs - 100, eyeOf('C'));
    expect(out[0].kind).toBe('resume');
    expect(out.some((e) => e.kind === 'step')).toBe(false);
  });
});

describe('sim: эхо-скан', () => {
  it('импульсы только пока глаза закрыты, радиус растёт, эхо — от попавших в радиус', () => {
    const g = createGame(10);
    g.mannequins[0].dist = 3;
    g.mannequins[1].dist = 7;
    g.mannequins[2].dist = 11;
    const sc = config.game.scan;
    const out = run(g, sc.firstSweepMs + 2 * sc.sweepMs + 50, eyeOf('C', { closed: true }), ['closeStart']);
    const pings = out.filter((e) => e.kind === 'ping');
    expect(pings.map((p) => (p.kind === 'ping' ? p.range : 0))).toEqual([
      sc.baseRange, sc.baseRange + sc.rangePerSweep, sc.baseRange + 2 * sc.rangePerSweep,
    ]);
    const echoes = out.filter((e) => e.kind === 'echo');
    expect(echoes.length).toBeGreaterThanOrEqual(1 + 2 + 2); // ближний, потом двое, потом (если дошли) все
    const first = echoes[0];
    expect(first).toMatchObject({ lane: 'L', delayMs: sc.echoBaseMs + 3 * sc.echoMsPerMeter });
    const after = run(g, 2000, eyeOf('C')); // closeEnd потерялся — скан всё равно гаснет
    expect(after.filter((e) => e.kind === 'afterimage')).toHaveLength(1);
    expect(after.some((e) => e.kind === 'ping')).toBe(false);
  });

  it('послеобраз после открытия, только если был хотя бы один импульс', () => {
    const g = createGame(11);
    const sc = config.game.scan;
    run(g, sc.firstSweepMs - 50, eyeOf('C', { closed: true }), ['closeStart']);
    expect(run(g, DT, eyeOf('C'), ['closeEnd']).some((e) => e.kind === 'afterimage')).toBe(false);

    run(g, sc.firstSweepMs + 50, eyeOf('C', { closed: true }), ['closeStart']);
    const out = run(g, DT, eyeOf('C'), ['closeEnd']);
    expect(out.some((e) => e.kind === 'afterimage')).toBe(true);
    expect(g.afterimageUntil).toBeCloseTo(g.t + sc.afterimageMs, 0);
  });

  it('задержка эха растёт с дистанцией', () => {
    const g = createGame(12);
    g.mannequins[0].dist = 2;
    g.mannequins[1].dist = 3.5;
    g.mannequins[2].dist = 20;
    const out = run(g, config.game.scan.firstSweepMs + 50, eyeOf('C', { closed: true }), ['closeStart']);
    const d = out.flatMap((e) => (e.kind === 'echo' ? [e] : []));
    expect(d.map((e) => e.lane)).toEqual(['L', 'C']);
    expect(d[1].delayMs).toBeGreaterThan(d[0].delayMs);
  });
});

describe('FixedStep', () => {
  it('события уходят в первый шаг и не теряются в кадрах без шагов', () => {
    const loop = new FixedStep(DT, 250);
    const got: EyeEvent[][] = [];
    loop.advance(5, ['blinkStart'], (ev) => got.push(ev)); // шагов нет
    loop.advance(5, ['blinkEnd'], (ev) => got.push(ev)); // шагов нет
    loop.advance(45, [], (ev) => got.push(ev)); // 55 мс — 3 шага
    expect(got).toEqual([['blinkStart', 'blinkEnd'], [], []]);
  });

  it('долгий кадр режется до maxFrameMs', () => {
    const loop = new FixedStep(DT, 250);
    expect(loop.advance(10_000, [], () => {})).toBeLessThanOrEqual(Math.ceil(250 / DT));
  });
});

describe('реплей фикстур: RawFrame → gaze → sim', () => {
  const play = (id: 'lost' | 'closed') => {
    const { states } = runFixture(synthProtocol(id, { seed: 5 }));
    const g = createGame(1);
    const loop = new FixedStep(DT, 250);
    const out: GameEvent[] = [];
    let prev = states[0].t;
    for (const s of states) {
      loop.advance(s.t - prev, s.events, (ev, dt) => stepGame(g, s, ev, dt, out));
      prev = s.t;
    }
    return { g, out };
  };

  it('lost: каждое накрытие камеры — пауза и возврат, никогда не смерть и не скан', () => {
    const { g, out } = play('lost');
    const kinds = out.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'pause').length).toBe(4); // старт трекера + 3 накрытия
    expect(kinds.filter((k) => k === 'resume').length).toBe(4);
    expect(kinds).not.toContain('death');
    expect(kinds).not.toContain('ping');
    expect(g.phase).toBe('play');
  });

  it('closed: три закрытия — три скана с послеобразом', () => {
    const { out } = play('closed');
    expect(out.filter((e) => e.kind === 'afterimage')).toHaveLength(3);
    expect(out.filter((e) => e.kind === 'ping').length).toBeGreaterThanOrEqual(3 * 3);
  });
});

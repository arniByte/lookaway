import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { createFauna, hostIndex, stepFauna } from '../src/game/fauna';
import { advanceStudy, cladogram, createResearch, leaves, measurements, startStudy } from '../src/game/research';
import { chargeScanner, createScanner, pulseRange, releasePulse, scanPower } from '../src/game/scanner';
import { makeRng } from '../src/world/random';
import { generateWorld } from '../src/world/worldgen';

const world = generateWorld(4242);
const DT = 1000 / 60;

describe('сканер', () => {
  it('заряжается за cooldown, с закрытыми глазами — вдвое быстрее', () => {
    const s = createScanner();
    expect(releasePulse(s)).not.toBeNull();
    expect(releasePulse(s)).toBeNull();
    for (let t = 0; t < config.scanner.cooldownMs / 2; t += DT) chargeScanner(s, DT, true);
    expect(s.charge).toBeGreaterThanOrEqual(0.99);
    const o = createScanner();
    releasePulse(o);
    for (let t = 0; t < config.scanner.cooldownMs / 2; t += DT) chargeScanner(o, DT, false);
    expect(o.charge).toBeCloseTo(0.5, 1);
  });

  it('дольше закрыты глаза — мощнее импульс; накопление только при полном заряде', () => {
    const s = createScanner();
    for (let t = 0; t < config.scanner.holdFullMs / 2; t += DT) chargeScanner(s, DT, true);
    expect(scanPower(s)).toBeCloseTo(0.5, 1);
    const half = releasePulse(s)!;
    for (let t = 0; t < config.scanner.holdFullMs * 2; t += DT) chargeScanner(s, DT, true);
    expect(s.charge).toBe(1);
    // Пока заряжался, мощность не копилась: только время после полного заряда.
    expect(scanPower(s)).toBeLessThan(1);
    for (let t = 0; t < config.scanner.holdFullMs * 2; t += DT) chargeScanner(s, DT, true);
    const full = releasePulse(s)!;
    expect(full).toBe(1);
    expect(pulseRange(full, 0)).toBeGreaterThan(pulseRange(half, 0));
    expect(pulseRange(0, 0)).toBe(config.scanner.rangeMin);
    expect(pulseRange(1, 4)).toBe(config.scanner.rangeMax + 4 * config.scanner.rangePerSpecies);
  });

  it('открыл глаза без заряда — импульса нет, накопление сброшено', () => {
    const s = createScanner();
    releasePulse(s);
    chargeScanner(s, 500, true);
    expect(releasePulse(s)).toBeNull();
    expect(s.hold).toBe(0);
  });
});

describe('фауна', () => {
  const step = (ms: number, pulse: { x: number; z: number } | null = null, seed = 1) => {
    const fauna = createFauna(world);
    const env = { time: 0, world, hosts: hostIndex(world), pulse, rng: makeRng(seed) };
    for (let t = 0; t < ms; t += DT) {
      env.time = t;
      stepFauna(fauna, DT, env);
      env.pulse = null;
    }
    return fauna;
  };

  it('детерминирована от seed, всё в долине, жуки на земле', () => {
    const a = step(20_000);
    expect(JSON.stringify(step(20_000))).toBe(JSON.stringify(a));
    for (const c of a) {
      expect(Math.hypot(c.x, c.z)).toBeLessThan(world.radius);
      if (world.species[c.species].clade === 'coleoptera') expect(c.y).toBeCloseTo(world.height(c.x, c.z), 3);
      else expect(c.y).toBeGreaterThanOrEqual(world.height(c.x, c.z));
    }
  });

  it('бабочки садятся на кормовые цветы', () => {
    const fauna = createFauna(world);
    const env = { time: 0, world, hosts: hostIndex(world), pulse: null, rng: makeRng(3) };
    let perchedNearHost = 0;
    for (let t = 0; t < 60_000; t += DT) {
      env.time = t;
      stepFauna(fauna, DT, env);
      if (Math.round(t) % 1000 < DT) {
        for (const c of fauna) {
          const sp = world.species[c.species];
          if (sp.clade !== 'lepidoptera' || c.mode !== 'perch') continue;
          const hosts = env.hosts.get(sp.genome.hostPlant!) ?? [];
          if (hosts.some((h) => Math.hypot(h.x - c.x, h.z - c.z) < 1)) perchedNearHost++;
        }
      }
    }
    expect(perchedNearHost).toBeGreaterThan(10);
  });

  it('пугливые разлетаются от импульса', () => {
    const fauna = createFauna(world);
    const shy = fauna.find((c) => world.species[c.species].genome.flees && world.species[c.species].clade !== 'coleoptera');
    expect(shy, 'в этом мире должен быть пугливый летун').toBeDefined();
    const pulse = { x: shy!.x + 1, z: shy!.z };
    const env = { time: 0, world, hosts: hostIndex(world), pulse: pulse as { x: number; z: number } | null, rng: makeRng(4) };
    const d0 = Math.hypot(shy!.x - pulse.x, shy!.z - pulse.z);
    let fled = false;
    for (let t = 0; t < 1500; t += DT) {
      env.time = t;
      stepFauna(fauna, DT, env);
      fled ||= shy!.mode === 'flee';
      env.pulse = null;
    }
    expect(fled).toBe(true);
    expect(Math.hypot(shy!.x - pulse.x, shy!.z - pulse.z)).toBeGreaterThan(d0 + 1.5);
  });
});

describe('исследование', () => {
  it('детальный скан документирует вид один раз', () => {
    const r = createResearch();
    startStudy(r, 3, { kind: 'plant', id: 1 });
    let got: number | null = null;
    for (let t = 0; t < config.research.studyMs + 100 && got === null; t += DT) got = advanceStudy(r, DT, t);
    expect(got).toBe(3);
    expect(r.documented.has(3)).toBe(true);
    startStudy(r, 3, { kind: 'plant', id: 2 });
    let again: number | null = null;
    for (let t = 0; t < config.research.studyMs + 100; t += DT) again = advanceStudy(r, DT, t) ?? again;
    expect(again).toBeNull();
  });

  it('измерения открываются по проходам', () => {
    const s = world.species.find((x) => x.clade === 'flos')!;
    expect(measurements(s, 1).map((m) => m.label)).toContain('симметрия');
    expect(measurements(s, 1).map((m) => m.label)).not.toContain('свечение');
    expect(measurements(s, 3).map((m) => m.label)).toContain('свечение');
  });

  it('кладограмма: все виды, одна клада сливается раньше, чем с чужой', () => {
    const tree = cladogram(world.species)!;
    expect(leaves(tree).sort((a, b) => a - b)).toEqual(world.species.map((s) => s.id));
    const trees = world.species.filter((s) => s.clade === 'arbor').map((s) => s.id);
    const find = (n: typeof tree): typeof tree | null => {
      const l = leaves(n);
      if (trees.every((t) => l.includes(t)) && n.children.every((c) => !trees.every((t) => leaves(c).includes(t)))) return n;
      for (const c of n.children) {
        const f = find(c);
        if (f) return f;
      }
      return null;
    };
    const lca = find(tree)!;
    expect(leaves(lca).every((id) => world.species[id].kingdom === 'plant')).toBe(true);
  });
});

describe('hands-free (режим B)', async () => {
  const { HandsFree, eyePulse } = await import('../src/game/controls');
  const eye = (over: Partial<import('../src/input/types').EyeState>): import('../src/input/types').EyeState => ({
    t: 0, confidence: 1, lost: false, gaze: { x: 0, y: 0 }, zone: 'C', blink: false, closed: false, wink: null, wide: 0, squint: 0, events: [], ...over,
  });

  it('закрытые глаза — идёшь и копишь импульс; открыл — импульс; моргание — нет', () => {
    const hf = new HandsFree();
    expect(hf.update(eye({ closed: true }), 16, false).input.forward).toBe(1);
    expect(eyePulse(eye({ closed: true })).charging).toBe(true);
    expect(eyePulse(eye({ events: ['closeEnd'] })).release).toBe(true);
    expect(eyePulse(eye({ blink: true, events: ['blinkStart', 'blinkEnd'] }))).toEqual({ charging: false, release: false });
    expect(hf.update(eye({ blink: true }), 16, false).input.forward).toBe(0);
  });

  it('взгляд у края — поворот в его сторону, в центре — нет', () => {
    const hf = new HandsFree();
    expect(hf.update(eye({ gaze: { x: 0.95, y: 0 } }), 16, false).input.turn).toBeLessThan(0);
    expect(hf.update(eye({ gaze: { x: -0.95, y: 0 } }), 16, false).input.turn).toBeGreaterThan(0);
    expect(hf.update(eye({ gaze: { x: 0.3, y: 0 } }), 16, false).input.turn).toBe(0);
  });

  it('задержка взгляда при подсказке — действие; моргание сбрасывает', () => {
    const hf = new HandsFree();
    let fired = false;
    for (let t = 0; t < config.handsFree.dwellMs - 100; t += 16) fired ||= hf.update(eye({}), 16, true).interact;
    expect(fired).toBe(false);
    hf.update(eye({ blink: true }), 16, true);
    for (let t = 0; t < config.handsFree.dwellMs - 100; t += 16) fired ||= hf.update(eye({}), 16, true).interact;
    expect(fired).toBe(false);
    for (let t = 0; t < 300; t += 16) fired ||= hf.update(eye({}), 16, true).interact;
    expect(fired).toBe(true);
  });

  it('потеря сигнала — ничего не делает (никогда не «закрытые глаза»)', () => {
    const hf = new HandsFree();
    const lost = eye({ lost: true, closed: true, events: ['closeEnd'] });
    const r = hf.update(lost, 16, true);
    expect(r.input.forward).toBe(0);
    expect(eyePulse(lost)).toEqual({ charging: false, release: false });
  });
});

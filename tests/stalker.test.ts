import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { createDirector, onReveal, stepDirector, type DirectorCtx } from '../src/game/director';
import { expeditionNotes } from '../src/game/notes';
import { colliderGrid } from '../src/game/player';
import { lineBlocked, segDist } from '../src/game/sight';
import { createStalker, distTo, hear, pickCover, scanPose, stepStalker, type Stalker, type StalkerCtx } from '../src/game/stalker';
import { buildFigure, POSES } from '../src/world/meshes';
import { makeRng } from '../src/world/random';
import { generateWorld } from '../src/world/worldgen';
import { SpatialGrid } from '../src/game/grid';
import type { Collider } from '../src/world/worldgen';

const world = generateWorld(4242);
const grid = colliderGrid(world);
const empty = new SpatialGrid<Collider>(4, []);
const DT = 1000 / 60;

/** Силуэт на открытом месте (без стволов), проснулся. */
function open(x: number, z: number): Stalker {
  const s = createStalker(world);
  s.x = x;
  s.z = z;
  s.awake = true;
  return s;
}

const ctx = (over: Partial<StalkerCtx> = {}): StalkerCtx => ({
  time: 0,
  player: { x: 0, z: 0, yaw: 0 },
  eyesClosed: false,
  blinkStart: false,
  seen: 'none',
  mode: 'approach',
  desiredDist: 5,
  ...over,
});

function run(s: Stalker, ms: number, c: StalkerCtx, g = empty): 'kill' | 'step' | null {
  const rng = makeRng(1);
  let last: 'kill' | 'step' | null = null;
  for (let t = 0; t < ms; t += DT) {
    const r = stepStalker(s, DT, { ...c, time: c.time + t }, world, g, rng);
    if (r === 'kill') return r;
    last = r ?? last;
  }
  return last;
}

describe('линия видимости', () => {
  it('ствол между — видимости нет; в стороне — есть', () => {
    const g = new SpatialGrid<Collider>(4, [{ x: 5, z: 0, r: 0.4 }]);
    expect(segDist(5, 0, 0, 0, 10, 0)).toBe(0);
    expect(lineBlocked(g, 0, 0, 10, 0)).toBe(true);
    expect(lineBlocked(g, 0, 3, 10, 3)).toBe(false);
    // Коллайдер у самого наблюдателя не считается (он сам за ним стоит).
    expect(lineBlocked(g, 5.6, 0, 20, 0)).toBe(false);
  });
});

describe('силуэт', () => {
  it('спит до импульса; не слышит дальше hearing', () => {
    const s = createStalker(world);
    const x0 = s.x;
    run(s, 3000, ctx());
    expect(s.x).toBe(x0);
    expect(hear(s, s.x + config.stalker.hearing + 5, s.z, config.stalker.hearing)).toBe(false);
    expect(hear(s, s.x + 10, s.z, config.stalker.hearing)).toBe(true);
    expect(s.awake).toBe(true);
  });

  it('под взглядом стоит, в поле зрения крадётся, вне — идёт, с закрытыми глазами — быстрее всего', () => {
    const moved = (over: Partial<StalkerCtx>) => {
      const s = open(30, 0);
      run(s, 2000, ctx(over));
      return 30 - distTo(s, 0, 0);
    };
    const gaze = moved({ seen: 'gaze' });
    const view = moved({ seen: 'view' });
    const none = moved({ seen: 'none' });
    const closed = moved({ seen: 'gaze', eyesClosed: true });
    expect(gaze).toBeCloseTo(0, 6);
    expect(view).toBeGreaterThan(0);
    expect(none).toBeGreaterThan(view * 2.5);
    expect(closed).toBeGreaterThan(none * 1.5);
  });

  it('взгляд держит не дольше holdMaxMs; отвёл взгляд — снова держит', () => {
    const s = open(30, 0);
    run(s, config.stalker.holdMaxMs - 200, ctx({ seen: 'gaze' }));
    expect(s.x).toBeCloseTo(30, 6);
    run(s, 1500, ctx({ seen: 'gaze' }));
    expect(s.x).toBeLessThan(30 - 0.1);
    run(s, config.stalker.holdResetMs + 100, ctx({ seen: 'view', mode: 'stalk', desiredDist: 30 }));
    const x = s.x;
    run(s, 1000, ctx({ seen: 'gaze' }));
    expect(s.x).toBeCloseTo(x, 6);
  });

  it('моргание — рывок, но не ближе safeDist и никогда не убивает', () => {
    const s = open(6, 0);
    for (let i = 0; i < 50; i++) expect(stepStalker(s, 1, ctx({ blinkStart: true, seen: 'gaze' }), world, empty, makeRng(2))).not.toBe('kill');
    expect(distTo(s, 0, 0)).toBeGreaterThanOrEqual(config.stalker.safeDist - 1e-6);
  });

  it('убивает только при сближении (approach/hunt), не при выслеживании', () => {
    expect(run(open(3, 0), 5000, ctx({ mode: 'approach' }))).toBe('kill');
    expect(run(open(3, 0), 5000, ctx({ mode: 'hunt' }))).toBe('kill');
    const stalk = open(3, 0);
    expect(run(stalk, 5000, ctx({ mode: 'stalk', desiredDist: 25 }))).not.toBe('kill');
  });

  it('обходит ствол на пути, а не упирается в него', () => {
    const g = new SpatialGrid<Collider>(4, [{ x: 2.5, z: 0, r: 0.6 }]);
    const s = open(5, 0);
    expect(run(s, 6000, ctx({ mode: 'hunt' }), g)).toBe('kill');
  });

  it('отступает — дистанция растёт', () => {
    const s = open(8, 0);
    run(s, 4000, ctx({ mode: 'retreat' }));
    expect(distTo(s, 0, 0)).toBeGreaterThan(8 + 4000 / 1000 * config.stalker.retreatSpeed * 0.8);
  });

  it('укрытие — за стволом со стороны игрока, около желаемой дистанции', () => {
    const p = world.spawn;
    const s = open(p.x + 60, p.z);
    let covered = 0;
    for (let i = 0; i < 20; i++) {
      const c = pickCover(s, ctx({ player: { x: p.x, z: p.z, yaw: i }, desiredDist: 25, mode: 'stalk' }), grid, makeRng(i));
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      expect(Math.abs(d - 25)).toBeLessThan(10);
      if (c.cover && lineBlocked(grid, p.x, p.z, c.x, c.z)) covered++;
    }
    expect(covered).toBeGreaterThan(10);
  });

  it('в скане всегда лицом к игроку; вблизи при сближении — тянет руку', () => {
    const s = open(0, 6);
    s.mode = 'approach';
    expect(scanPose(s, 0, 0)).toBe('reach');
    expect(Math.abs(s.heading - Math.PI)).toBeLessThan(1e-6); // из (0,6) на (0,0): смотрит в −Z
  });
});

describe('директор', () => {
  const dctx = (over: Partial<DirectorCtx> = {}): DirectorCtx => ({
    time: 60_000,
    dtMs: 1000,
    awake: true,
    stalkerDist: 40,
    documented: 0,
    extractReady: false,
    studying: false,
    eyesClosed: false,
    stillMs: 0,
    ...over,
  });

  it('напряжение растёт; с ним — сближение; все виды описаны — охота', () => {
    const d = createDirector();
    let out = stepDirector(d, dctx());
    expect(out.mode).toBe('stalk');
    for (let i = 0; i < 200 && out.mode !== 'approach'; i++) out = stepDirector(d, dctx({ studying: true }));
    expect(out.mode).toBe('approach');
    expect(stepDirector(d, dctx({ extractReady: true })).mode).toBe('hunt');
  });

  it('в начале забега — только издалека', () => {
    const d = createDirector();
    d.tension = 1;
    const out = stepDirector(d, dctx({ time: 1000 }));
    expect(out.mode).toBe('stalk');
    expect(out.desiredDist).toBeGreaterThanOrEqual(35);
  });

  it('близкий контакт — передышка: отступает, потом снова нагнетает', () => {
    const d = createDirector();
    d.tension = 0.9;
    onReveal(d, 60_000);
    expect(stepDirector(d, dctx({ stalkerDist: 8 })).mode).toBe('retreat');
    expect(d.tension).toBeLessThan(0.9);
    const later = stepDirector(d, dctx({ time: 60_000 + config.director.relaxMs + 1 }));
    expect(later.mode).not.toBe('retreat');
  });

  it('спит — ничего не делает', () => {
    expect(stepDirector(createDirector(), dctx({ awake: false })).mode).toBe('dormant');
  });
});

describe('экспедиция', () => {
  it('статуи: сколько задано, лицом к маяку, не у спавна', () => {
    expect(world.statues.length).toBe(config.expedition.statues);
    for (const f of world.statues) {
      expect(Math.hypot(f.x, f.z)).toBeGreaterThanOrEqual(config.expedition.minDist);
      const toBeacon = Math.atan2(-f.x, -f.z);
      expect(Math.abs(Math.atan2(Math.sin(f.yaw - toBeacon), Math.cos(f.yaw - toBeacon)))).toBeLessThan(0.6);
    }
    expect(Math.hypot(world.stalkerSpawn.x, world.stalkerSpawn.z)).toBeGreaterThanOrEqual(config.stalker.spawnMinDist);
  });

  it('записи детерминированы; первая — про счёт; есть подсказки', () => {
    const a = expeditionNotes(world);
    expect(a).toEqual(expeditionNotes(generateWorld(4242)));
    expect(a.length).toBe(world.statues.length);
    expect(a[0].text).toContain(`Нас было ${world.statues.length}`);
    expect(a.filter((n) => n.hint !== null).length).toBeGreaterThanOrEqual(2);
  });

  it('фигура: у силуэта длиннее руки и выше рост', () => {
    const plain = buildFigure(POSES.stand, { height: 1.75, armMul: 1, backpack: true, fingers: false });
    const him = buildFigure(POSES.stand, { height: 1.75 * config.stalker.heightMul, armMul: config.stalker.armMul, backpack: false, fingers: true });
    for (const g of [plain, him]) {
      g.computeBoundingBox();
      expect((g.getAttribute('position').array as Float32Array).every(Number.isFinite)).toBe(true);
    }
    expect(him.boundingBox!.max.y).toBeGreaterThan(plain.boundingBox!.max.y);
    expect(him.boundingBox!.min.y).toBeGreaterThan(-0.2);
    for (const pose of Object.values(POSES)) expect(buildFigure(pose, { height: 1.8, armMul: 1, backpack: true, fingers: false }).getAttribute('position').count).toBeGreaterThan(200);
  });
});

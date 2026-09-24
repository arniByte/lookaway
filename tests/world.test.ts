import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { fbm, simplex2 } from '../src/world/noise';
import { generateSpecies, genomeVector, WORLD_PLAN } from '../src/world/species';
import { generateWorld } from '../src/world/worldgen';

describe('шум', () => {
  it('детерминирован и в пределах', () => {
    const a = simplex2(7);
    const b = simplex2(7);
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 2000; i++) {
      const x = i * 0.137;
      const y = i * 0.071;
      expect(a(x, y)).toBe(b(x, y));
      const v = fbm(a, x, y);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThan(-1.01);
    expect(hi).toBeLessThan(1.01);
    expect(hi - lo).toBeGreaterThan(0.5);
    expect(simplex2(8)(1.3, 2.1)).not.toBe(a(1.3, 2.1));
  });
});

describe('виды', () => {
  it('по плану, детерминированы, названия уникальны и латинские', () => {
    const a = generateSpecies(42);
    expect(a.map((s) => s.clade)).toEqual([...WORLD_PLAN]);
    expect(JSON.stringify(generateSpecies(42))).toBe(JSON.stringify(a));
    expect(JSON.stringify(generateSpecies(43))).not.toBe(JSON.stringify(a));
    expect(new Set(a.map((s) => s.genus)).size).toBe(a.length);
    for (const s of a) {
      expect(s.name).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
      expect(s.ru).toMatch(/^[а-яё]+ [а-яё]+$/);
    }
  });

  it('у чешуекрылых кормовое растение — цветковое', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const sp = generateSpecies(seed);
      for (const s of sp.filter((x) => x.clade === 'lepidoptera')) {
        expect(sp[s.genome.hostPlant!].clade).toBe('flos');
      }
    }
  });

  it('вектор генома: одна клада ближе, чем разные', () => {
    const sp = generateSpecies(9);
    const d = (i: number, j: number) => Math.hypot(...genomeVector(sp[i]).map((v, k) => v - genomeVector(sp[j])[k]));
    const trees = sp.filter((s) => s.clade === 'arbor').map((s) => s.id);
    const bug = sp.find((s) => s.clade === 'coleoptera')!.id;
    expect(d(trees[0], trees[1])).toBeLessThan(d(trees[0], bug));
  });
});

describe('мир', () => {
  const w = generateWorld(1234);

  it('детерминирован от seed', () => {
    const again = generateWorld(1234);
    expect(JSON.stringify(again.plants)).toBe(JSON.stringify(w.plants));
    expect(JSON.stringify(again.animals)).toBe(JSON.stringify(w.animals));
    expect(again.height(13.2, -40.5)).toBe(w.height(13.2, -40.5));
    expect(JSON.stringify(generateWorld(1235).plants)).not.toBe(JSON.stringify(w.plants));
  });

  it('всё внутри долины, стволы не пересекаются, поляна у маяка чистая', () => {
    const R = config.world.radius;
    for (const p of [...w.plants, ...w.rocks, ...w.animals]) expect(Math.hypot(p.x, p.z)).toBeLessThan(R);
    const trunks = w.plants.filter((p) => p.collider > 0);
    for (let i = 0; i < trunks.length; i++) {
      for (let j = i + 1; j < trunks.length; j++) {
        expect(Math.hypot(trunks[i].x - trunks[j].x, trunks[i].z - trunks[j].z)).toBeGreaterThan(1);
      }
    }
    expect(trunks.every((t) => Math.hypot(t.x, t.z) > config.world.spawnClearing * 0.5)).toBe(true);
    expect(w.colliders.every((c) => Math.hypot(c.x - w.spawn.x, c.z - w.spawn.z) > c.r)).toBe(true);
  });

  it('подлесок: стволы лежат по склону, пни не пересекаются с деревьями, всё в долине', () => {
    const R = config.world.radius;
    expect(w.logs.length).toBeGreaterThan(config.world.logCount * 0.5);
    expect(w.stumps.length).toBeGreaterThan(config.world.stumpCount * 0.5);
    expect(w.shrubs.length).toBeGreaterThan(50);
    for (const l of [...w.logs, ...w.stumps, ...w.shrubs, ...w.pebbles]) expect(Math.hypot(l.x, l.z)).toBeLessThan(R);
    for (const l of w.logs) {
      expect(Math.abs(l.tilt)).toBeLessThan(0.6);
      expect(l.y).toBeCloseTo(w.height(l.x, l.z), -0.5);
    }
    const trunks = w.plants.filter((p) => p.collider > 0);
    for (const s of w.stumps) for (const t of trunks) expect(Math.hypot(s.x - t.x, s.z - t.z)).toBeGreaterThan(s.scale + t.collider);
  });

  it('каждый вид представлен, фауна у кормовых растений', () => {
    for (const s of w.species) {
      const n = s.kingdom === 'plant' ? w.plants.filter((p) => p.species === s.id).length : w.animals.filter((a) => a.species === s.id).length;
      expect(n, s.name).toBeGreaterThanOrEqual(3);
    }
    for (const s of w.species.filter((x) => x.clade === 'lepidoptera')) {
      const hosts = w.plants.filter((p) => p.species === s.genome.hostPlant);
      const flies = w.animals.filter((a) => a.species === s.id);
      const near = flies.filter((a) => hosts.some((h) => Math.hypot(h.x - a.x, h.z - a.z) < 10));
      expect(near.length).toBeGreaterThanOrEqual(flies.length * 0.7);
    }
  });

  it('рельеф: маяк на нуле, край долины — обрыв', () => {
    expect(w.height(0, 0)).toBeCloseTo(0, 6);
    const R = config.world.radius;
    expect(w.height(R + 10, 0) - w.height(R - 20, 0)).toBeGreaterThan(10);
  });
});

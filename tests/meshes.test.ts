import { describe, expect, it } from 'vitest';
import { buildAnimal, buildBeacon, buildGrass, buildPlant, buildRock, tagSpecies } from '../src/world/meshes';
import { makeRng } from '../src/world/random';
import { generateSpecies } from '../src/world/species';
import type * as THREE from 'three';

function check(g: THREE.BufferGeometry, maxVerts: number) {
  const pos = g.getAttribute('position');
  expect(pos.count).toBeGreaterThan(10);
  expect(pos.count).toBeLessThan(maxVerts);
  for (const name of ['normal', 'aRefl', 'aMat']) expect(g.getAttribute(name).count).toBe(pos.count);
  const arr = pos.array as Float32Array;
  expect(arr.every(Number.isFinite)).toBe(true);
  const idx = g.getIndex()!;
  expect(Math.max(...(idx.array as Uint32Array))).toBeLessThan(pos.count);
  return pos.count;
}

describe('меши из генома', () => {
  const sp = generateSpecies(77);
  const budget: Record<string, number> = { arbor: 6000, filix: 4000, flos: 1500, fungus: 800 };

  it.each(sp.filter((s) => s.kingdom === 'plant').map((s) => [s.clade, s] as const))('%s: атрибуты, бюджет, детерминизм', (_, s) => {
    const a = buildPlant(s, 5);
    check(a, budget[s.clade]);
    const b = buildPlant(s, 5);
    expect(Array.from(b.getAttribute('position').array)).toEqual(Array.from(a.getAttribute('position').array));
    expect(buildPlant(s, 6).getAttribute('position').count > 0).toBe(true);
  });

  it.each(sp.filter((s) => s.kingdom === 'animal').map((s) => [s.clade, s] as const))('%s: тело и крылья', (clade, s) => {
    const parts = buildAnimal(s, 3);
    check(parts.body, 3000);
    if (clade !== 'coleoptera') expect(parts.wings.length).toBe(2);
    for (const w of parts.wings) check(w.geo, 3000);
    const hi = buildAnimal(s, 3, 3);
    expect(hi.body.getAttribute('position').count).toBeGreaterThanOrEqual(parts.body.getAttribute('position').count);
  });

  it('трава, камень, маяк, тег вида', () => {
    check(buildGrass(makeRng(1)), 200);
    check(buildRock(9, 1.2), 400);
    check(buildBeacon(), 1000);
    const g = tagSpecies(buildGrass(makeRng(2)), 4);
    expect((g.getAttribute('aSpecies').array as Float32Array)[0]).toBe(5);
  });
});

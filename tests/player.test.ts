import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { colliderGrid, createPlayer, movePlayer, NO_INPUT } from '../src/game/player';
import { generateWorld } from '../src/world/worldgen';

const world = generateWorld(555);
const grid = colliderGrid(world);

describe('игрок', () => {
  it('появляется у маяка, идёт вперёд со скоростью ходьбы и считает шаги', () => {
    const p = createPlayer(world);
    expect(p.z).toBeGreaterThan(world.beacon.z); // маяк впереди (−Z)
    p.yaw = Math.PI; // спиной к маяку: вперёд = +Z
    const z0 = p.z;
    let steps = 0;
    for (let i = 0; i < 120; i++) if (movePlayer(p, { ...NO_INPUT, forward: 1 }, 1000 / 60, world, grid)) steps++;
    expect(p.z - z0).toBeGreaterThan(config.player.walk * 2 * 0.8);
    expect(p.z - z0).toBeLessThan(config.player.walk * 2 * 1.05);
    expect(steps).toBeGreaterThanOrEqual(4);
  });

  it('не проходит сквозь стволы и не выходит за край долины', () => {
    const p = createPlayer(world);
    for (let i = 0; i < 60 * 120; i++) {
      movePlayer(p, { ...NO_INPUT, forward: 1, run: true, turn: i % 600 === 0 ? 0.7 : 0 }, 1000 / 60, world, grid);
      for (const c of grid.near(p.x, p.z, 3)) {
        expect(Math.hypot(p.x - c.x, p.z - c.z)).toBeGreaterThan(c.r + config.player.radius - 0.02);
      }
      expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(world.radius);
    }
  });

  it('глаза на высоте роста над рельефом', () => {
    const p = createPlayer(world);
    for (let i = 0; i < 300; i++) movePlayer(p, { ...NO_INPUT, forward: 1, strafe: 0.5 }, 1000 / 60, world, grid);
    expect(p.y - world.height(p.x, p.z)).toBeCloseTo(config.player.eyeHeight, 0);
  });
});

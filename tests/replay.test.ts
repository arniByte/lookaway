import { describe, expect, it } from 'vitest';
import { ReplaySource } from '../src/input/sources/replaySource';
import type { EyeEvent } from '../src/input/types';
import { synthProtocol } from './synthetic';

describe('ReplaySource', () => {
  it('копит события между poll и ничего не теряет при редких poll', () => {
    const fx = synthProtocol('blinks', { seed: 31 });
    const collect = (step: number) => {
      const src = new ReplaySource(fx);
      void src.start();
      const got: EyeEvent[] = [];
      for (let now = 1000; !src.done; now += step) got.push(...src.poll(now).events);
      return got;
    };
    const fast = collect(16);
    const slow = collect(700); // poll реже, чем длится моргание
    expect(slow).toEqual(fast);
    expect(fast.filter((e) => e === 'blinkStart').length).toBe(10);
  });
});

// Баланс без людей: разные стратегии ботов должны давать разный исход (ROADMAP → M1).
import { describe, expect, it } from 'vitest';
import { greedy, idle, rotate, survey } from './bots';

describe('баланс грейбокса', () => {
  it('бездействие проигрывает', () => {
    expect(survey({ blinksPerMin: 12, strategy: () => idle }).winRate).toBe(0);
    expect(survey({ blinksPerMin: 12, strategy: () => idle, voluntary: true }).winRate).toBe(0);
  });

  it('механическое вращение луча почти всегда проигрывает', () => {
    expect(survey({ blinksPerMin: 12, strategy: () => rotate() }).winRate).toBeLessThanOrEqual(0.1);
  });

  it('внимание + выбор момента моргания выигрывает', () => {
    expect(survey({ blinksPerMin: 12, strategy: () => greedy(), voluntary: true }).winRate).toBeGreaterThanOrEqual(0.8);
  });

  it('одного внимания мало: момент моргания решает', () => {
    const attentive = survey({ blinksPerMin: 12, strategy: () => greedy() }).winRate;
    const skilled = survey({ blinksPerMin: 12, strategy: () => greedy(), voluntary: true }).winRate;
    expect(attentive).toBeLessThan(skilled - 0.2);
  });

  it('частые непроизвольные моргания стоят дорого', () => {
    const normal = survey({ blinksPerMin: 12, strategy: () => greedy(), voluntary: true }).winRate;
    const spam = survey({ blinksPerMin: 30, strategy: () => greedy(), voluntary: true }).winRate;
    expect(spam).toBeLessThan(normal - 0.3);
  });

  it('скан стоит безопасности (для бота, который и так всё знает)', () => {
    const plain = survey({ blinksPerMin: 12, strategy: () => greedy(), voluntary: true }).winRate;
    const scanning = survey({ blinksPerMin: 12, strategy: () => greedy(), voluntary: true, closeEveryMs: 8000, closeMs: 1500 }).winRate;
    expect(scanning).toBeLessThan(plain - 0.2);
  });
});

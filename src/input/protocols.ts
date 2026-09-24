import type { Cue, ProtocolId, Zone } from './types';

export interface Protocol {
  id: ProtocolId;
  title: string;
  instruction: string;
  durationMs: number;
  cues: Cue[]; // t — от начала записи
}

const every = (startMs: number, stepMs: number, n: number) => Array.from({ length: n }, (_, i) => startMs + i * stepMs);

const ZONE_SEQ: Zone[] = ['L', 'C', 'R', 'C', 'L', 'R', 'L', 'C', 'R', 'C'];

export const PROTOCOLS: Record<ProtocolId, Protocol> = {
  calm: {
    id: 'calm',
    title: 'calm — 2 минуты обычного поведения',
    instruction:
      'Читай текст вслух или разговаривай. Моргай как обычно, крути головой как обычно. Не закрывай глаза надолго.',
    durationMs: 120_000,
    cues: [],
  },
  blinks: {
    id: 'blinks',
    title: 'blinks — моргание по сигналу',
    instruction: 'На каждый сигнал (звук + вспышка) моргни один раз. Между сигналами старайся не моргать.',
    durationMs: 35_000,
    cues: every(3000, 3000, 10).map((t) => ({ t, kind: 'blink' as const })),
  },
  zones: {
    id: 'zones',
    title: 'zones — взгляд по точкам',
    instruction: 'Смотри на точку. Когда она прыгает, переводи взгляд так, как делал бы в игре: глазами и головой.',
    durationMs: 2000 + ZONE_SEQ.length * 2500 + 1500,
    cues: ZONE_SEQ.map((zone, i) => ({ t: 2000 + i * 2500, kind: 'look' as const, zone })),
  },
  closed: {
    id: 'closed',
    title: 'closed — закрыть глаза на 3 секунды',
    instruction: 'На сигнал закрой глаза и держи. На второй сигнал (двойной звук) открой.',
    durationMs: 20_000,
    cues: every(3000, 6000, 3).map((t) => ({ t, kind: 'close' as const, durMs: 3000 })),
  },
  lost: {
    id: 'lost',
    title: 'lost — закрыть камеру рукой',
    instruction: 'На сигнал закрой камеру ладонью. На второй сигнал (двойной звук) убери руку. Глаза не закрывай.',
    durationMs: 20_000,
    cues: every(3000, 6000, 3).map((t) => ({ t, kind: 'cover' as const, durMs: 3000 })),
  },
};

// Калибровка без диегетики (M0). Диегетическая — таблица Сивцева в M6.
import { config } from '../config';
import { computeProfile, type CalibResult, type CalibSegments } from '../input/calibration';
import type { TrackerSource } from '../input/sources/trackerSource';
import type { RawFrame } from '../input/types';
import { beep, doubleBeep } from './beep';
import { fullscreenLayer, gazeToScreen, placeDot, sleep } from './ui';

type GazeStep = 'center' | 'left' | 'right' | 'up' | 'down';
const T = config.gaze.calibTarget;
const GAZE_STEPS: [GazeStep, number, number, string][] = [
  ['center', 0, 0, 'Смотри на точку в центре'],
  ['left', -T, 0, 'Смотри на точку слева'],
  ['right', T, 0, 'Смотри на точку справа'],
  ['up', 0, T, 'Смотри на точку сверху'],
  ['down', 0, -T, 'Смотри на точку снизу'],
];

export async function runCalibration(tracker: TrackerSource, signal: AbortSignal): Promise<CalibResult> {
  const c = config.calibration;
  const ui = fullscreenLayer();
  const seg: CalibSegments = { center: [], left: [], right: [], up: [], down: [], blinks: [], closed: [] };
  let bucket: RawFrame[] | null = null;
  const off = tracker.onRaw((f) => bucket?.push(f));
  const collect = async (into: RawFrame[], ms: number) => {
    bucket = into;
    await sleep(ms, signal);
    bucket = null;
  };

  try {
    ui.text.textContent = 'Калибровка. Сиди как будешь играть. Двигай глазами и головой естественно.\nEsc — отмена.';
    await sleep(2500, signal);

    for (const [key, x, y, text] of GAZE_STEPS) {
      ui.text.textContent = text;
      placeDot(ui.dot, ...gazeToScreen(x, y));
      await sleep(c.settleMs, signal);
      await collect(seg[key], c.stepMs);
    }

    placeDot(ui.dot, 0.5, 0.5);
    ui.text.textContent = `Моргни один раз на каждый звук (${c.blinkCount} раза)`;
    await sleep(1500, signal);
    bucket = seg.blinks;
    const gap = c.blinkStepMs / (c.blinkCount + 1);
    for (let k = 0; k < c.blinkCount; k++) {
      await sleep(gap, signal);
      beep();
    }
    await sleep(gap, signal);
    bucket = null;

    ui.text.textContent = 'На сигнал закрой глаза. Открой на двойной сигнал.';
    await sleep(2000, signal);
    beep();
    await sleep(c.settleMs + 300, signal);
    await collect(seg.closed, c.closedStepMs);
    doubleBeep();

    return computeProfile(seg);
  } finally {
    off();
    ui.destroy();
  }
}

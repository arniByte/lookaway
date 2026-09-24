// Мастер калибровки v2 (TECH → Калибровка). Точка засчитывается, только когда взгляд на ней устоялся.
import { config } from '../config';
import {
  calibrationGrid,
  computeProfile,
  isStable,
  recenterProfile,
  validationTargets,
  type CalibData,
  type CalibPoint,
  type CalibResult,
  type GazeTarget,
} from '../input/calibration';
import type { TrackerSource } from '../input/sources/trackerSource';
import type { CalibrationProfile, RawFrame } from '../input/types';
import { beep, doubleBeep } from './beep';
import { el, fullscreenLayer, gazeToScreen, placeDot, sleep } from './ui';

type Layer = ReturnType<typeof fullscreenLayer>;

/** Кольцо вокруг точки сжимается, пока идёт сбор: видно, что система «ждёт взгляд». */
function ring(ui: Layer): HTMLDivElement {
  const r = el('div', 'position:absolute;width:64px;height:64px;margin:-32px 0 0 -32px;border:2px solid #6cf;border-radius:50%;left:50%;top:50%;transition:transform .15s,opacity .15s;opacity:.8');
  ui.root.append(r);
  return r;
}

/**
 * Собрать кадры точки: ждём стабильного взгляда, копим minStableFrames стабильных кадров.
 * null — не удалось за timeout.
 */
async function collectPoint(
  tracker: TrackerSource,
  ui: Layer,
  rg: HTMLDivElement,
  target: GazeTarget,
  signal: AbortSignal,
): Promise<RawFrame[] | null> {
  const c = config.calibration;
  const [sx, sy] = gazeToScreen(target.x, target.y);
  placeDot(ui.dot, sx, sy);
  rg.style.left = `${sx * 100}%`;
  rg.style.top = `${sy * 100}%`;
  rg.style.transform = 'scale(1)';
  await sleep(c.settleMs, signal);

  const all: RawFrame[] = [];
  let stable = 0;
  const off = tracker.onRaw((f) => {
    all.push(f);
    if (isStable(all)) stable++;
    rg.style.transform = `scale(${Math.max(0.25, 1 - stable / c.minStableFrames)})`;
  });
  try {
    const t0 = performance.now();
    while (stable < c.minStableFrames) {
      if (performance.now() - t0 > c.pointTimeoutMs) return null;
      await sleep(50, signal);
    }
    return all;
  } finally {
    off();
  }
}

async function collectPoints(
  tracker: TrackerSource,
  ui: Layer,
  targets: GazeTarget[],
  label: string,
  signal: AbortSignal,
): Promise<CalibPoint[]> {
  const rg = ring(ui);
  const out: CalibPoint[] = [];
  try {
    for (let i = 0; i < targets.length; i++) {
      ui.text.textContent = `${label}: ${i + 1} из ${targets.length}. Смотри на точку.`;
      let frames = await collectPoint(tracker, ui, rg, targets[i], signal);
      if (!frames) {
        ui.text.textContent = `${label}: ${i + 1} из ${targets.length}. Держи взгляд на точке и не двигай головой.`;
        frames = await collectPoint(tracker, ui, rg, targets[i], signal);
      }
      out.push({ target: targets[i], frames: frames ?? [] });
      beep(1200, 30);
    }
  } finally {
    rg.remove();
  }
  return out;
}

/** Живая проверка: точка идёт за взглядом по новому профилю. */
async function liveCheck(tracker: TrackerSource, ui: Layer, signal: AbortSignal): Promise<void> {
  ui.text.textContent = 'Проверка: точка должна идти за взглядом. Посмотри по углам.';
  ui.dot.style.background = '#6cf';
  const t0 = performance.now();
  while (performance.now() - t0 < config.calibration.checkMs) {
    const s = tracker.gaze.current;
    if (!s.blink && !s.closed && !s.lost) placeDot(ui.dot, ...gazeToScreen(s.gaze.x, s.gaze.y));
    await sleep(16, signal);
  }
  ui.dot.style.background = '#fff';
}

export async function runCalibration(tracker: TrackerSource, signal: AbortSignal): Promise<CalibResult> {
  const c = config.calibration;
  const ui = fullscreenLayer();
  const data: CalibData = { points: [], blinks: [], closed: [] };
  let bucket: RawFrame[] | null = null;
  const off = tracker.onRaw((f) => bucket?.push(f));

  try {
    ui.text.textContent =
      'Калибровка ~40 с. Сядь как будешь играть. Смотри на точки — глазами и головой, как обычно.\nEsc — отмена.';
    await sleep(2500, signal);

    data.points = await collectPoints(tracker, ui, calibrationGrid(), 'Точка', signal);

    placeDot(ui.dot, 0.5, 0.5);
    ui.text.textContent = `Моргни один раз на каждый звук (${c.blinkCount} раз)`;
    await sleep(1500, signal);
    bucket = data.blinks;
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
    bucket = data.closed;
    await sleep(c.closedStepMs, signal);
    bucket = null;
    doubleBeep();
    await sleep(600, signal);

    data.validation = await collectPoints(tracker, ui, validationTargets(), 'Проверка точности', signal);

    const res = computeProfile(data);
    if (res.profile.calibrated) {
      tracker.gaze.setProfile(res.profile);
      await liveCheck(tracker, ui, signal);
    }
    return res;
  } finally {
    off();
    ui.destroy();
  }
}

/** Перецентровка за ~2 с: одна точка в центре, сдвигает только ноль. */
export async function runRecenter(
  tracker: TrackerSource,
  profile: CalibrationProfile,
  signal: AbortSignal,
): Promise<CalibrationProfile | null> {
  const ui = fullscreenLayer();
  try {
    const [pt] = await collectPoints(tracker, ui, [{ x: 0, y: 0 }], 'Перецентровка', signal);
    return recenterProfile(profile, pt.frames);
  } finally {
    ui.destroy();
  }
}

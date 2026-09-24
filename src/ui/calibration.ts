// Калибровка на каждом входе (TECH → Калибровка). В центре — лидар-портрет глаз игрока:
// предпроверка (лицо, свет, расстояние, центр) → 9 точек → моргания → закрытые глаза →
// валидация → живая проверка → результат с повтором. Точка засчитывается, когда взгляд устоялся.
import { beep, doubleBeep } from '../audio/beep';
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
import { LidarEyes } from '../render/lidarEyes';
import { btn, gazeToScreen, h, sleep } from './dom';

const aborted = () => new DOMException('aborted', 'AbortError');

class CalibUI {
  readonly root = h('div.calib.ui');
  readonly eyes = new LidarEyes();
  private kicker = h('div.kicker');
  private step = h('div.step');
  private extra = h('div');
  private hint = h('div.hint');
  private top = h('div.cap.top', this.kicker, this.step, this.extra);
  private bottom = h('div.cap.bottom', this.hint);
  readonly target = h('div.target');
  readonly ring = h('div.target-ring');
  private raf = 0;

  constructor(private tracker: TrackerSource) {
    this.eyes.el.classList.add('eyes');
    this.target.style.opacity = this.ring.style.opacity = '0';
    this.root.append(this.eyes.el, this.top, this.bottom, this.ring, this.target);
    document.body.append(this.root);
    this.fit();
    addEventListener('resize', this.fit);
    void this.root.offsetWidth;
    this.root.classList.add('on');
    const loop = () => {
      this.eyes.frame(this.tracker.lastFace, this.tracker.video, performance.now());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private fit = () => this.eyes.resize(Math.min(innerWidth * 0.9, 1000, (innerHeight * 0.5) / 0.4));

  stage(kicker: string, step: string, hint = ''): void {
    this.kicker.textContent = kicker;
    this.step.textContent = step;
    this.hint.textContent = hint;
    this.extra.replaceChildren();
  }

  setExtra(...nodes: HTMLElement[]): void {
    this.extra.replaceChildren(...nodes);
  }

  /** Сбор точек: портрет гаснет, чтобы не тянуть взгляд. */
  collecting(on: boolean): void {
    this.root.classList.toggle('collect', on);
    this.target.style.opacity = this.ring.style.opacity = on ? '1' : '0';
  }

  place(fx: number, fy: number): void {
    for (const e of [this.target, this.ring]) {
      e.style.left = `${fx * 100}%`;
      e.style.top = `${fy * 100}%`;
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.fit);
    this.root.classList.remove('on');
    const r = this.root;
    setTimeout(() => {
      this.eyes.dispose();
      r.remove();
    }, 500);
  }
}

const dots = (n: number, on: number) => h('div.progress-dots', ...Array.from({ length: n }, (_, i) => h(i < on ? 'i.on' : 'i')));

/** Предпроверка: ждём, пока лицо, свет, расстояние и центр в норме holdMs подряд. */
async function precheck(ui: CalibUI, tracker: TrackerSource, signal: AbortSignal): Promise<void> {
  const pc = config.calibration.precheck;
  ui.stage('Калибровка · 1 из 4', 'Посмотри в камеру', 'Сядь так, как будешь играть. Калибровка занимает около 30 секунд.');
  let okSince: number | null = null;
  for (;;) {
    const m = ui.eyes.metrics;
    const luma = tracker.lastRaw?.luma ?? 0;
    const light = luma >= config.signal.lumaOk;
    const dist = m.span >= pc.minSpan && m.span <= pc.maxSpan;
    const center = Math.abs(m.center.x - 0.5) < pc.centerTol && Math.abs(m.center.y - 0.5) < pc.centerTol * 1.3;
    const checks: [boolean, string][] = [
      [m.face, m.face ? 'лицо найдено' : 'лицо не найдено'],
      [light, light ? 'света достаточно' : 'мало света на лице'],
      [m.face && dist, !m.face ? 'расстояние' : m.span < pc.minSpan ? 'сядь ближе' : m.span > pc.maxSpan ? 'отодвинься' : 'расстояние в норме'],
      [m.face && center, !m.face ? 'положение' : center ? 'по центру' : 'сдвинься к центру камеры'],
    ];
    ui.setExtra(h('div.checks', ...checks.map(([ok, t]) => h(ok ? 'span.ok' : 'span.bad', t))));
    const now = performance.now();
    if (checks.every(([ok]) => ok)) {
      okSince ??= now;
      if (now - okSince > pc.holdMs) return;
    } else {
      okSince = null;
    }
    await sleep(100, signal);
  }
}

/** Кадры точки: ждём устойчивого взгляда, копим minStableFrames стабильных кадров. null — не вышло. */
async function collectPoint(tracker: TrackerSource, ui: CalibUI, target: GazeTarget, signal: AbortSignal): Promise<RawFrame[] | null> {
  const c = config.calibration;
  ui.place(...gazeToScreen(target.x, target.y));
  ui.ring.style.transform = 'scale(1)';
  await sleep(c.settleMs, signal);
  const all: RawFrame[] = [];
  let stable = 0;
  const off = tracker.onRaw((f) => {
    all.push(f);
    if (isStable(all)) stable++;
    ui.ring.style.transform = `scale(${Math.max(0.22, 1 - stable / c.minStableFrames)})`;
  });
  try {
    const t0 = performance.now();
    while (stable < c.minStableFrames) {
      if (performance.now() - t0 > c.pointTimeoutMs) return null;
      await sleep(40, signal);
    }
    return all;
  } finally {
    off();
  }
}

async function collectPoints(tracker: TrackerSource, ui: CalibUI, targets: GazeTarget[], kicker: string, signal: AbortSignal): Promise<CalibPoint[]> {
  const out: CalibPoint[] = [];
  ui.collecting(true);
  try {
    for (let i = 0; i < targets.length; i++) {
      ui.stage(kicker, 'Смотри на точку', 'Глазами и головой — как обычно в игре.');
      ui.setExtra(dots(targets.length, i));
      let frames = await collectPoint(tracker, ui, targets[i], signal);
      if (!frames) {
        ui.stage(kicker, 'Задержи взгляд на точке', 'Не двигай головой, пока кольцо не сожмётся.');
        ui.setExtra(dots(targets.length, i));
        frames = await collectPoint(tracker, ui, targets[i], signal);
      }
      out.push({ target: targets[i], frames: frames ?? [] });
      beep(1200, 30);
    }
  } finally {
    ui.collecting(false);
  }
  return out;
}

/** Живая проверка: точка идёт за взглядом по новому профилю. */
async function liveCheck(tracker: TrackerSource, ui: CalibUI, signal: AbortSignal): Promise<void> {
  ui.stage('Калибровка · 4 из 4', 'Проверка: точка идёт за взглядом', 'Посмотри по углам экрана.');
  ui.collecting(true);
  ui.root.classList.remove('collect');
  ui.target.classList.add('follow');
  ui.ring.style.opacity = '0';
  const t0 = performance.now();
  try {
    while (performance.now() - t0 < config.calibration.checkMs) {
      const s = tracker.gaze.current;
      if (!s.blink && !s.closed && !s.lost) ui.place(...gazeToScreen(s.gaze.x, s.gaze.y));
      await sleep(16, signal);
    }
  } finally {
    ui.target.classList.remove('follow');
    ui.collecting(false);
  }
}

async function runOnce(ui: CalibUI, tracker: TrackerSource, signal: AbortSignal): Promise<CalibResult> {
  const c = config.calibration;
  const data: CalibData = { points: [], blinks: [], closed: [] };
  let bucket: RawFrame[] | null = null;
  const off = tracker.onRaw((f) => bucket?.push(f));
  try {
    await precheck(ui, tracker, signal);
    data.points = await collectPoints(tracker, ui, calibrationGrid(), 'Калибровка · 2 из 4 · взгляд', signal);

    ui.stage('Калибровка · 3 из 4 · веки', 'Моргни на каждый сигнал', 'Обычно, как всегда моргаешь.');
    ui.setExtra(dots(c.blinkCount, 0));
    await sleep(1200, signal);
    bucket = data.blinks;
    const gap = c.blinkStepMs / (c.blinkCount + 1);
    for (let k = 0; k < c.blinkCount; k++) {
      await sleep(gap, signal);
      beep();
      ui.setExtra(dots(c.blinkCount, k + 1));
    }
    await sleep(gap, signal);
    bucket = null;

    ui.stage('Калибровка · 3 из 4 · веки', 'На сигнал закрой глаза', 'Открой на двойной сигнал. Так в игре выпускается импульс.');
    await sleep(1800, signal);
    beep();
    await sleep(c.settleMs + 300, signal);
    bucket = data.closed;
    await sleep(c.closedStepMs, signal);
    bucket = null;
    doubleBeep();
    await sleep(500, signal);

    data.validation = await collectPoints(tracker, ui, validationTargets(), 'Калибровка · 4 из 4 · проверка точности', signal);
    const res = computeProfile(data);
    if (res.profile.calibrated) {
      tracker.gaze.setProfile(res.profile);
      await liveCheck(tracker, ui, signal);
    }
    return res;
  } finally {
    off();
  }
}

/** Экран результата: продолжить (Enter, клик, закрыть и открыть глаза) или повторить (R). */
function result(ui: CalibUI, res: CalibResult, tracker: TrackerSource, signal: AbortSignal): Promise<'continue' | 'retry'> {
  const ok = res.fatal.length === 0;
  const err = res.validationError;
  const pct = err !== null ? Math.round(err * 50) : null;
  const quality = pct === null ? '' : pct <= 6 ? 'отлично' : pct <= 10 ? 'хорошо' : pct <= 13 ? 'сносно' : 'слабо — лучше повторить';
  return new Promise((resolve, reject) => {
    ui.root.classList.add('done');
    const cleanup = () => {
      ui.root.classList.remove('done');
      removeEventListener('keydown', onKey);
      clearInterval(poll);
      signal.removeEventListener('abort', onAbort);
    };
    const done = (v: 'continue' | 'retry') => {
      cleanup();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Enter' && ok) done('continue');
      if (e.code === 'KeyR') done('retry');
    };
    const onAbort = () => {
      cleanup();
      reject(aborted());
    };
    // Закрыл и открыл глаза — продолжить (руки могут быть не на клавиатуре).
    let wasClosed = false;
    const poll = setInterval(() => {
      const s = tracker.gaze.current;
      if (s.closed) wasClosed = true;
      else if (wasClosed && !s.blink && ok) done('continue');
    }, 50);
    addEventListener('keydown', onKey);
    signal.addEventListener('abort', onAbort, { once: true });

    const row = h(
      'div.row',
      ...(ok ? [btn('Продолжить', () => done('continue'), 'primary'), btn('Повторить', () => done('retry'))] : [btn('Повторить', () => done('retry'), 'primary')]),
    );
    row.style.cssText = 'justify-content:center;margin-top:22px';
    ui.stage(
      ok ? 'Калибровка завершена' : 'Калибровка не удалась',
      ok ? 'Точность взгляда' : 'Не получилось',
      ok ? 'Enter — продолжить · R — повторить · или закрой и открой глаза' : 'R — повторить · Esc — назад',
    );
    ui.setExtra(
      h(
        'div.result',
        ok && pct !== null ? h('div.big', `±${pct}%`) : null,
        ok && pct !== null ? h('div.hint', `экрана · ${quality}`) : null,
        ...res.warnings.slice(0, 3).map((w) => h('div.hint', w)),
        row,
      ),
    );
  });
}

/** Полная калибровка с экраном результата и повтором. AbortError — Esc. */
export async function runCalibration(tracker: TrackerSource, signal: AbortSignal): Promise<CalibResult> {
  const ui = new CalibUI(tracker);
  try {
    for (;;) {
      const res = await runOnce(ui, tracker, signal);
      if ((await result(ui, res, tracker, signal)) === 'continue') return res;
    }
  } finally {
    ui.destroy();
  }
}

/** Перецентровка за ~2 с: одна точка в центре, сдвигает только ноль. */
export async function runRecenter(tracker: TrackerSource, profile: CalibrationProfile, signal: AbortSignal): Promise<CalibrationProfile | null> {
  const ui = new CalibUI(tracker);
  try {
    const [pt] = await collectPoints(tracker, ui, [{ x: 0, y: 0 }], 'Перецентровка', signal);
    return recenterProfile(profile, pt.frames);
  } finally {
    ui.destroy();
  }
}

// Точка входа: грейбокс M1 (по умолчанию) или площадка трекинга M0 (?m0). Debug-оверлей — в обоих.
import { config } from './config';
import { runCalibration } from './debug/calibrationWizard';
import { unlockAudio } from './debug/beep';
import { Overlay } from './debug/overlay';
import { Playground } from './debug/playground';
import { runProtocol } from './debug/protocolRunner';
import { downloadText } from './debug/ui';
import { GameApp } from './game/app';
import { evaluate, formatReport } from './input/evaluate';
import { fixtureFromJson, fixtureToJson } from './input/fixture';
import { defaultProfile } from './input/gaze';
import { PROTOCOLS } from './input/protocols';
import { FallbackSource } from './input/sources/fallbackSource';
import { ReplaySource } from './input/sources/replaySource';
import { TrackerSource } from './input/sources/trackerSource';
import type { CalibrationProfile, EyeSource, EyeState, SourceKind } from './input/types';

function loadProfile(): CalibrationProfile {
  try {
    const raw = localStorage.getItem(config.calibration.storageKey);
    if (raw) {
      const p = JSON.parse(raw) as CalibrationProfile;
      if (p.version === 1) return p;
    }
  } catch {
    // приватное окно / заблокированное хранилище — работаем с дефолтом
  }
  return defaultProfile();
}

function saveProfile(p: CalibrationProfile): void {
  try {
    localStorage.setItem(config.calibration.storageKey, JSON.stringify(p));
  } catch {
    // не критично: профиль живёт до перезагрузки
  }
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const m0 = new URLSearchParams(location.search).has('m0');
let profile = loadProfile();
let source: EyeSource = new FallbackSource();
let tracker: TrackerSource | null = null;
let busy: AbortController | null = null;

async function switchTo(next: EyeSource): Promise<void> {
  source.stop();
  source = next;
  await source.start();
}

/** null — ок, строка — почему не вышло (остаёмся на fallback). */
async function selectSource(kind: 'fallback' | 'tracker'): Promise<string | null> {
  if (busy) return 'Занято: идёт калибровка или запись.';
  try {
    if (kind === 'fallback') {
      await switchTo(new FallbackSource());
      overlay.setStatus('');
      return null;
    }
    overlay.setStatus('Запускаю камеру и модель…');
    tracker ??= new TrackerSource(profile);
    await switchTo(tracker);
    overlay.setStatus(profile.calibrated ? '' : 'Камера работает. Нажми «Калибровка».');
    return null;
  } catch (err) {
    const msg = `Трекер не запустился: ${(err as Error).message}`;
    overlay.setStatus(`${msg}\nОстаюсь на fallback.`);
    await switchTo(new FallbackSource());
    return msg;
  }
}

/** null — профиль принят, строка — почему нет. */
async function calibrate(): Promise<string | null> {
  if (busy) return 'Занято.';
  if (!tracker || source !== tracker) {
    const msg = 'Калибровка нужна для трекера: сначала «Tracker».';
    overlay.setStatus(msg);
    return msg;
  }
  unlockAudio();
  busy = new AbortController();
  try {
    const res = await runCalibration(tracker, busy.signal);
    if (res.profile.calibrated) {
      profile = res.profile;
      tracker.gaze.setProfile(profile);
      saveProfile(profile);
    }
    overlay.setStatus(
      res.fatal.length
        ? `Калибровка НЕ принята, профиль прежний:\n${res.warnings.join('\n')}`
        : res.warnings.length
          ? `Калибровка принята с предупреждениями:\n${res.warnings.join('\n')}`
          : 'Калибровка ок.',
    );
    const r = res.profile;
    overlay.setReport(
      `open L ${r.open.L.toFixed(2)} R ${r.open.R.toFixed(2)} · shut L ${r.shut.L.toFixed(2)} R ${r.shut.R.toFixed(2)}\n` +
        `h ${r.h.left.toFixed(3)} / ${r.h.center.toFixed(3)} / ${r.h.right.toFixed(3)} · closedMs ${r.closedMs}\n` +
        `моргания, мс: ${res.blinkDurationsMs.map((d) => d.toFixed(0)).join(', ') || '—'}`,
    );
    return res.fatal.length ? `Калибровка не принята:\n${res.fatal.join('\n')}` : null;
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    overlay.setStatus(aborted ? 'Калибровка отменена.' : `Ошибка: ${(err as Error).message}`);
    return aborted ? 'Калибровка отменена.' : (err as Error).message;
  } finally {
    busy = null;
  }
}

const overlay = new Overlay({
  async selectSource(kind) {
    await selectSource(kind);
  },

  async loadReplay(file) {
    if (busy) return;
    try {
      const fx = fixtureFromJson(await file.text());
      await switchTo(new ReplaySource(fx));
      overlay.setStatus(`Replay: ${fx.meta.name} (${(fx.meta.durationMs / 1000).toFixed(0)} с)`);
      overlay.setReport(formatReport(evaluate(fx)));
    } catch (err) {
      overlay.setStatus(`Не прочитал фикстуру: ${(err as Error).message}`);
    }
  },

  async calibrate() {
    await calibrate();
  },

  async record(id, conditions) {
    if (busy) return;
    if (!tracker || source !== tracker) {
      overlay.setStatus('Запись фикстур — только с трекером: сначала «Tracker».');
      return;
    }
    if (!profile.calibrated) {
      overlay.setStatus('Сначала калибровка: фикстура хранит профиль, с которым записана.');
      return;
    }
    unlockAudio();
    busy = new AbortController();
    try {
      const fx = await runProtocol(PROTOCOLS[id], tracker, conditions, busy.signal);
      const report = evaluate(fx);
      overlay.setReport(formatReport(report));
      downloadText(`${fx.meta.name}.json`, fixtureToJson(fx));
      overlay.setStatus(`Сохранено ${fx.meta.name}.json → положи в tests/fixtures/`);
    } catch (err) {
      overlay.setStatus((err as Error).name === 'AbortError' ? 'Запись отменена.' : `Ошибка: ${(err as Error).message}`);
    } finally {
      busy = null;
    }
  },
});

addEventListener('keydown', (e) => {
  if (e.code === 'Escape') busy?.abort();
});

interface View {
  frame(state: EyeState, now: number, kind: SourceKind): void;
}

function makeView(): View {
  if (m0) {
    const pg = new Playground(canvas);
    return { frame: (s, now, kind) => pg.draw(s, now, kind) };
  }
  overlay.toggle(); // в игре оверлей скрыт до ё
  return new GameApp(canvas, {
    async startCamera() {
      const err = await selectSource('tracker');
      if (err) return err;
      return profile.calibrated ? null : await calibrate();
    },
    async startKeyboard() {
      await selectSource('fallback');
    },
  });
}

const view = makeView();
let lastFrame = performance.now();
let fps = 60;
void source.start().then(() => requestAnimationFrame(frame));

function frame(now: number): void {
  fps = fps * 0.95 + (1000 / Math.max(now - lastFrame, 1)) * 0.05;
  lastFrame = now;
  const state = source.poll(now);
  view.frame(state, now, source.kind);
  const live = source instanceof TrackerSource || source instanceof ReplaySource ? source : null;
  overlay.update({
    state,
    kind: source.kind,
    raw: live?.lastRaw ?? null,
    score: live ? live.gaze.lastScore : null,
    face: source instanceof TrackerSource ? source.lastFace : null,
    video: source instanceof TrackerSource ? source.video : null,
    stats: source instanceof TrackerSource ? source.stats : null,
    profile: live ? live.gaze.profile : null,
    renderFps: fps,
  });
  requestAnimationFrame(frame);
}

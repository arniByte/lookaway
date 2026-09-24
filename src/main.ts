// M0: tracking spike. Площадка + debug-оверлей, три источника EyeState.
import { config } from './config';
import { runCalibration } from './debug/calibrationWizard';
import { unlockAudio } from './debug/beep';
import { Overlay } from './debug/overlay';
import { Playground } from './debug/playground';
import { runProtocol } from './debug/protocolRunner';
import { downloadText } from './debug/ui';
import { evaluate, formatReport } from './input/evaluate';
import { fixtureFromJson, fixtureToJson } from './input/fixture';
import { defaultProfile } from './input/gaze';
import { PROTOCOLS } from './input/protocols';
import { FallbackSource } from './input/sources/fallbackSource';
import { ReplaySource } from './input/sources/replaySource';
import { TrackerSource } from './input/sources/trackerSource';
import type { CalibrationProfile, EyeSource } from './input/types';

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

const playground = new Playground(document.getElementById('view') as HTMLCanvasElement);
let profile = loadProfile();
let source: EyeSource = new FallbackSource();
let tracker: TrackerSource | null = null;
let busy: AbortController | null = null;

async function switchTo(next: EyeSource): Promise<void> {
  source.stop();
  source = next;
  await source.start();
}

const overlay = new Overlay({
  async selectSource(kind) {
    if (busy) return;
    try {
      if (kind === 'fallback') {
        await switchTo(new FallbackSource());
        overlay.setStatus('');
        return;
      }
      overlay.setStatus('Запускаю камеру и модель…');
      tracker ??= new TrackerSource(profile);
      await switchTo(tracker);
      overlay.setStatus(profile.calibrated ? '' : 'Камера работает. Нажми «Калибровка».');
    } catch (err) {
      overlay.setStatus(`Трекер не запустился: ${(err as Error).message}\nОстаюсь на fallback.`);
      await switchTo(new FallbackSource());
    }
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
    if (busy) return;
    if (!tracker || source !== tracker) {
      overlay.setStatus('Калибровка нужна для трекера: сначала «Tracker».');
      return;
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
    } catch (err) {
      overlay.setStatus((err as Error).name === 'AbortError' ? 'Калибровка отменена.' : `Ошибка: ${(err as Error).message}`);
    } finally {
      busy = null;
    }
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

let lastFrame = performance.now();
let fps = 60;
void source.start().then(() => requestAnimationFrame(frame));

function frame(now: number): void {
  fps = fps * 0.95 + (1000 / Math.max(now - lastFrame, 1)) * 0.05;
  lastFrame = now;
  const state = source.poll(now);
  playground.draw(state, now, source.kind);
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

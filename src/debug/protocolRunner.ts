// Запись фикстуры по протоколу: сигналы звуком и точкой, время сигналов пишется в фикстуру (TECH → Фикстуры).
import type { Protocol } from '../input/protocols';
import { Recorder } from '../input/recorder';
import type { TrackerSource } from '../input/sources/trackerSource';
import type { Fixture, FixtureMeta, Zone } from '../input/types';
import { config } from '../config';
import { beep, doubleBeep } from './beep';
import { fullscreenLayer, gazeToScreen, placeDot, sleep } from './ui';

const READING =
  'В подъезде пахло мокрым бетоном и чужим ужином. Лампочка на четвёртом этаже моргала, ' +
  'и в промежутках между вспышками площадка казалась длиннее, чем была. Кто-то поставил у мусоропровода ' +
  'манекен из закрытого магазина одежды: без рук, в старом пальто, лицом к стене. Утром его там не было.';

const ZONE_X: Record<Zone, number> = { L: -config.gaze.calibTarget, C: 0, R: config.gaze.calibTarget };

export async function runProtocol(
  p: Protocol,
  tracker: TrackerSource,
  conditions: FixtureMeta['conditions'],
  signal: AbortSignal,
): Promise<Fixture> {
  const ui = fullscreenLayer();
  const rec = new Recorder();
  const off = tracker.onRaw((f) => rec.push(f));
  const timers: number[] = [];
  const flash = () => {
    ui.root.style.background = '#333';
    timers.push(window.setTimeout(() => (ui.root.style.background = '#050505'), 120));
  };

  try {
    ui.dot.style.display = p.id === 'calm' ? 'none' : 'block';
    placeDot(ui.dot, 0.5, 0.5);
    for (const n of [3, 2, 1]) {
      ui.text.textContent = `${p.title}\n\n${p.instruction}\n\nСтарт через ${n}…  (Esc — отмена)`;
      await sleep(1000, signal);
    }
    ui.text.textContent = p.id === 'calm' ? `${p.instruction}\n\n${READING}` : p.instruction;

    const t0 = performance.now();
    rec.begin(t0);
    for (const cue of p.cues) {
      timers.push(
        window.setTimeout(() => {
          if (cue.kind === 'look' && cue.zone) {
            placeDot(ui.dot, ...gazeToScreen(ZONE_X[cue.zone], 0));
            beep(440, 60);
          } else {
            beep();
            flash();
          }
        }, cue.t),
      );
      if (cue.durMs) timers.push(window.setTimeout(doubleBeep, cue.t + cue.durMs));
    }
    await sleep(p.durationMs, signal);

    const suffix = `${conditions.glasses ? '-glasses' : ''}${conditions.light === 'low' ? '-lowlight' : ''}`;
    return rec.finish(
      {
        name: `${p.id}${suffix}`,
        protocol: p.id,
        conditions,
        profile: tracker.gaze.profile,
        cues: p.cues.map((c) => ({ ...c })),
      },
      p.durationMs,
    );
  } finally {
    timers.forEach(clearTimeout);
    off();
    rec.active = false;
    ui.destroy();
  }
}

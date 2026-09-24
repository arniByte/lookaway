// Грейбокс M1: титул → вступление → игра → финал → рестарт. Hands-free: старт и рестарт — закрыть и открыть глаза.
import { Sfx } from '../audio/sfx';
import { config } from '../config';
import type { EyeState, SourceKind } from '../input/types';
import { GreyboxView } from '../render/greybox';
import { Screens } from '../ui/screens';
import { FixedStep } from './loop';
import { createGame, stepGame, type GameEvent, type GameState } from './sim';

export interface AppHooks {
  /** Запустить камеру (+ калибровку при необходимости). null — ок, строка — причина отказа. */
  startCamera(): Promise<string | null>;
  startKeyboard(): Promise<void>;
}

type AppPhase = 'title' | 'intro' | 'play' | 'end';

/** 1 раз, 2 раза, 5 раз, 21 раз. */
const plural = (n: number, one: string, few: string, many: string): string => {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
};

const INTRO_COMMON =
  'Продержись до рассвета.\n\n' +
  'Куда смотришь — туда светит фонарь. Освещённые не двигаются.\n' +
  'Моргнёшь — все сделают шаг.\n' +
  'Держи свет на одном — луч сфокусируется. Моргни в этот момент — и он отступит.\n' +
  'Закрой глаза — услышишь эхо: где они и как близко. Откроешь — увидишь, где они были.\n\n';

export class GameApp {
  private view: GreyboxView;
  private sfx = new Sfx();
  private screens = new Screens();
  private loop = new FixedStep(1000 / config.game.simHz, config.game.maxFrameMs);
  private phase: AppPhase = 'title';
  private game: GameState | null = null;
  private kind: SourceKind = 'fallback';
  private armed = false; // видели closeStart — ждём closeEnd для старта
  private endAt = 0;
  private endShown = false;
  private lastNow = 0;
  private busy = false;
  private camera = false;

  constructor(
    canvas: HTMLCanvasElement,
    private hooks: AppHooks,
  ) {
    this.view = new GreyboxView(canvas);
    this.showTitle();
    addEventListener('keydown', (e) => {
      if ((e.code === 'Enter' || e.code === 'KeyR') && this.canStart()) this.start();
    });
  }

  private showTitle(message = ''): void {
    this.phase = 'title';
    this.screens.title(
      () => void this.choose('camera'),
      () => void this.choose('keyboard'),
      message,
    );
  }

  private async choose(mode: 'camera' | 'keyboard'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.sfx.unlock();
    try {
      if (mode === 'camera') {
        this.screens.text('Запускаю камеру…');
        const err = await this.hooks.startCamera();
        if (err) return this.showTitle(err);
      } else {
        await this.hooks.startKeyboard();
      }
      this.camera = mode === 'camera';
      this.showIntro();
    } finally {
      this.busy = false;
    }
  }

  private showIntro(): void {
    this.phase = 'intro';
    this.armed = false;
    this.screens.text(
      INTRO_COMMON +
        (this.camera
          ? 'Закрой глаза. Открой — и ты там.'
          : 'Мышь — взгляд. Space — моргнуть. Держи C — закрыть глаза. Глаза моргают и сами.\n\nЗажми C и отпусти — и ты там. (или Enter)'),
    );
  }

  private canStart(): boolean {
    return this.phase === 'intro' || (this.phase === 'end' && this.endShown);
  }

  private start(): void {
    this.sfx.unlock();
    this.game = createGame((Date.now() ^ Math.floor(Math.random() * 2 ** 31)) >>> 0);
    this.loop = new FixedStep(1000 / config.game.simHz, config.game.maxFrameMs);
    this.phase = 'play';
    this.endShown = false;
    this.armed = false;
    this.screens.hide();
    this.sfx.setDrone(true);
  }

  frame(eye: EyeState, now: number, kind: SourceKind): void {
    const dt = this.lastNow ? now - this.lastNow : 0;
    this.lastNow = now;
    this.kind = kind;

    if (this.canStart()) {
      if (eye.events.includes('closeStart')) this.armed = true;
      if (this.armed && eye.events.includes('closeEnd')) return this.start();
    }

    const g = this.game;
    if (this.phase === 'play' && g) {
      const out: GameEvent[] = [];
      this.loop.advance(dt, eye.events, (events, step) => stepGame(g, eye, events, step, out));
      this.sfx.handle(out);
      this.sfx.heartbeat(g);
      this.screens.paused(g.phase === 'paused');
      if (g.phase === 'dead' || g.phase === 'won') {
        this.phase = 'end';
        this.endAt = now;
        this.sfx.setDrone(false);
        this.sfx.heartbeat(null);
      }
      this.view.render(g, null, dt);
      return;
    }

    if (this.phase === 'end' && g) {
      const since = now - this.endAt;
      this.view.render(g, g.phase === 'dead' ? since : null, dt);
      if (!this.endShown && since >= config.render.endScreenDelayMs) {
        this.endShown = true;
        this.armed = false;
        const s = g.stats;
        const secs = Math.floor(g.t / 1000);
        const restart = this.kind === 'tracker' ? 'Закрой глаза, чтобы начать заново.' : 'Зажми C и отпусти, или Enter.';
        this.screens.text(
          (g.phase === 'won' ? 'Рассвет.' : 'Он дошёл.') +
            `\n\n${secs} с · моргнул ${s.blinks} ${plural(s.blinks, 'раз', 'раза', 'раз')} · ` +
            `отогнал ${s.pushes} · импульсов эха ${s.sweeps}\n\n` +
            restart,
        );
      }
    }
  }
}

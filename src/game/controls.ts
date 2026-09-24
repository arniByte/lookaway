// Режим A (GDD → Управление): WASD + мышь. Клавиши — только через event.code (русская раскладка).
// Импульс — закрыть и открыть глаза. Без камеры глаза — fallback (удержание C, CLAUDE.md, правило 2);
// удержание ЛКМ или F работает так же, как закрытые глаза.
import { config } from '../config';
import type { EyeState } from '../input/types';
import type { PlayerInput } from './player';

export class KeyboardMouse {
  private keys = new Set<string>();
  private dx = 0;
  private dy = 0;
  private held = { mouse: false, key: false };
  private released = false;
  private interact = false;
  private journal = false;
  private recenter = false;
  private palette = false;
  enabled = true;
  /** Кнопки импульса (ЛКМ, F) — только без камеры: с камерой импульс только глазами. */
  scanButtons = true;

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyF') this.held.key = true;
      if (e.code === 'KeyE') this.interact = true;
      if (e.code === 'Tab') this.journal = true;
      if (e.code === 'KeyR') this.recenter = true;
      if (e.code === 'KeyV') this.palette = true;
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyF') this.release('key');
    });
    addEventListener('blur', () => {
      this.keys.clear();
      this.held.mouse = this.held.key = false;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (document.pointerLockElement !== canvas) {
        void canvas.requestPointerLock?.();
        return;
      }
      if (e.button === 0) this.held.mouse = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.release('mouse');
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas && this.enabled) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      }
    });
  }

  private release(which: 'mouse' | 'key'): void {
    if (!this.held[which]) return;
    this.held[which] = false;
    this.released = true;
  }

  /** Кнопка импульса зажата: сканер копит, экран тёмный — как с закрытыми глазами. */
  get scanHeld(): boolean {
    return this.scanButtons && this.enabled && (this.held.mouse || this.held.key);
  }

  /** Кнопку отпустили с прошлого вызова. */
  consumeScanRelease(): boolean {
    const r = this.released && this.scanButtons;
    this.released = false;
    return r;
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  input(): PlayerInput {
    const k = this.keys;
    const on = (...codes: string[]) => (codes.some((c) => k.has(c)) ? 1 : 0);
    const sens = config.player.mouseSens;
    const out: PlayerInput = {
      forward: on('KeyW', 'ArrowUp') - on('KeyS', 'ArrowDown'),
      strafe: on('KeyD') - on('KeyA'),
      run: k.has('ShiftLeft') || k.has('ShiftRight'),
      // Стрелки ←/→ — поворот: игра проходима и без мыши.
      turn: -this.dx * sens + (on('ArrowLeft') - on('ArrowRight')) * config.player.keyTurn,
      look: -this.dy * sens,
    };
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  private take(key: 'interact' | 'journal' | 'recenter' | 'palette'): boolean {
    const v = this[key];
    this[key] = false;
    return v;
  }

  consumeInteract = () => this.take('interact');
  consumeJournal = () => this.take('journal');
  consumeRecenter = () => this.take('recenter');
  consumePalette = () => this.take('palette');
}

/** Импульс глазами: закрыты — копит, открылись — выпуск. Потеря сигнала — никогда (это не «закрыты»). */
export function eyePulse(eye: EyeState): { charging: boolean; release: boolean } {
  if (eye.lost) return { charging: false, release: false };
  return { charging: eye.closed, release: eye.events.includes('closeEnd') };
}

/**
 * Режим B (эксперимент): всё глазами. Держишь глаза закрытыми — идёшь вперёд вслепую (и копишь импульс);
 * взгляд у края экрана — поворот; задержал взгляд в центре — действие.
 * Читает только EyeState (CLAUDE.md, правило 1).
 */
export class HandsFree {
  private dwell = 0;

  update(eye: EyeState, dtMs: number, hasPrompt: boolean): { input: PlayerInput; interact: boolean } {
    const h = config.handsFree;
    const input: PlayerInput = { forward: 0, strafe: 0, run: false, turn: 0, look: 0 };
    let interact = false;
    if (eye.lost) return { input, interact };
    if (eye.closed) input.forward = 1;
    const open = !eye.blink && !eye.closed;
    if (open) {
      const gx = eye.gaze.x;
      const gy = eye.gaze.y;
      if (Math.abs(gx) > h.edge) input.turn = -Math.sign(gx) * h.turn * ((Math.abs(gx) - h.edge) / (1 - h.edge));
      if (Math.abs(gy) > h.edgeY) input.look = Math.sign(gy) * h.look;
      const centered = Math.hypot(gx, gy) < h.dwellRadius;
      this.dwell = hasPrompt && centered ? this.dwell + dtMs : 0;
      if (this.dwell >= h.dwellMs) {
        this.dwell = 0;
        interact = true;
      }
    } else {
      this.dwell = 0;
    }
    return { input, interact };
  }

  /** 0..1 — прогресс задержки взгляда (для HUD). */
  get dwellProgress(): number {
    return Math.min(1, this.dwell / config.handsFree.dwellMs);
  }
}

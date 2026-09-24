// Режим A (GDD → Управление): WASD + мышь. Клавиши — только через event.code (русская раскладка).
// Space, C, L заняты fallback-глазами (CLAUDE.md, правило 2), поэтому скан — ЛКМ или F.
import { config } from '../config';
import type { EyeState } from '../input/types';
import type { PlayerInput } from './player';

export class KeyboardMouse {
  private keys = new Set<string>();
  private dx = 0;
  private dy = 0;
  private scan = false;
  private interact = false;
  private journal = false;
  private recenter = false;
  enabled = true;

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyF') this.scan = true;
      if (e.code === 'KeyE') this.interact = true;
      if (e.code === 'Tab') this.journal = true;
      if (e.code === 'KeyR') this.recenter = true;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (document.pointerLockElement !== canvas) {
        void canvas.requestPointerLock?.();
        return;
      }
      if (e.button === 0) this.scan = true;
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas && this.enabled) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      }
    });
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

  private take(key: 'scan' | 'interact' | 'journal' | 'recenter'): boolean {
    const v = this[key];
    this[key] = false;
    return v;
  }

  consumeScan = () => this.take('scan');
  consumeInteract = () => this.take('interact');
  consumeJournal = () => this.take('journal');
  consumeRecenter = () => this.take('recenter');
}

/**
 * Режим B (эксперимент): всё глазами. Держишь глаза закрытыми — идёшь вперёд вслепую;
 * взгляд у края экрана — поворот; открыл глаза — импульс; задержал взгляд в центре — действие.
 * Читает только EyeState (CLAUDE.md, правило 1).
 */
export class HandsFree {
  private dwell = 0;

  update(eye: EyeState, dtMs: number, hasPrompt: boolean): { input: PlayerInput; scan: boolean; interact: boolean } {
    const h = config.handsFree;
    const input: PlayerInput = { forward: 0, strafe: 0, run: false, turn: 0, look: 0 };
    let scan = false;
    let interact = false;
    if (eye.lost) return { input, scan, interact };
    if (eye.closed) input.forward = 1;
    if (eye.events.includes('closeEnd')) scan = true;
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
    return { input, scan, interact };
  }

  /** 0..1 — прогресс задержки взгляда (для HUD). */
  get dwellProgress(): number {
    return Math.min(1, this.dwell / config.handsFree.dwellMs);
  }
}

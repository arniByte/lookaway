// HUD сканера (GDD → HUD): без прицела. Компас с маяком, счётчик видов, заряд, рамки цели в мире,
// удержание угрозы, накопление импульса в темноте, уведомления. Canvas 2D поверх облака.
import { wrapAngle } from '../game/nav';
import { ACCENT, DANGER, INK, MONO, SANS, SERIF } from './theme';

export interface HudTarget {
  x: number; // CSS-пикс., центр цели на экране
  y: number;
  half: number; // полуразмер рамки
  title: string;
  latin: boolean;
  sub: string;
  action: { key: string | null; text: string } | null;
  tone: 'unknown' | 'known' | 'beacon';
  dwell: number; // 0..1 — задержка взгляда (hands-free)
}

export interface HudState {
  heading: number; // курс, рад
  beacon: { bearing: number; dist: number };
  extractReady: boolean;
  documented: number;
  goal: number;
  total: number;
  palette: string;
  charge: number; // 0..1
  power: number; // 0..1 накоплено с закрытыми глазами
  charging: boolean;
  range: number; // м при текущей мощности
  hint: string; // как выпустить импульс (первые разы)
  blackout: number; // 0..1: глаза закрыты — экран тёмный
  target: HudTarget | null;
  hold: { x: number; y: number; left: number } | null; // чёрная материя удерживается взглядом
  danger: number; // 0..1
}

interface Toast {
  kicker: string;
  title: string;
  latin: boolean;
  sub: string;
  at: number;
  until: number;
}

const TAPE_SPAN = (110 * Math.PI) / 180; // видимая часть компаса
const CARDINAL = ['С', 'В', 'Ю', 'З'];

export class Hud {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private toasts: Toast[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;transition:opacity .5s';
    document.body.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  set visible(v: boolean) {
    this.canvas.style.opacity = v ? '1' : '0';
  }

  toast(kicker: string, title: string, sub: string, now: number, ms = 4500, latin = false): void {
    this.toasts.push({ kicker, title, latin, sub, at: now, until: now + ms });
    if (this.toasts.length > 2) this.toasts.shift();
  }

  draw(s: HudState, now: number): void {
    const dpr = Math.min(devicePixelRatio, 2);
    const W = innerWidth;
    const H = innerHeight;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.textBaseline = 'alphabetic';

    if (s.danger > 0.01) {
      const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, DANGER(0));
      g.addColorStop(1, DANGER(0.22 * Math.min(1, s.danger)));
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }

    // Подложки сверху и снизу: текст читается поверх яркой земли.
    for (const [y0, y1] of [[0, 120], [H, H - 110]]) {
      const g = c.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, 'rgba(0,0,0,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0));
    }

    const dim = 1 - Math.min(1, s.blackout) * 0.85;
    c.globalAlpha = dim;
    this.compass(s, W);
    this.counters(s, W);
    this.charge(s, W, H);
    if (s.target && s.blackout < 0.5) this.bracket(s.target, W, now);
    if (s.hold && s.blackout < 0.5) this.holdMark(s.hold);
    c.globalAlpha = 1;
    if (s.blackout > 0.3 && s.charging) this.accumulating(s, W, H);
    this.drawToasts(W, now);
  }

  private text(t: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'left', spacing = '0px'): number {
    const c = this.ctx;
    c.font = font;
    c.fillStyle = color;
    c.textAlign = align;
    c.letterSpacing = spacing;
    c.fillText(t, x, y);
    const w = c.measureText(t).width;
    c.letterSpacing = '0px';
    return w;
  }

  private kicker(t: string, x: number, y: number, color = INK(0.45), align: CanvasTextAlign = 'left'): number {
    return this.text(t.toUpperCase(), x, y, `500 10.5px ${SANS}`, color, align, '2px');
  }

  /** Лента компаса сверху: риски, стороны света, маяк. */
  private compass(s: HudState, W: number): void {
    const c = this.ctx;
    const cx = W / 2;
    const y = 44;
    const half = Math.min(260, W * 0.3);
    const xOf = (rel: number) => cx + (rel / (TAPE_SPAN / 2)) * half;
    const fade = (x: number) => Math.max(0, 1 - Math.abs(x - cx) / half) ** 0.6;
    c.lineWidth = 1;
    for (let deg = 0; deg < 360; deg += 5) {
      const rel = wrapAngle((deg * Math.PI) / 180 - s.heading);
      if (Math.abs(rel) > TAPE_SPAN / 2) continue;
      const x = xOf(rel);
      const a = fade(x);
      const major = deg % 15 === 0;
      c.strokeStyle = INK((major ? 0.55 : 0.25) * a);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x, y - (major ? 7 : 4));
      c.stroke();
      if (deg % 90 === 0) this.text(CARDINAL[deg / 90], x, y - 13, `500 11px ${SANS}`, INK(0.85 * a), 'center');
      else if (deg % 30 === 0) this.text(String(deg), x, y - 13, `400 9.5px ${MONO}`, INK(0.4 * a), 'center');
    }
    c.fillStyle = INK(0.9);
    c.beginPath();
    c.moveTo(cx, y + 3);
    c.lineTo(cx - 4, y + 9);
    c.lineTo(cx + 4, y + 9);
    c.fill();
    const hd = Math.round((((s.heading * 180) / Math.PI) % 360 + 360) % 360);
    this.text(String(hd).padStart(3, '0') + '°', cx, y + 24, `400 10.5px ${MONO}`, INK(0.55), 'center');

    // Маяк: ромб на ленте или стрелка у края.
    const rel = wrapAngle(s.beacon.bearing - s.heading);
    const inside = Math.abs(rel) <= TAPE_SPAN / 2;
    const bx = inside ? xOf(rel) : cx + Math.sign(rel) * (half + 14);
    const col = ACCENT(s.extractReady ? 1 : 0.8);
    c.fillStyle = col;
    c.beginPath();
    if (inside) {
      c.moveTo(bx, y - 22);
      c.lineTo(bx + 4, y - 18);
      c.lineTo(bx, y - 14);
      c.lineTo(bx - 4, y - 18);
    } else {
      const d = Math.sign(rel);
      c.moveTo(bx + d * 5, y - 4);
      c.lineTo(bx - d * 2, y - 8);
      c.lineTo(bx - d * 2, y);
    }
    c.fill();
    const label = `маяк ${Math.round(s.beacon.dist)} м`;
    if (inside) this.text(label, bx, y - 27, `400 10px ${SANS}`, ACCENT(0.75), 'center');
    else this.text(label, bx + Math.sign(rel) * 10, y - 1, `400 10px ${SANS}`, ACCENT(0.75), rel > 0 ? 'left' : 'right');
  }

  private counters(s: HudState, W: number): void {
    const c = this.ctx;
    const x = 30;
    this.kicker('Описано', x, 32);
    const w = this.text(String(s.documented), x, 60, `300 26px ${SANS}`, INK(0.95));
    this.text(` / ${s.goal}`, x + w, 60, `300 16px ${SANS}`, INK(0.45));
    for (let i = 0; i < s.goal; i++) {
      c.beginPath();
      c.arc(x + 3 + i * 11, 74, 2.6, 0, Math.PI * 2);
      if (i < s.documented) {
        c.fillStyle = INK(0.9);
        c.fill();
      } else {
        c.strokeStyle = INK(0.35);
        c.lineWidth = 1;
        c.stroke();
      }
    }
    this.text(`видов в долине ${s.total} · Tab — журнал`, x, 96, `400 11.5px ${SANS}`, INK(0.38));
    this.kicker(`905 нм · ${s.palette}`, W - 30, 32, INK(0.38), 'right');
    this.text('V — палитра', W - 30, 50, `400 11px ${SANS}`, INK(0.28), 'right');
  }

  /** Заряд: тонкая линия внизу. Копится мощность — янтарём поверх. */
  private charge(s: HudState, W: number, H: number): void {
    const c = this.ctx;
    const w = 180;
    const x = W / 2 - w / 2;
    const y = H - 40;
    const ready = s.charge >= 1;
    this.kicker('Импульс', x, y - 10);
    this.text(ready ? (s.charging ? `${Math.round(s.range)} м` : 'готов') : `${Math.round(s.charge * 100)}%`, x + w, y - 10, `500 11px ${SANS}`, ready ? INK(0.9) : INK(0.5), 'right');
    c.fillStyle = INK(0.16);
    c.fillRect(x, y, w, 1);
    c.fillStyle = INK(ready ? 0.95 : 0.6);
    c.fillRect(x, y - 0.5, w * Math.min(1, s.charge), 2);
    if (s.power > 0) {
      c.fillStyle = ACCENT(0.95);
      c.fillRect(x, y - 1, w * s.power, 3);
    }
    if (s.hint && ready) this.text(s.hint, W / 2, y + 20, `400 12px ${SANS}`, INK(0.45), 'center');
  }

  /** Рамка цели в мире: уголки + подпись справа. */
  private bracket(t: HudTarget, W: number, now: number): void {
    const c = this.ctx;
    const col = t.tone === 'unknown' ? ACCENT : INK;
    const a = t.tone === 'known' ? 0.5 : 0.95;
    const h = Math.max(14, Math.min(90, t.half));
    const k = Math.max(6, h * 0.3);
    const breathe = t.tone === 'unknown' ? 1 + 0.04 * Math.sin(now / 260) : 1;
    const hh = h * breathe;
    c.strokeStyle = col(a);
    c.lineWidth = 1.25;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const px = t.x + sx * hh;
      const py = t.y + sy * hh;
      c.beginPath();
      c.moveTo(px, py - sy * k);
      c.lineTo(px, py);
      c.lineTo(px - sx * k, py);
      c.stroke();
    }
    if (t.dwell > 0) {
      c.fillStyle = col(0.9);
      c.fillRect(t.x - hh, t.y + hh + 6, 2 * hh * t.dwell, 2);
    }
    const right = t.x + hh + 16 + 220 < W;
    const lx = right ? t.x + hh + 16 : t.x - hh - 16;
    const align: CanvasTextAlign = right ? 'left' : 'right';
    let y = t.y - hh + 12;
    if (t.latin) this.text(t.title, lx, y + 4, `italic 400 18px ${SERIF}`, col(a), align);
    else this.kicker(t.title, lx, y, col(a), align);
    y += 20;
    if (t.sub) {
      this.text(t.sub, lx, y, `400 12.5px ${SANS}`, INK(0.5), align);
      y += 22;
    }
    if (t.action) {
      c.font = `500 13px ${SANS}`;
      const tw = c.measureText(t.action.text).width;
      let x = right ? lx : lx - tw - (t.action.key ? 30 : 0);
      if (t.action.key) {
        c.strokeStyle = INK(0.5);
        c.lineWidth = 1;
        c.beginPath();
        c.roundRect(x, y - 14, 21, 19, 4);
        c.stroke();
        this.text(t.action.key, x + 10.5, y, `500 11px ${MONO}`, INK(0.95), 'center');
        x += 30;
      }
      this.text(t.action.text, x, y, `500 13px ${SANS}`, INK(0.9), 'left');
    }
  }

  private holdMark(hd: { x: number; y: number; left: number }): void {
    const c = this.ctx;
    const r = 34;
    c.strokeStyle = DANGER(0.25);
    c.lineWidth = 1;
    c.beginPath();
    c.arc(hd.x, hd.y, r, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = DANGER(0.95);
    c.lineWidth = 2;
    c.beginPath();
    c.arc(hd.x, hd.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, hd.left));
    c.stroke();
    this.kicker('Удержание', hd.x, hd.y + r + 18, DANGER(0.9), 'center');
  }

  /** В темноте: кольцо дальности растёт, пока глаза закрыты (видно без камеры и зрителям). */
  private accumulating(s: HudState, W: number, H: number): void {
    const c = this.ctx;
    const cx = W / 2;
    const cy = H / 2;
    const r = 26 + s.power * Math.min(W, H) * 0.22;
    c.strokeStyle = INK(0.12);
    c.lineWidth = 1;
    c.beginPath();
    c.arc(cx, cy, 26 + Math.min(W, H) * 0.22, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = ACCENT(0.85);
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.stroke();
    this.kicker(s.charge >= 1 ? 'Накопление' : 'Заряд', cx, cy - 6, INK(0.5), 'center');
    this.text(s.charge >= 1 ? `${Math.round(s.range)} м` : `${Math.round(s.charge * 100)}%`, cx, cy + 16, `300 18px ${SANS}`, INK(0.85), 'center');
  }

  private drawToasts(W: number, now: number): void {
    this.toasts = this.toasts.filter((t) => t.until > now);
    let y = 116;
    for (const t of this.toasts) {
      const a = Math.min(1, (now - t.at) / 300, (t.until - now) / 600);
      this.ctx.globalAlpha = a;
      this.kicker(t.kicker, W / 2, y, ACCENT(0.95), 'center');
      if (t.latin) this.text(t.title, W / 2, y + 26, `italic 400 22px ${SERIF}`, INK(0.95), 'center');
      else this.text(t.title, W / 2, y + 24, `300 18px ${SANS}`, INK(0.95), 'center');
      if (t.sub) this.text(t.sub, W / 2, y + 46, `400 12.5px ${SANS}`, INK(0.55), 'center');
      y += 76;
    }
    this.ctx.globalAlpha = 1;
  }
}

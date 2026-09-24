// HUD — экран сканера (GDD → HUD): прицел, взгляд, заряд, маяк, счётчик видов, подсказки, тосты.
export interface HudState {
  charge: number; // 0..1
  beaconBearing: number | null; // рад относительно взгляда камеры, 0 — прямо
  documented: number;
  goal: number;
  total: number;
  prompt: string;
  gaze: { x: number; y: number } | null; // −1..1, только с камерой
  danger: number; // 0..1 близость чёрной материи (виньетка)
  holding: boolean; // держишь её взглядом
  extractReady: boolean;
}

interface Toast {
  text: string;
  until: number;
}

export class Hud {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private toasts: Toast[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:3';
    document.body.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  set visible(v: boolean) {
    this.canvas.style.display = v ? 'block' : 'none';
  }

  toast(text: string, now: number, ms = 4000): void {
    this.toasts.push({ text, until: now + ms });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  draw(s: HudState, now: number): void {
    const dpr = Math.min(devicePixelRatio, 2);
    const W = innerWidth * dpr;
    const H = innerHeight * dpr;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const u = dpr;

    // Виньетка опасности: краснеет с близостью, пульсирует, пока держишь взглядом.
    if (s.danger > 0.01 || s.holding) {
      const k = Math.min(1, s.danger) * (s.holding ? 0.75 + 0.25 * Math.sin(now / 90) : 1);
      const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, 'rgba(120,0,0,0)');
      g.addColorStop(1, `rgba(120,0,10,${(0.55 * k).toFixed(3)})`);
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }

    // Прицел.
    c.strokeStyle = 'rgba(160,230,255,0.55)';
    c.lineWidth = u;
    c.beginPath();
    c.arc(W / 2, H / 2, 6 * u, 0, Math.PI * 2);
    c.stroke();

    // Взгляд (с камерой): туда смотрят глаза — им держат чёрную материю.
    if (s.gaze) {
      const gx = ((s.gaze.x + 1) / 2) * W;
      const gy = ((1 - s.gaze.y) / 2) * H;
      c.strokeStyle = s.holding ? 'rgba(255,90,80,0.9)' : 'rgba(255,200,120,0.45)';
      c.beginPath();
      c.arc(gx, gy, 14 * u, 0, Math.PI * 2);
      c.stroke();
    }

    // Кольцо заряда + засечка маяка.
    const cx = W / 2;
    const cy = H - 64 * u;
    const R = 26 * u;
    c.lineWidth = 3 * u;
    c.strokeStyle = 'rgba(80,140,160,0.35)';
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.stroke();
    const ready = s.charge >= 1;
    c.strokeStyle = ready ? `rgba(140,240,255,${0.75 + 0.25 * Math.sin(now / 200)})` : 'rgba(110,200,230,0.8)';
    c.beginPath();
    c.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * s.charge);
    c.stroke();
    if (s.beaconBearing !== null) {
      const a = -Math.PI / 2 - s.beaconBearing;
      c.fillStyle = s.extractReady ? 'rgba(255,215,110,1)' : 'rgba(255,215,110,0.6)';
      c.beginPath();
      c.arc(cx + Math.cos(a) * (R + 8 * u), cy + Math.sin(a) * (R + 8 * u), 3 * u, 0, Math.PI * 2);
      c.fill();
    }
    c.font = `${11 * u}px ui-monospace, Menlo, Consolas, monospace`;
    c.textAlign = 'center';
    c.fillStyle = ready ? 'rgba(160,240,255,0.9)' : 'rgba(120,180,200,0.6)';
    c.fillText(ready ? 'ИМПУЛЬС' : `${Math.round(s.charge * 100)}%`, cx, cy + 4 * u);

    // Счётчик видов.
    c.textAlign = 'left';
    c.font = `${13 * u}px ui-monospace, Menlo, Consolas, monospace`;
    c.fillStyle = 'rgba(170,220,235,0.85)';
    c.fillText(`виды ${s.documented}/${s.goal}`, 18 * u, 28 * u);
    c.fillStyle = 'rgba(120,160,175,0.6)';
    c.font = `${11 * u}px ui-monospace, Menlo, Consolas, monospace`;
    c.fillText(`в этом мире ${s.total} · Tab — журнал`, 18 * u, 46 * u);

    // Подсказка.
    if (s.prompt) {
      c.textAlign = 'center';
      c.font = `${14 * u}px ui-monospace, Menlo, Consolas, monospace`;
      c.fillStyle = 'rgba(230,245,250,0.92)';
      c.fillText(s.prompt, cx, cy - R - 20 * u);
    }

    // Тосты.
    this.toasts = this.toasts.filter((t) => t.until > now);
    c.textAlign = 'center';
    c.font = `${15 * u}px ui-monospace, Menlo, Consolas, monospace`;
    this.toasts.forEach((t, i) => {
      const a = Math.min(1, (t.until - now) / 600);
      c.fillStyle = `rgba(255,225,170,${a.toFixed(3)})`;
      c.fillText(t.text, W / 2, 70 * u + i * 24 * u);
    });
  }
}

// M0-площадка: три зоны, луч по взгляду, темнота на моргании, точки при закрытых, статика при потере.
// Не игра и не рендер из TECH — только чтобы глазами проверить EyeState.
import { config } from '../config';
import type { EyeState, SourceKind, Zone } from '../input/types';

const ZONES: Zone[] = ['L', 'C', 'R'];
const BEAM_FOLLOW = 0.18; // доля пути за кадр — визуальная инерция луча, не игровая логика

export class Playground {
  private ctx: CanvasRenderingContext2D;
  private beam = { x: 0, y: 0 };
  private noise: HTMLCanvasElement;
  private dots: [number, number][];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.noise = document.createElement('canvas');
    this.noise.width = 160;
    this.noise.height = 90;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    this.dots = Array.from({ length: 900 }, () => [rnd(), rnd()]);
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  private resize(): void {
    this.canvas.width = innerWidth * devicePixelRatio;
    this.canvas.height = innerHeight * devicePixelRatio;
  }

  draw(s: EyeState, now: number, source: SourceKind): void {
    const { ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const px = devicePixelRatio;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (s.lost) {
      this.drawStatic();
      this.label('СИГНАЛ ПОТЕРЯН — лицо не видно или слишком темно', W / 2, H / 2, 20 * px, '#bbb');
    } else if (s.closed) {
      const scan = ((now / 1600) % 1) * H;
      for (const [dx, dy] of this.dots) {
        const y = dy * H;
        const a = Math.max(0.08, 1 - Math.abs(y - scan) / (H * 0.25));
        ctx.fillStyle = `rgba(90,200,255,${a.toFixed(2)})`;
        ctx.fillRect(dx * W, y, 2 * px, 2 * px);
      }
      this.label('глаза закрыты (closed)', W / 2, H * 0.92, 16 * px, '#6cf');
    } else if (!s.blink) {
      this.beam.x += (s.gaze.x - this.beam.x) * BEAM_FOLLOW;
      this.beam.y += (s.gaze.y - this.beam.y) * BEAM_FOLLOW;
      const zi = ZONES.indexOf(s.zone);
      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect((zi * W) / 3, 0, W / 3, H);
      const bx = ((this.beam.x + 1) / 2) * W;
      const by = ((1 - this.beam.y) / 2) * H;
      const r = Math.min(W, H) * (0.22 - 0.06 * s.wide);
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, r);
      g.addColorStop(0, 'rgba(255,240,210,0.85)');
      g.addColorStop(1, 'rgba(255,240,210,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#222';
      ctx.lineWidth = px;
      for (const b of [-config.zones.boundary, config.zones.boundary]) {
        const x = ((b + 1) / 2) * W;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      ZONES.forEach((z, i) => this.label(z, ((i + 0.5) * W) / 3, H * 0.08, 28 * px, z === s.zone ? '#fff' : '#333'));
      if (s.squint > 0.05) this.label(`прищур ${s.squint.toFixed(2)}`, W / 2, H * 0.92, 14 * px, '#c7c');
      if (s.wink) this.label(`wink ${s.wink}`, W / 2, H * 0.88, 14 * px, '#fc6');
    }
    // blink: просто темно — так и должно быть

    const hint =
      source === 'fallback'
        ? 'fallback: мышь — взгляд, Space — моргнуть, держи C — закрыть глаза, держи L — потеря сигнала.  ` (ё) — debug'
        : '` (ё) — debug';
    this.label(hint, W / 2, H - 14 * px, 12 * px, '#444');
  }

  private drawStatic(): void {
    const n = this.noise.getContext('2d')!;
    const img = n.createImageData(this.noise.width, this.noise.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 90;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    n.putImageData(img, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.noise, 0, 0, this.canvas.width, this.canvas.height);
  }

  private label(text: string, x: number, y: number, size: number, color: string): void {
    const { ctx } = this;
    ctx.font = `${size}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}

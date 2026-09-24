// Экраны вне игры: титул, вступление, пауза, финал. Во время игры HUD нет (GDD → Столпы).
import { button, el } from '../debug/ui';

export class Screens {
  private root: HTMLDivElement;
  private body: HTMLDivElement;
  private noise: HTMLCanvasElement;
  private noiseLabel: HTMLDivElement;
  private noiseTimer = 0;

  constructor() {
    this.body = el('div', 'max-width:640px;padding:0 20px;text-align:center;white-space:pre-wrap;line-height:1.6;font-size:16px;color:#bbb');
    this.root = el(
      'div',
      'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:5;background:rgba(0,0,0,.82)',
      this.body,
    );
    this.noise = el('canvas', 'position:fixed;inset:0;width:100%;height:100%;image-rendering:pixelated;z-index:4;display:none;opacity:.55');
    this.noise.width = 160;
    this.noise.height = 90;
    this.noiseLabel = el(
      'div',
      'position:fixed;left:0;right:0;top:45%;text-align:center;z-index:4;display:none;color:#ddd;font-size:18px;text-shadow:0 0 6px #000',
      'Сигнал потерян.\nЛицо не видно или слишком темно — добавь света на лицо.',
    );
    this.noiseLabel.style.whiteSpace = 'pre-wrap';
    document.body.append(this.noise, this.noiseLabel, this.root);
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  text(content: string, extra: HTMLElement[] = []): void {
    this.body.replaceChildren(content, ...extra);
    this.root.style.display = 'flex';
  }

  title(onCamera: () => void, onKeyboard: () => void, message = '', onHandsFree?: () => void): void {
    const row = el('div', 'display:flex;gap:12px;justify-content:center;margin-top:28px;flex-wrap:wrap');
    const bs = [button('Играть с камерой', onCamera), button('Мышь и клавиатура', onKeyboard)];
    if (onHandsFree) bs.push(button('Hands-free (эксперимент)', onHandsFree));
    for (const b of bs) b.style.cssText += ';padding:10px 18px;font-size:15px';
    row.append(...bs);
    this.text('', [
      el('div', 'font-size:34px;letter-spacing:.35em;color:#eee;margin-bottom:8px', 'LOOK AWAY'),
      el('div', 'letter-spacing:.3em;color:#6cf;margin-bottom:24px', 'ПОЛЕВОЙ ЛИДАР'),
      el(
        'div',
        '',
        'Миры без света. Ты видишь только то, что отсканировал, — и только пока помнишь.\n' +
          'Изучай местную жизнь. Тебя ищет чёрная материя.\n\n' +
          'Камера: моргание стирает скан, взгляд держит угрозу. Видео обрабатывается только на этом устройстве.\n' +
          'Лучше в наушниках и в темноте, но так, чтобы экран освещал лицо.',
      ),
      row,
      el('div', 'margin-top:18px;color:#c96', message),
      el('div', 'margin-top:28px;color:#555;font-size:12px', '` (ё) — debug'),
    ]);
  }

  /** Пауза при потере сигнала: статика вместо мира (TECH → Потеря сигнала). */
  paused(on: boolean): void {
    this.noise.style.display = on ? 'block' : 'none';
    this.noiseLabel.style.display = on ? 'block' : 'none';
    if (!on) {
      cancelAnimationFrame(this.noiseTimer);
      this.noiseTimer = 0;
      return;
    }
    if (this.noiseTimer) return;
    const ctx = this.noise.getContext('2d')!;
    let last = 0;
    const draw = (now: number) => {
      if (now - last > 90) {
        last = now;
        const img = ctx.createImageData(this.noise.width, this.noise.height);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = Math.random() * 110;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
      }
      this.noiseTimer = requestAnimationFrame(draw);
    };
    this.noiseTimer = requestAnimationFrame(draw);
  }
}

// Мелкие DOM-хелперы для debug-UI. Без фреймворков (CLAUDE.md → Stack).

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style = '',
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  e.append(...children);
  return e;
}

export function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', '', label);
  b.addEventListener('click', () => {
    b.blur(); // Space в fallback не должен нажимать кнопку
    onClick();
  });
  return b;
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** Полноэкранный слой для мастера калибровки и записи протоколов. */
export function fullscreenLayer(): { root: HTMLDivElement; text: HTMLDivElement; dot: HTMLDivElement; destroy(): void } {
  const text = el('div', 'position:absolute;left:0;right:0;top:12%;text-align:center;font-size:20px;color:#ddd;padding:0 16px;white-space:pre-wrap');
  const dot = el('div', 'position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#fff;box-shadow:0 0 12px #fff;left:50%;top:50%;transition:left .08s,top .08s');
  const root = el('div', 'position:fixed;inset:0;background:#050505;z-index:20', text, dot);
  document.body.append(root);
  return { root, text, dot, destroy: () => root.remove() };
}

export function placeDot(dot: HTMLElement, fx: number, fy: number): void {
  dot.style.left = `${fx * 100}%`;
  dot.style.top = `${fy * 100}%`;
}

/** Позиция на экране (доли) для цели в координатах gaze (−1..1, y вверх). */
export const gazeToScreen = (x: number, y: number): [number, number] => [(x + 1) / 2, (1 - y) / 2];

// DOM-хелперы интерфейса. Без фреймворков (CLAUDE.md → Stack).

export type Child = Node | string | null | false | undefined;

/** h('div.kicker', 'текст') — тег с классами через точку и дети (null/false пропускаются). */
export function h<K extends keyof HTMLElementTagNameMap>(spec: K | `${K}.${string}`, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split('.');
  const e = document.createElement(tag as K);
  if (classes.length) e.className = classes.join(' ');
  for (const c of children) if (c !== null && c !== false && c !== undefined) e.append(c);
  return e;
}

export function btn(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button.btn', label);
  if (cls) b.classList.add(...cls.split(' '));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    b.blur(); // Space в fallback не должен нажимать кнопку
    onClick();
  });
  return b;
}

export const kbd = (k: string) => h('kbd', k);

/** Латинское биномиальное название: курсив с засечками. */
export const latin = (name: string) => h('span.latin', name);

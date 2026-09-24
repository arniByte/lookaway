// Экраны вне игры: титул, бриф, загрузка, финал, пауза потери сигнала. Переходы — кроссфейд.
import { btn, h, kbd, latin, type Child } from './dom';

export interface TitleOpts {
  onCamera(): void;
  onKeyboard(): void;
  onHandsFree(): void;
  onDaily(): void;
  daily: string; // подпись «мира дня»
  message?: string;
}

export interface BriefOpts {
  seed: number;
  daily: boolean;
  goal: number;
  camera: boolean;
  handsFree: boolean;
}

export interface EndOpts {
  dead: boolean;
  time: string;
  documented: { name: string; ru: string }[];
  total: number;
  pulses: number;
  seed: number;
  camera: boolean;
  onNew(): void;
  onSame(): void;
}

export class Screens {
  private current: HTMLElement | null = null;
  private lostEl: HTMLElement;

  constructor() {
    this.lostEl = h(
      'div.lost.ui',
      h('div', h('div.kicker.accent', 'Сигнал потерян'), h('div.h2', 'Пауза'), h('p', 'Лицо не видно или слишком темно. Добавь света на лицо — игра продолжится сама.')),
    );
    document.body.append(this.lostEl);
  }

  private show(cls: string, ...content: Child[]): HTMLElement {
    const next = h('div.screen.ui', h('div.inner', ...content));
    for (const c of cls.split(' ')) if (c) next.classList.add(c);
    document.body.append(next);
    void next.offsetWidth; // зафиксировать начальное состояние для перехода
    next.classList.add('on');
    this.retire();
    this.current = next;
    return next;
  }

  private retire(): void {
    const old = this.current;
    if (!old) return;
    old.classList.remove('on');
    setTimeout(() => old.remove(), 600);
    this.current = null;
  }

  hide(): void {
    this.retire();
  }

  title(o: TitleOpts): void {
    this.show(
      'title clear',
      h(
        'div.col',
        h('div.kicker', 'Полевой лидар · экспедиция'),
        h('h1.display', 'LOOK AWAY'),
        h('p.lede', 'Долина без света. Ты видишь только то, что отсканировал, — и только пока помнишь. Опиши местную жизнь. Прошлая экспедиция всё ещё здесь.'),
        h('div.row.actions', btn('Начать с камерой', o.onCamera, 'primary'), btn('Без камеры', o.onKeyboard)),
        h('div.row.links', btn(o.daily, o.onDaily, 'link'), btn('Только глазами · эксперимент', o.onHandsFree, 'link')),
        o.message ? h('div.msg', o.message) : null,
      ),
      h(
        'div.foot.small.muted',
        h('span', 'Видео с камеры обрабатывается только на этом устройстве и никуда не отправляется.'),
        h('span', 'Лучше в наушниках, в полутьме, чтобы экран освещал лицо'),
      ),
    );
  }

  status(kicker: string, text: string, bar = false): void {
    this.show('loading', h('div.kicker', kicker), h('div.h2', text), bar ? h('div.bar', h('i')) : null);
  }

  brief(o: BriefOpts): void {
    const item = (k: string, t: string) => h('div.item', h('div.kicker', k), h('p', t));
    const key = (keys: (string | HTMLElement)[], label: string, hl = false) => [
      h('div', ...keys.map((k) => (typeof k === 'string' ? kbd(k) : k))),
      h(hl ? 'div.hl' : 'div', label),
    ];
    const eyes = h('span.small', 'закрыть глаза');
    const keys = [
      ...(o.camera ? key([eyes], 'импульс: закрой глаза, открой — скан. Дольше — дальше.', true) : key(['ЛКМ', 'F', 'C'], 'удерживать — копить импульс, отпустить — скан', true)),
      ...(o.handsFree ? key([h('span.small', 'глаза закрыты')], 'идти вперёд вслепую') : key(['W', 'A', 'S', 'D'], 'идти · Shift — бежать')),
      ...(o.handsFree ? key([h('span.small', 'взгляд у края')], 'повернуться') : key([h('span.small', 'мышь')], 'обзор · ← → тоже')),
      ...(o.handsFree ? key([h('span.small', 'взгляд на цели')], 'взять образец') : key(['E'], 'образец · запись экспедиции · эвакуация')),
      ...key(['Tab'], 'журнал'),
      ...key(['V'], 'палитра облака'),
      ...(o.camera ? key(['R'], 'перецентровать взгляд') : key(['Space'], 'моргнуть (глаза моргают и сами)')),
    ];
    this.show(
      'brief',
      h('div.kicker', `${o.daily ? 'Мир дня' : 'Экспедиция'} · № ${o.seed}`),
      h('div.h2', `Опиши ${o.goal} видов и вернись к маяку.`),
      h(
        'div.grid',
        h(
          'div',
          item('Сканер', 'Закрой глаза — сканер копит импульс, открой — увидишь долину. Дольше темнота — дальше скан.'),
          item('Память', 'Облако держится, пока не моргаешь: каждое моргание стирает его часть.'),
          item('Жизнь', 'Янтарные точки — неописанные виды. Подойди и возьми образец.'),
          item('Экспедиция', 'Прошлая группа стоит в лесу, лицом к маяку, у каждого — журнал. Один из них не стоит.'),
          item('Угроза', 'Он двигается, только когда на него не смотрят: глаза закрыты, ты отвернулся, он за стволом. Посмотри в упор — замрёт. Ненадолго. Импульсы и бег он слышит.'),
        ),
        h('div.keys', ...keys),
      ),
      h('div.go', h('i.pulse-dot'), h('span', o.camera ? 'Закрой и открой глаза — или кликни, чтобы начать' : 'Кликни или нажми Enter, чтобы начать')),
    );
  }

  end(o: EndOpts): void {
    const stat = (k: string, v: string) => h('div.stat', h('div.kicker', k), h('div.v', v));
    this.show(
      'end',
      h(o.dead ? 'div.kicker.danger' : 'div.kicker.accent', o.dead ? 'Контакт потерян' : 'Экспедиция завершена'),
      h('div.h2', o.dead ? 'Он был ближе, чем казалось.' : 'Эвакуация.'),
      h('div.stats', stat('Время', o.time), stat('Описано', `${o.documented.length} / ${o.total}`), stat('Импульсов', String(o.pulses)), stat('Мир', String(o.seed))),
      h('hr.rule'),
      o.documented.length
        ? h('div.species-list', ...o.documented.map((s) => h('div.sp', latin(s.name), h('span.muted.small', s.ru))))
        : h('div.muted', 'Ни один вид не описан.'),
      h('div.row.actions', btn('Новый мир', o.onNew, 'primary'), btn('Этот же мир', o.onSame)),
      h('div.small.muted.hint', o.camera ? 'Enter — новый мир · R — этот же · или закрой и открой глаза' : 'Enter — новый мир · R — этот же'),
    );
  }

  /** Пауза при потере сигнала (TECH → Потеря сигнала). */
  paused(on: boolean): void {
    this.lostEl.classList.toggle('on', on);
  }
}

// Полевой журнал и панель детального скана (GDD → Наука).
import { cladogram, currentPass, leaves, measurements, PASS_RU, PASSES, type CladeNode, type Research, type Study } from '../game/research';
import { CLADE_RU, type Species } from '../world/species';
import { h, latin } from './dom';
import { INK, SERIF } from './theme';

/** Панель детального скана. DOM строится один раз на образец, дальше обновляются классы и ширины. */
export class StudyPanel {
  private root = h('div.study.panel.ui');
  private key = '';
  private passEls: HTMLElement[] = [];
  private barEls: HTMLElement[] = [];
  private meas = h('div.meas');
  private shownMeas = -1;
  private nameBox = h('div');
  private foot = h('div.foot');

  constructor() {
    document.body.append(this.root);
  }

  hide(): void {
    this.root.classList.remove('on');
    this.key = '';
  }

  show(s: Study, sp: Species, done: boolean): void {
    const key = `${sp.id}:${done}`;
    if (key !== this.key) this.build(sp, done, key);
    this.root.classList.add('on');
    const idx = done ? 3 : PASSES.indexOf(currentPass(s));
    this.passEls.forEach((el, i) => {
      el.classList.toggle('done', i < idx);
      el.classList.toggle('active', i === idx);
      this.barEls[i].style.width = `${i < idx ? 100 : i === idx ? Math.round(((s.progress * 3) % 1) * 100) : 0}%`;
    });
    if (idx !== this.shownMeas) {
      this.shownMeas = idx;
      this.meas.replaceChildren(...measurements(sp, idx).map((m) => h('div.m', h('span', m.label), h('span', m.value))));
    }
  }

  private build(sp: Species, done: boolean, key: string): void {
    this.key = key;
    this.shownMeas = -1;
    this.passEls = [];
    this.barEls = [];
    const passes = PASSES.map((p) => {
      const bar = h('b');
      this.barEls.push(bar);
      const el = h('div.pass', h('i'), h('span', PASS_RU[p]), h('div.bar', bar));
      this.passEls.push(el);
      return el;
    });
    this.nameBox.replaceChildren(
      done ? h('div.name', latin(sp.name)) : h('div.name', 'Неизвестный вид'),
      h('div.sub', done ? `${sp.ru} · ${CLADE_RU[sp.clade]}` : CLADE_RU[sp.clade]),
    );
    this.foot.textContent = done ? 'Запись добавлена в журнал' : 'E — прервать · мир вокруг не ждёт';
    this.root.replaceChildren(h(done ? 'div.kicker.accent' : 'div.kicker', done ? 'Вид описан' : 'Детальный скан'), this.nameBox, h('div.passes', ...passes), this.meas, this.foot);
  }
}

export class Journal {
  private root = h('div.journal.panel.ui');
  private canvas = h('canvas');
  open = false;

  constructor() {
    document.body.append(this.root);
  }

  toggle(r: Research, species: Species[], seed: number): void {
    this.open = !this.open;
    this.root.classList.toggle('on', this.open);
    if (this.open) this.render(r, species, seed);
  }

  close(): void {
    this.open = false;
    this.root.classList.remove('on');
  }

  private render(r: Research, species: Species[], seed: number): void {
    const docs = species.filter((s) => r.documented.has(s.id));
    const cards = h('div.cards');
    for (const s of species) {
      if (!r.documented.has(s.id)) {
        cards.append(h('div.card.unknown', h('div.kicker', 'Не описан'), h('div.sub', CLADE_RU[s.clade])));
        continue;
      }
      const card = h('div.card', latin(s.name), h('div.sub', `${s.ru} · ${CLADE_RU[s.clade]}`));
      for (const m of measurements(s, 3)) card.append(h('div.m', h('span', m.label), h('span', m.value)));
      for (const o of r.observations.get(s.id) ?? []) card.append(h('div.obs', o));
      cards.append(card);
    }
    this.root.replaceChildren(
      h(
        'div.head',
        h('div', h('div.kicker', `Полевой журнал · мир № ${seed}`), h('div.h2', `Описано ${docs.length} из ${species.length}`)),
        h('div.small.muted', 'Tab — закрыть'),
      ),
      h('hr.rule'),
      docs.length >= 2 ? h('div.kicker', 'Кладограмма · UPGMA по геному') : h('div.small.muted', 'Кладограмма появится со вторым описанным видом.'),
      ...(docs.length >= 2 ? [this.canvas] : []),
      cards,
    );
    if (docs.length >= 2) requestAnimationFrame(() => this.drawTree(cladogram(docs)!, species));
  }

  private drawTree(root: CladeNode, species: Species[]): void {
    const c = this.canvas;
    const dpr = devicePixelRatio;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const W = c.clientWidth;
    const H = c.clientHeight;
    const order = leaves(root);
    const labelW = Math.min(320, W * 0.42);
    const maxH = root.height || 1;
    const yOf = new Map<number, number>();
    order.forEach((id, i) => yOf.set(id, 14 + (i * (H - 28)) / Math.max(1, order.length - 1)));
    const x = (hh: number) => 10 + (1 - hh / maxH) * (W - labelW - 30);
    g.strokeStyle = INK(0.55);
    g.lineWidth = 1;
    const draw = (n: CladeNode): number => {
      if (n.species !== null) {
        const y = yOf.get(n.species)!;
        const s = species[n.species];
        g.fillStyle = INK(0.95);
        g.font = `italic 15px ${SERIF}`;
        g.fillText(s.name, x(0) + 12, y + 5);
        const w = g.measureText(s.name).width;
        g.fillStyle = INK(0.4);
        g.font = `12px ${getComputedStyle(document.documentElement).getPropertyValue('--sans')}`;
        g.fillText(`  ${CLADE_RU[s.clade]}`, x(0) + 12 + w, y + 5);
        g.fillStyle = INK(0.9);
        g.beginPath();
        g.arc(x(0), y, 2.2, 0, Math.PI * 2);
        g.fill();
        return y;
      }
      const ys = n.children.map(draw);
      const xn = x(n.height);
      n.children.forEach((ch, i) => {
        g.beginPath();
        g.moveTo(xn, ys[i]);
        g.lineTo(x(ch.height), ys[i]);
        g.stroke();
      });
      g.beginPath();
      g.moveTo(xn, Math.min(...ys));
      g.lineTo(xn, Math.max(...ys));
      g.stroke();
      return (Math.min(...ys) + Math.max(...ys)) / 2;
    };
    draw(root);
  }
}

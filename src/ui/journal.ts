// Полевой журнал и панель детального скана (GDD → Наука).
import { el } from '../debug/ui';
import { cladogram, currentPass, leaves, measurements, PASS_RU, PASSES, type CladeNode, type Research, type Study } from '../game/research';
import { CLADE_RU, type Species } from '../world/species';

const PANEL = 'position:fixed;z-index:6;background:rgba(2,10,14,.82);border:1px solid rgba(120,200,230,.25);color:#bfe3ee;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:14px 16px;box-sizing:border-box';

export class StudyPanel {
  private root = el('div', `${PANEL};right:24px;top:50%;transform:translateY(-50%);width:340px;display:none`);

  constructor() {
    document.body.append(this.root);
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  show(s: Study, sp: Species, done: boolean): void {
    this.root.style.display = 'block';
    const pass = currentPass(s);
    const passIdx = PASSES.indexOf(pass);
    const shown = done ? 3 : passIdx;
    const bar = el('div', 'height:4px;background:rgba(120,200,230,.2);margin:8px 0 12px');
    bar.append(el('div', `height:100%;width:${Math.round(s.progress * 100)}%;background:#8fe6ff`));
    const title = done
      ? el('div', '', el('div', 'font-size:16px;color:#ffe2a8;font-style:italic', sp.name), el('div', 'color:#9cc', sp.ru))
      : el('div', 'color:#9cc', `неизвестный вид · ${CLADE_RU[sp.clade]}`);
    const list = el('div', 'margin-top:10px');
    for (const m of measurements(sp, shown)) {
      list.append(el('div', 'display:flex;justify-content:space-between;gap:12px', el('span', 'color:#7aa', m.label), el('span', '', m.value)));
    }
    this.root.replaceChildren(
      el('div', 'letter-spacing:.12em;color:#8fe6ff', done ? 'ВИД ОПИСАН' : `ДЕТАЛЬНЫЙ СКАН · ${passIdx + 1}/3 · ${PASS_RU[pass]}`),
      bar,
      title,
      list,
      el('div', 'margin-top:14px;color:#577', done ? '' : 'E — прервать · мир вокруг не ждёт'),
    );
  }
}

export class Journal {
  private root = el('div', `${PANEL};inset:5% 6%;display:none;overflow:auto;background:rgba(2,8,11,.96)`);
  private canvas = el('canvas', 'width:100%;height:320px;display:block;margin-top:10px');
  open = false;

  constructor() {
    document.body.append(this.root);
  }

  toggle(r: Research, species: Species[], seed: number): void {
    this.open = !this.open;
    this.root.style.display = this.open ? 'block' : 'none';
    if (this.open) this.render(r, species, seed);
  }

  close(): void {
    this.open = false;
    this.root.style.display = 'none';
  }

  private render(r: Research, species: Species[], seed: number): void {
    const docs = species.filter((s) => r.documented.has(s.id));
    const cards = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:12px');
    for (const s of docs) {
      const obs = [...(r.observations.get(s.id) ?? [])];
      if (s.genome.hostPlant !== null) obs.push(`кормится на ${species[s.genome.hostPlant].name}`);
      const card = el(
        'div',
        'border:1px solid rgba(120,200,230,.2);padding:10px 12px',
        el('div', 'font-style:italic;color:#ffe2a8;font-size:15px', s.name),
        el('div', 'color:#9cc', `${s.ru} · ${CLADE_RU[s.clade]}`),
      );
      for (const m of measurements(s, 3)) {
        card.append(el('div', 'display:flex;justify-content:space-between', el('span', 'color:#7aa', m.label), el('span', '', m.value)));
      }
      for (const o of obs) card.append(el('div', 'color:#c9a;margin-top:4px', `· ${o}`));
      cards.append(card);
    }
    const unknown = species.length - docs.length;
    this.root.replaceChildren(
      el('div', 'letter-spacing:.15em;color:#8fe6ff', `ПОЛЕВОЙ ЖУРНАЛ · мир ${seed}`),
      el('div', 'color:#7aa', `описано ${docs.length} из ${species.length} · не описано ${unknown} · Tab — закрыть`),
      docs.length >= 2 ? el('div', 'margin-top:14px;color:#8fe6ff', 'КЛАДОГРАММА (UPGMA по геному)') : el('div', 'margin-top:14px;color:#577', 'Кладограмма появится со вторым описанным видом.'),
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
    const labelW = Math.min(300, W * 0.4);
    const maxH = root.height || 1;
    const yOf = new Map<number, number>();
    order.forEach((id, i) => yOf.set(id, 16 + (i * (H - 32)) / Math.max(1, order.length - 1)));
    const x = (h: number) => 20 + (1 - h / maxH) * (W - labelW - 40);
    g.strokeStyle = 'rgba(143,230,255,.7)';
    g.fillStyle = '#bfe3ee';
    g.lineWidth = 1.2;
    g.font = '12px ui-monospace, Menlo, Consolas, monospace';
    const draw = (n: CladeNode): number => {
      if (n.species !== null) {
        const y = yOf.get(n.species)!;
        const s = species[n.species];
        g.fillText(`${s.name} · ${CLADE_RU[s.clade]}`, x(0) + 8, y + 4);
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

// Исследование (GDD → Наука): образцы, детальный скан в три прохода, журнал, кладограмма.
import { config as defaultConfig, type Config } from '../config';
import { genomeVector, type Species } from '../world/species';

export type StudyPass = 'geometry' | 'reflectance' | 'luminescence';
export const PASSES: StudyPass[] = ['geometry', 'reflectance', 'luminescence'];
export const PASS_RU: Record<StudyPass, string> = {
  geometry: 'геометрия',
  reflectance: 'отражение 905 нм',
  luminescence: 'биолюминесценция',
};

export interface Study {
  species: number;
  source: { kind: 'plant' | 'animal'; id: number };
  progress: number; // 0..1
}

export interface Research {
  documented: Set<number>;
  firstSeenAt: Map<number, number>; // вид → игровое время документирования
  study: Study | null;
  observations: Map<number, Set<string>>; // вид → наблюдения (поведение в поле)
  notesRead: Set<number>; // статуи, чьи записи прочитаны
}

export const createResearch = (): Research => ({
  documented: new Set(),
  firstSeenAt: new Map(),
  study: null,
  observations: new Map(),
  notesRead: new Set(),
});

export function startStudy(r: Research, species: number, source: Study['source']): void {
  r.study = { species, source, progress: 0 };
}

export const currentPass = (s: Study): StudyPass => PASSES[Math.min(2, Math.floor(s.progress * 3))];

/** Продвинуть детальный скан. Возвращает id вида, если он только что задокументирован. */
export function advanceStudy(r: Research, dtMs: number, time: number, cfg: Config = defaultConfig): number | null {
  const s = r.study;
  if (!s) return null;
  s.progress = Math.min(1, s.progress + dtMs / cfg.research.studyMs);
  if (s.progress < 1) return null;
  r.study = null;
  if (r.documented.has(s.species)) return null;
  r.documented.add(s.species);
  r.firstSeenAt.set(s.species, time);
  return s.species;
}

export function observe(r: Research, species: number, note: string): boolean {
  let set = r.observations.get(species);
  if (!set) r.observations.set(species, (set = new Set()));
  if (set.has(note)) return false;
  set.add(note);
  return true;
}

// ─── Кладограмма: UPGMA по векторам генома ───────────────────────────────────

export interface CladeNode {
  species: number | null; // лист — вид, внутренний узел — null
  height: number; // половина расстояния слияния
  children: CladeNode[];
}

const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));

export function cladogram(species: Species[]): CladeNode | null {
  if (species.length === 0) return null;
  let clusters: { node: CladeNode; members: number[][] }[] = species.map((s) => ({
    node: { species: s.id, height: 0, children: [] },
    members: [genomeVector(s)],
  }));
  const avg = (a: number[][], b: number[][]) => {
    let s = 0;
    for (const x of a) for (const y of b) s += dist(x, y);
    return s / (a.length * b.length);
  };
  while (clusters.length > 1) {
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = avg(clusters[i].members, clusters[j].members);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    const a = clusters[bi];
    const b = clusters[bj];
    const merged = { node: { species: null, height: best / 2, children: [a.node, b.node] }, members: [...a.members, ...b.members] };
    clusters = clusters.filter((_, k) => k !== bi && k !== bj);
    clusters.push(merged);
  }
  return clusters[0].node;
}

/** Порядок листьев слева направо (для отрисовки). */
export function leaves(n: CladeNode): number[] {
  return n.species !== null ? [n.species] : n.children.flatMap(leaves);
}

/** Измерения для карточки вида — только то, что открыл соответствующий проход. */
export function measurements(s: Species, passes: number): { label: string; value: string }[] {
  const g = s.genome;
  const out: { label: string; value: string }[] = [];
  const cm = (m: number) => (m < 1 ? `${Math.round(m * 100)} см` : `${m.toFixed(1)} м`);
  if (passes >= 1) {
    if (s.kingdom === 'plant') out.push({ label: 'высота', value: cm(g.size) });
    else out.push({ label: s.clade === 'coleoptera' ? 'длина' : 'размах', value: cm(g.size) });
    if (s.clade === 'flos') out.push({ label: 'симметрия', value: `${g.symmetry}-лучевая` });
    if (s.clade === 'filix') out.push({ label: 'вай', value: `${g.symmetry + 3}` });
    if (s.clade === 'arbor') out.push({ label: 'порядков ветвления', value: `${Math.min(3, g.segments)}` });
    if (s.clade === 'odonata') out.push({ label: 'сегментов брюшка', value: `${Math.max(6, g.segments)}` });
    if (s.clade === 'lepidoptera' || s.clade === 'coleoptera') out.push({ label: 'рисунок', value: g.pattern > 0.66 ? 'выраженный' : g.pattern > 0.33 ? 'слабый' : 'однотонный' });
  }
  if (passes >= 2) out.push({ label: 'отражение 905 нм', value: g.reflect905.toFixed(2) });
  if (passes >= 3) out.push({ label: 'свечение', value: g.lumPeak ? `пик ${g.lumPeak} нм` : 'нет' });
  return out;
}

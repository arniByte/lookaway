// Виды мира из «генома» (GDD → Наука). Детерминированы от seed. Без three.js: только данные.
import { chance, fork, pick, range, type Rng } from './random';

export type Clade = 'arbor' | 'filix' | 'flos' | 'fungus' | 'lepidoptera' | 'coleoptera' | 'odonata';
export type Kingdom = 'plant' | 'animal';
export type Habitat = 'forest' | 'clearing' | 'rocks';

export const KINGDOM: Record<Clade, Kingdom> = {
  arbor: 'plant',
  filix: 'plant',
  flos: 'plant',
  fungus: 'plant',
  lepidoptera: 'animal',
  coleoptera: 'animal',
  odonata: 'animal',
};

/** Русские названия клад для журнала. */
export const CLADE_RU: Record<Clade, string> = {
  arbor: 'древовидные',
  filix: 'папоротниковидные',
  flos: 'цветковые',
  fungus: 'грибы',
  lepidoptera: 'чешуекрылые',
  coleoptera: 'жесткокрылые',
  odonata: 'стрекозовидные',
};

export interface Genome {
  size: number; // м: высота растения / размах крыла или длина животного
  symmetry: number; // порядок симметрии (лепестки, лучи) 3..8
  segments: number; // сегменты тела / глубина ветвления
  branchAngle: number; // рад
  phyllo: number; // угол расхождения, рад (около золотого)
  leafShape: number; // 0 — округлый, 1 — ланцетный
  curl: number; // изгиб вайи / крыла 0..1
  aspect: number; // удлинённость крыла / плоскость шляпки 0..1
  pattern: number; // частота узора (полосы, пятна) 0..1
  reflect905: number; // отражение лидара 0..1
  lumPeak: number; // пик биолюминесценции, нм (0 — не светится)
  speed: number; // м/с (животные)
  flees: boolean; // пугается импульсов
  hostPlant: number | null; // id кормового растения (чешуекрылые)
  density: number; // относительная плотность
  habitat: Habitat;
}

export interface Species {
  id: number;
  clade: Clade;
  kingdom: Kingdom;
  genus: string;
  epithet: string;
  name: string; // биномиальное
  ru: string; // описательное русское
  genome: Genome;
}

/** Состав мира: сколько видов какой клады. */
export const WORLD_PLAN: readonly Clade[] = [
  'arbor', 'arbor', 'filix', 'flos', 'flos', 'fungus',
  'lepidoptera', 'lepidoptera', 'coleoptera', 'odonata',
];

const GENUS_ROOTS = ['ael', 'bor', 'cal', 'dry', 'eur', 'gal', 'hel', 'lum', 'mel', 'myr', 'nyx', 'orth', 'pha', 'phy', 'rhod', 'scia', 'sel', 'tel', 'thal', 'umbr', 'vel', 'xan', 'zel', 'cryph', 'noct'];
const GENUS_MID = ['a', 'i', 'o', 'e', 'y', 'ae', 'io'];
/** Суффикс рода и его род (для согласования эпитета). */
const GENUS_SUFFIX: Record<Clade, [string, 'm' | 'f' | 'n'][]> = {
  arbor: [['dendron', 'n'], ['xylon', 'n'], ['phyllum', 'n']],
  filix: [['pteris', 'f'], ['blechna', 'f'], ['filix', 'f']],
  flos: [['anthus', 'm'], ['flora', 'f'], ['petalum', 'n']],
  fungus: [['myces', 'm'], ['porus', 'm'], ['stroma', 'n']],
  lepidoptera: [['ptera', 'f'], ['idia', 'f'], ['lepis', 'f']],
  coleoptera: [['carabus', 'm'], ['cera', 'f'], ['scarabus', 'm']],
  odonata: [['neura', 'f'], ['aeschna', 'f'], ['stylus', 'm']],
};
const LATIN_END = { m: 'us', f: 'a', n: 'um' } as const;

/** Прилагательные 1–2 склонения по чертам генома: основа + окончание рода. */
function epithetStem(g: Genome, clade: Clade, r: Rng): string {
  const opts: string[] = [];
  if (g.lumPeak > 0) opts.push('lucid', 'fulgid', 'noctiluc');
  if (g.reflect905 < 0.35) opts.push('obscur', 'umbros', 'fusc');
  if (g.reflect905 > 0.7) opts.push('pallid', 'argentat', 'candid');
  if (g.pattern > 0.66) opts.push('maculat', 'striat', 'variegat');
  if (g.flees) opts.push('timid', 'fugac');
  if (g.size > 1.3 * sizeBase(clade)) opts.push('magn', 'maxim');
  if (g.size < 0.75 * sizeBase(clade)) opts.push('parv', 'minut');
  if (g.curl > 0.6) opts.push('crisp', 'tort');
  if (g.aspect > 0.7) opts.push('elongat', 'angustat');
  if (opts.length === 0) opts.push('vulgar', 'comm', 'silvatic');
  return pick(r, opts);
}

function epithetWord(stem: string, gender: 'm' | 'f' | 'n'): string {
  // vulgar-is — 3-е склонение: vulgaris/vulgaris/vulgare; comm → communis/communis/commune
  if (stem === 'vulgar') return gender === 'n' ? 'vulgare' : 'vulgaris';
  if (stem === 'comm') return gender === 'n' ? 'commune' : 'communis';
  if (stem === 'silvatic') return 'silvatic' + LATIN_END[gender];
  if (stem === 'fugac') return 'fugax';
  if (stem === 'noctiluc') return gender === 'n' ? 'noctilucum' : gender === 'f' ? 'noctiluca' : 'noctilucus';
  return stem + LATIN_END[gender];
}

// Русские описательные названия: прилагательное + существительное с родом.
const RU_NOUNS: Record<Clade, [string, 'm' | 'f' | 'n'][]> = {
  arbor: [['древо', 'n'], ['стволовик', 'm'], ['шпилевик', 'm'], ['кронница', 'f']],
  filix: [['перистолист', 'm'], ['вайя', 'f'], ['спиралевик', 'm']],
  flos: [['звездоцвет', 'm'], ['венчик', 'm'], ['чашечница', 'f'], ['лучецвет', 'm']],
  fungus: [['трубочник', 'm'], ['шляпник', 'm'], ['плёнчатка', 'f']],
  lepidoptera: [['крылатка', 'f'], ['пыльник', 'm'], ['мотылица', 'f']],
  coleoptera: [['панцирник', 'm'], ['щитоносец', 'm'], ['жужелица', 'f']],
  odonata: [['иглокрыл', 'm'], ['лётка', 'f'], ['стекловик', 'm']],
};
/** [основа, тип]: 'y' — ый/ая/ое, 'i' — ий/ая/ее (после шипящих). */
function ruAdjective(g: Genome, r: Rng): [string, 'y' | 'i'] {
  const opts: [string, 'y' | 'i'][] = [];
  if (g.lumPeak > 0) opts.push(['сияющ', 'i'], ['мерцающ', 'i']);
  if (g.reflect905 < 0.35) opts.push(['тёмн', 'y'], ['дымчат', 'y']);
  if (g.reflect905 > 0.7) opts.push(['бледн', 'y'], ['стеклянн', 'y']);
  if (g.pattern > 0.66) opts.push(['пятнист', 'y'], ['полосат', 'y']);
  if (g.flees) opts.push(['пуглив', 'y']);
  if (g.curl > 0.6) opts.push(['кручён', 'y']);
  if (g.aspect > 0.7) opts.push(['длинн', 'y']);
  if (opts.length === 0) opts.push(['обыкновенн', 'y'], ['тих', 'i']);
  return pick(r, opts);
}
const RU_END = { y: { m: 'ый', f: 'ая', n: 'ое' }, i: { m: 'ий', f: 'ая', n: 'ее' } } as const;

const sizeBase = (c: Clade): number =>
  // Насекомые крупнее земных: чужой мир, и в облаке точек их должно быть видно с нескольких метров.
  ({ arbor: 9, filix: 1.1, flos: 0.45, fungus: 0.18, lepidoptera: 0.18, coleoptera: 0.08, odonata: 0.2 })[c];

function makeGenome(clade: Clade, r: Rng): Genome {
  const base = sizeBase(clade);
  const animal = KINGDOM[clade] === 'animal';
  return {
    size: base * range(r, 0.65, 1.45),
    symmetry: Math.floor(range(r, 3, 8.99)),
    segments: Math.floor(range(r, clade === 'arbor' ? 2 : 3, clade === 'arbor' ? 4.99 : 9.99)),
    branchAngle: range(r, 0.35, 0.95),
    phyllo: 2.39996 + range(r, -0.25, 0.25),
    leafShape: r(),
    curl: r(),
    aspect: r(),
    pattern: r(),
    reflect905: range(r, 0.2, 0.9),
    lumPeak: chance(r, clade === 'fungus' || clade === 'lepidoptera' ? 0.55 : 0.2) ? Math.round(range(r, 440, 610)) : 0,
    speed: animal ? (clade === 'coleoptera' ? range(r, 0.08, 0.25) : range(r, 0.8, 2.4)) : 0,
    flees: animal && chance(r, 0.5),
    hostPlant: null,
    density: range(r, 0.6, 1.4),
    habitat: clade === 'fungus' ? 'rocks' : clade === 'flos' ? 'clearing' : clade === 'arbor' || clade === 'filix' ? 'forest' : pick(r, ['forest', 'clearing'] as const),
  };
}

export function generateSpecies(seed: number, plan: readonly Clade[] = WORLD_PLAN): Species[] {
  const r = fork(seed, 'species');
  const usedGenus = new Set<string>();
  const list: Species[] = plan.map((clade, id) => {
    const genome = makeGenome(clade, r);
    let genus = '';
    let gender: 'm' | 'f' | 'n' = 'm';
    for (let tries = 0; tries < 20 && (!genus || usedGenus.has(genus)); tries++) {
      const [suffix, gd] = pick(r, GENUS_SUFFIX[clade]);
      const root = pick(r, GENUS_ROOTS);
      const mid = /[aeiouy]$/.test(root) || /^[aeiouy]/.test(suffix) ? '' : pick(r, GENUS_MID);
      genus = (root + mid + suffix).replace(/([aeiouy])\1+/g, '$1');
      genus = genus[0].toUpperCase() + genus.slice(1);
      gender = gd;
    }
    usedGenus.add(genus);
    const epithet = epithetWord(epithetStem(genome, clade, r), gender);
    const [noun, ng] = pick(r, RU_NOUNS[clade]);
    const [adj, at] = ruAdjective(genome, r);
    return {
      id,
      clade,
      kingdom: KINGDOM[clade],
      genus,
      epithet,
      name: `${genus} ${epithet}`,
      ru: `${adj}${RU_END[at][ng]} ${noun}`,
      genome,
    };
  });
  // Экология: у чешуекрылых — кормовое растение среди цветковых.
  const flowers = list.filter((s) => s.clade === 'flos');
  for (const s of list) {
    if (s.clade === 'lepidoptera' && flowers.length) s.genome.hostPlant = pick(r, flowers).id;
  }
  return list;
}

/** Вектор генома для кладограммы: клада весит больше любых черт (разные клады всегда дальше). */
export function genomeVector(s: Species): number[] {
  const g = s.genome;
  const clades: Clade[] = ['arbor', 'filix', 'flos', 'fungus', 'lepidoptera', 'coleoptera', 'odonata'];
  const kingdom = s.kingdom === 'plant' ? 0 : 1;
  const oneHot = clades.map((c) => (c === s.clade ? 1.5 : 0));
  return [
    kingdom * 3,
    ...oneHot,
    Math.log(g.size / sizeBase(s.clade)),
    (g.symmetry - 3) / 5,
    g.segments / 10,
    g.leafShape,
    g.curl,
    g.aspect,
    g.pattern,
    g.reflect905,
    g.lumPeak ? 1 : 0,
  ];
}

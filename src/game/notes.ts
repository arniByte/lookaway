// Записи пропавшей экспедиции (GDD → Угроза): у каждой застывшей фигуры — полевой журнал.
// Лор и подсказки (где искать вид). Детерминированы от seed мира. Чистая логика.
import { fork } from '../world/random';
import type { World } from '../world/worldgen';

export interface Note {
  statue: number;
  text: string;
  hint: number | null; // id вида: метка на компасе
}

export function expeditionNotes(world: World): Note[] {
  const r = fork(world.seed, 'notes');
  const n = world.statues.length;
  const sp = world.species;
  const find = (clade: string) => sp.filter((s) => s.clade === clade);
  const butterfly = find('lepidoptera')[0];
  const host = butterfly?.genome.hostPlant != null ? sp[butterfly.genome.hostPlant] : null;
  const fungus = find('fungus')[0];
  const shy = sp.find((s) => s.kingdom === 'animal' && s.genome.flees);

  const pool: Omit<Note, 'statue'>[] = [
    { text: 'Он не двигается, пока на него смотришь. Я перестал моргать. Глаза горят.', hint: null },
    { text: 'Если долго держать глаза закрытыми, сканер бьёт дальше. Он тоже это знает.', hint: null },
    { text: 'Он выше нас. И руки у него длиннее. Считай пальцы.', hint: null },
    { text: 'Маяк ещё работает. Иди на него и не оглядывайся. Нет. Оглядывайся.', hint: null },
    { text: 'Все мы смотрим на маяк. Все, кроме одного.', hint: null },
  ];
  if (butterfly && host) pool.push({ text: `${butterfly.name} садится только на ${host.name}. Ищи на полянах.`, hint: butterfly.id });
  if (fungus) pool.push({ text: `${fungus.name} растёт у камней и стволов. ${fungus.genome.lumPeak ? `Светится на ${fungus.genome.lumPeak} нм.` : 'Не светится, но хорошо отражает.'} Я засмотрелся.`, hint: fungus.id });
  if (shy) pool.push({ text: `${shy.name} пугается импульсов. Подходи молча, сканируй потом.`, hint: shy.id });

  // Первая — всегда про счёт; подсказки — вперёд, чтобы хотя бы две попали в мир.
  const hints = pool.filter((p) => p.hint !== null);
  const lore = pool.filter((p) => p.hint === null);
  for (const list of [hints, lore]) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  const ordered = [{ text: `Нас было ${n}. На последнем скане я насчитал ${n + 1}.`, hint: null }, ...hints.slice(0, 2), ...lore, ...hints.slice(2)];
  return world.statues.map((st, i) => ({ statue: st.id, ...ordered[i % ordered.length] }));
}

import { RAW_KEYS, type Fixture, type FixtureMeta, type RawFrame } from './types';

/** На диске кадры лежат колонками с округлением: ~в 3 раза компактнее объектов. */
export interface FixtureFile {
  version: 1;
  meta: FixtureMeta;
  columns: string[];
  rows: number[][];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function encodeFixture(fx: Fixture): FixtureFile {
  return {
    version: 1,
    meta: fx.meta,
    columns: [...RAW_KEYS],
    rows: fx.frames.map((f) => RAW_KEYS.map((k) => (k === 't' ? Math.round(f.t) : round3(f[k])))),
  };
}

export function decodeFixture(file: FixtureFile): Fixture {
  if (file.version !== 1) throw new Error(`fixture version ${String(file.version)} не поддерживается`);
  const idx = RAW_KEYS.map((k) => file.columns.indexOf(k));
  const missing = RAW_KEYS.filter((_, i) => idx[i] < 0);
  if (missing.length) throw new Error(`в фикстуре нет колонок: ${missing.join(', ')}`);
  const frames = file.rows.map((row) => {
    const f = {} as RawFrame;
    RAW_KEYS.forEach((k, i) => {
      f[k] = row[idx[i]];
    });
    return f;
  });
  return { version: 1, meta: file.meta, frames };
}

export const fixtureToJson = (fx: Fixture): string => JSON.stringify(encodeFixture(fx));
export const fixtureFromJson = (json: string): Fixture => decodeFixture(JSON.parse(json) as FixtureFile);

// Живые фикстуры, записанные с камеры по протоколам (оверлей → Record). Без них тест пропускается.
import { describe, expect, it } from 'vitest';
import { evaluate, formatReport } from '../src/input/evaluate';
import { fixtureFromJson } from '../src/input/fixture';

const files = import.meta.glob<string>('./fixtures/*.json', { query: '?raw', import: 'default', eager: true });
const names = Object.keys(files);

describe.skipIf(names.length === 0)('живые фикстуры', () => {
  it.each(names)('%s', (name) => {
    const r = evaluate(fixtureFromJson(files[name]));
    expect(r.ok, formatReport(r)).toBe(true);
  });
});

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** CJK ideographs, CJK punctuation and full-width forms. */
const CJK = /[　-〿一-鿿＀-￯]/;
const ROOT = join(import.meta.dirname, '..', '..');

describe('backend text', () => {
  it('is English: no CJK in the non-test sources of src/ and scripts/', async () => {
    // The web UI translates its own strings (web/src/i18n); everything the server, the
    // adapters or the scripts show or send is English.
    const sources: string[] = [];
    for (const dir of ['src', 'scripts'])
      for (const f of await readdir(join(ROOT, dir), { recursive: true }))
        if (/\.(ts|mts|mjs)$/.test(f) && !/\.test\.ts$|__tests__|__fixtures__/.test(f))
          sources.push(join(dir, f));
    const offenders: string[] = [];
    for (const f of sources) if (CJK.test(await readFile(join(ROOT, f), 'utf8'))) offenders.push(f);
    expect(sources.length).toBeGreaterThan(40);
    expect(offenders).toEqual([]);
  });
});

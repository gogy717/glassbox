import { describe, expect, it } from 'vitest';
import { isSqliteWarning, withoutSqliteWarning } from './sqlite.js';

// The policy itself (journalProblem, openReadOnly) is tested where real databases are at hand,
// against both owners' files: opencode/db.test.ts and omp/usage-cache.test.ts.

describe('loading node:sqlite', () => {
  it('drops only the experimental-SQLite warning, and restores emitWarning after', async () => {
    const original = process.emitWarning;
    const seen: unknown[] = [];
    process.emitWarning = ((w: unknown) => {
      seen.push(w);
    }) as typeof process.emitWarning;
    try {
      const installed = process.emitWarning;
      await withoutSqliteWarning(async () => {
        process.emitWarning(
          'SQLite is an experimental feature and might change at any time',
          'ExperimentalWarning',
        );
        process.emitWarning('Something else', 'DeprecationWarning');
      });
      expect(seen).toEqual(['Something else']);
      expect(process.emitWarning).toBe(installed);
    } finally {
      process.emitWarning = original;
    }
  });

  it('recognises the warning in both of emitWarning’s call shapes', () => {
    const msg = 'SQLite is an experimental feature and might change at any time';
    expect(isSqliteWarning(msg, 'ExperimentalWarning')).toBe(true);
    expect(isSqliteWarning(msg, { type: 'ExperimentalWarning' })).toBe(true);
    expect(isSqliteWarning(msg, 'DeprecationWarning')).toBe(false);
    expect(isSqliteWarning('WASI is an experimental feature', 'ExperimentalWarning')).toBe(false);
  });
});

describe('withoutSqliteWarning (oh-my-pi cache)', () => {
  it('drops only the SQLite experimental warning while loading', async () => {
    const seen: string[] = [];
    const original = process.emitWarning;
    process.emitWarning = ((w: string | Error, type?: unknown) => {
      seen.push(`${type}: ${typeof w === 'string' ? w : w.message}`);
    }) as typeof process.emitWarning;
    try {
      const value = await withoutSqliteWarning(async () => {
        process.emitWarning(
          'SQLite is an experimental feature and might change at any time',
          'ExperimentalWarning',
        );
        process.emitWarning('something else', 'ExperimentalWarning');
        process.emitWarning('SQLite is fine', 'DeprecationWarning');
        return 7;
      });
      expect(value).toBe(7);
      process.emitWarning('SQLite is an experimental feature (after)', 'ExperimentalWarning');
    } finally {
      process.emitWarning = original;
    }
    expect(seen).toEqual([
      'ExperimentalWarning: something else',
      'DeprecationWarning: SQLite is fine',
      'ExperimentalWarning: SQLite is an experimental feature (after)',
    ]);
  });
});

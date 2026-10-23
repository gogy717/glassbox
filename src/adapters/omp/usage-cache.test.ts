import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cacheRow,
  cacheValue,
  copilotReport,
  type LimitSpec,
  limit,
  NOW,
  openaiReport,
  report,
  SECRET_ACCOUNT,
  SECRET_EMAIL,
  SECRET_ORG,
  xaiReport,
} from './__fixtures__/usage-cache.js';
import {
  createOmpUsageCacheSource,
  ompQuotaProvider,
  quotasFromCacheValues,
  withoutSqliteWarning,
} from './usage-cache.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** One report with a single limit, mapped; null when it yields no snapshot. */
function single(spec: LimitSpec) {
  const [q] = quotasFromCacheValues(
    [cacheValue(report('xai-oauth', NOW, [limit('xai-oauth', spec)]))],
    NOW,
  );
  return q?.windows[0] ?? null;
}

const pct = (used: number) => ({ used, limit: 100, unit: 'percent' });

describe('quotasFromCacheValues', () => {
  it('maps a SuperGrok report to an xai snapshot', () => {
    expect(quotasFromCacheValues([cacheValue(xaiReport())], NOW)).toEqual([
      {
        provider: 'xai',
        agent: 'oh-my-pi',
        plan: null,
        fetchedAt: '2026-10-24T01:55:00.000Z',
        stale: false,
        windows: [
          {
            id: 'credits:1w',
            kind: 'weekly',
            label: 'SuperGrok Weekly Credits',
            model: null,
            usedPercent: 25,
            resetsAt: '2026-10-26T02:00:00.000Z',
          },
          {
            id: 'product:grokbuild:1w',
            kind: 'weekly',
            label: 'Grok Build (Weekly)',
            model: null,
            usedPercent: 9,
            resetsAt: '2026-10-26T02:00:00.000Z',
          },
        ],
        extraUsage: null,
        balance: null,
        source: 'oh-my-pi-cache',
      },
    ]);
  });

  it('reads a percent amount without a fraction, a 30-day window and the ChatGPT plan', () => {
    const [q] = quotasFromCacheValues([cacheValue(openaiReport())], NOW);
    expect(q).toMatchObject({
      provider: 'openai',
      plan: 'Free',
      windows: [{ id: 'primary', kind: 'monthly', label: '30 days', usedPercent: 38 }],
    });
  });

  it('skips a limit with no usable number and computes used / limit', () => {
    const [q] = quotasFromCacheValues([cacheValue(copilotReport())], NOW);
    expect(q).toMatchObject({
      provider: 'github-copilot',
      plan: 'Individual',
      windows: [
        {
          id: 'copilot:chat',
          kind: 'monthly',
          label: 'Chat Requests',
          usedPercent: 0.5,
          resetsAt: '2026-11-01T00:00:00.000Z',
        },
        { id: 'copilot:completions', kind: 'monthly', label: 'Completions', usedPercent: 0.75 },
      ],
    });
    expect(q?.windows).toHaveLength(2);
  });

  it("drops oh-my-pi's provider prefix from window ids, as other sources name them", () => {
    const spec = (id: string): LimitSpec => ({ id, label: id, amount: pct(1) });
    const [q] = quotasFromCacheValues(
      [
        cacheValue(
          report('openai-codex', NOW, [
            limit('openai-codex', spec('openai-codex:primary')),
            limit('openai-codex', spec('openai-codex:spark:secondary')),
            limit('openai-codex', spec('primary')),
            limit('openai-codex', spec('openai-codex:')),
            limit('openai-codex', spec('copilot:chat')),
          ]),
        ),
      ],
      NOW,
    );
    expect(q?.windows.map((w) => w.id)).toEqual([
      'primary',
      'spark:secondary',
      'openai-codex:',
      'copilot:chat',
    ]);
  });

  it('keeps one snapshot per provider: the newest report', () => {
    const older = copilotReport(NOW - 40 * 60_000);
    const newer = copilotReport(NOW - 10 * 60_000);
    const out = quotasFromCacheValues([cacheValue(older), cacheValue(newer)], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.fetchedAt).toBe(new Date(NOW - 10 * 60_000).toISOString());
    const reversed = quotasFromCacheValues([cacheValue(newer), cacheValue(older)], NOW);
    expect(reversed).toEqual(out);
  });

  it('returns every provider in the cache', () => {
    const out = quotasFromCacheValues(
      [cacheValue(copilotReport()), cacheValue(xaiReport()), cacheValue(openaiReport())],
      NOW,
    );
    expect(out.map((q) => q.provider).sort()).toEqual(['github-copilot', 'openai', 'xai']);
  });

  it('is stale when fetched more than an hour ago', () => {
    const fresh = quotasFromCacheValues([cacheValue(xaiReport(NOW - 59 * 60_000))], NOW);
    const old = quotasFromCacheValues([cacheValue(xaiReport(NOW - 61 * 60_000))], NOW);
    expect(fresh[0]?.stale).toBe(false);
    expect(old[0]?.stale).toBe(true);
  });

  it('never exposes the account identity a report carries', () => {
    const out = JSON.stringify(
      quotasFromCacheValues(
        [cacheValue(xaiReport()), cacheValue(openaiReport()), cacheValue(copilotReport())],
        NOW,
      ),
    );
    for (const leak of [SECRET_EMAIL, SECRET_ACCOUNT, SECRET_ORG, 'example.invalid', '@']) {
      expect(out).not.toContain(leak);
    }
  });

  it('classifies windows by duration, else by window id', () => {
    const kind = (window: LimitSpec['window']) =>
      single({ id: 'l', label: 'L', window, amount: pct(1) })?.kind;
    expect(kind({ id: 'x', durationMs: 5 * HOUR })).toBe('session');
    expect(kind({ id: 'x', durationMs: HOUR })).toBe('session');
    expect(kind({ id: 'x', durationMs: 7 * DAY })).toBe('weekly');
    expect(kind({ id: 'x', durationMs: 30 * DAY })).toBe('monthly');
    expect(kind({ id: 'x', durationMs: 28 * DAY })).toBe('monthly');
    expect(kind({ id: 'x', durationMs: DAY })).toBe('other');
    expect(kind({ id: '5h' })).toBe('session');
    expect(kind({ id: '7d' })).toBe('weekly');
    expect(kind({ id: '1w' })).toBe('weekly');
    expect(kind({ id: 'monthly' })).toBe('monthly');
    expect(kind({ id: '1mo' })).toBe('monthly');
    expect(kind({ id: '30d' })).toBe('monthly');
    expect(kind({ id: 'primary' })).toBe('other');
    expect(kind(undefined)).toBe('other');
  });

  it('takes the used fraction first, then used / limit, then a percent, then what remains', () => {
    const used = (amount: LimitSpec['amount']) =>
      single({ id: 'l', label: 'L', amount })?.usedPercent ?? null;
    expect(used({ usedFraction: 0.4, used: 1, limit: 2, unit: 'requests' })).toBe(40);
    expect(used({ used: 1, limit: 4, unit: 'requests' })).toBe(25);
    expect(used({ used: 12, unit: 'percent' })).toBe(12);
    expect(used({ remainingFraction: 0.75, unit: 'tokens' })).toBe(25);
    expect(used({ used: 3, limit: 0, unit: 'requests' })).toBeNull();
    expect(used({ used: 3, unit: 'requests' })).toBeNull();
    expect(used({ unit: 'unknown' })).toBeNull();
    // Overage past the plan reads as full, never above 100.
    expect(used({ usedFraction: 1.3, unit: 'requests' })).toBe(100);
    expect(used({ usedFraction: -0.1, unit: 'requests' })).toBe(0);
  });

  it('orders windows by kind and drops a repeated id', () => {
    const spec = (id: string, durationMs: number): LimitSpec => ({
      id,
      label: id,
      window: { id, durationMs },
      amount: pct(1),
    });
    const [q] = quotasFromCacheValues(
      [
        cacheValue(
          report('anthropic', NOW, [
            limit('anthropic', spec('m', 30 * DAY)),
            limit('anthropic', spec('w', 7 * DAY)),
            limit('anthropic', spec('w', 7 * DAY)),
            limit('anthropic', spec('o', DAY)),
            limit('anthropic', spec('s', 5 * HOUR)),
          ]),
        ),
      ],
      NOW,
    );
    expect(q?.windows.map((w) => w.id)).toEqual(['s', 'w', 'm', 'o']);
  });

  it('gives no snapshot for a report without a usable limit', () => {
    const premiumOnly = report('github-copilot', NOW, [
      limit('github-copilot', {
        id: 'copilot:premium',
        label: 'Premium Requests',
        amount: { used: 0, limit: 0, unit: 'requests' },
        status: 'unknown',
      }),
    ]);
    expect(quotasFromCacheValues([cacheValue(premiumOnly)], NOW)).toEqual([]);
  });

  it('prefers the newest report that has windows', () => {
    const empty = report('github-copilot', NOW - 60_000, []);
    const out = quotasFromCacheValues(
      [cacheValue(copilotReport(NOW - 20 * 60_000)), cacheValue(empty)],
      NOW,
    );
    expect(out[0]?.windows).toHaveLength(2);
  });

  it('skips malformed rows and limits without throwing', () => {
    const good = cacheValue(xaiReport());
    const values: unknown[] = [
      'not json',
      '[]',
      'null',
      42,
      null,
      cacheValue(null),
      JSON.stringify({ value: { provider: 'xai-oauth', limits: [] } }),
      JSON.stringify({ value: { provider: 'xai-oauth', fetchedAt: 'yesterday', limits: [] } }),
      JSON.stringify({ value: { fetchedAt: NOW, limits: [] } }),
      JSON.stringify({ value: { provider: 'xai-oauth', fetchedAt: 1e300, limits: [] } }),
      JSON.stringify({ value: { provider: 'xai-oauth', fetchedAt: NOW, limits: 'none' } }),
      JSON.stringify({
        value: {
          provider: 'zai',
          fetchedAt: NOW,
          limits: [null, 7, { id: 'a' }, { label: 'b', amount: pct(1) }, { id: 'c', amount: 3 }],
        },
      }),
      good,
    ];
    expect(quotasFromCacheValues(values, NOW)).toEqual(quotasFromCacheValues([good], NOW));
  });

  it('drops a reset time that is not a time', () => {
    const w = single({
      id: 'l',
      label: 'L',
      window: { id: '1w', resetsAt: 1e300 },
      amount: pct(1),
    });
    expect(w?.resetsAt).toBeNull();
  });
});

describe('ompQuotaProvider', () => {
  it('names the model vendor, not the oh-my-pi provider id', () => {
    expect(ompQuotaProvider('xai-oauth')).toBe('xai');
    expect(ompQuotaProvider('openai-codex')).toBe('openai');
    expect(ompQuotaProvider('github-copilot')).toBe('github-copilot');
    expect(ompQuotaProvider('anthropic')).toBe('anthropic');
    expect(ompQuotaProvider('anthropic-oauth')).toBe('anthropic');
    expect(ompQuotaProvider('kimi-code-oauth')).toBe('kimi-code');
    expect(ompQuotaProvider('zai')).toBe('zai');
  });
});

describe('withoutSqliteWarning', () => {
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

describe('oh-my-pi cache source', () => {
  let dir: string;
  let db: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'glassbox-omp-usage-'));
    await mkdir(join(dir, 'agent'));
    db = join(dir, 'agent', 'agent.db');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** An agent.db with oh-my-pi's `cache` table; WAL mode as oh-my-pi runs it. */
  function writeDb(rows: { key: string; value: string; expires_at: number }[]): void {
    const w = new DatabaseSync(db);
    try {
      w.exec('PRAGMA journal_mode=WAL');
      w.exec(
        'CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)',
      );
      const insert = w.prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)');
      for (const r of rows) insert.run(r.key, r.value, r.expires_at);
    } finally {
      w.close();
    }
  }

  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  it('reads the usage reports in <ompDir>/agent/agent.db and watches it', async () => {
    writeDb([
      cacheRow(xaiReport(now - 60_000)),
      cacheRow(copilotReport(now - 60_000), 'https://api.example.invalid'),
      cacheRow(copilotReport(now - 120_000), 'https://copilot.example.invalid'),
      { key: 'session:sticky', value: cacheValue(xaiReport(now)), expires_at: nowSec + 60 },
      { key: 'usage_cache:failure:report:x', value: cacheValue(null), expires_at: nowSec + 60 },
    ]);
    const source = createOmpUsageCacheSource({ ompDir: dir });
    expect(source.id).toBe('oh-my-pi-cache');
    expect(source.watchFiles?.()).toEqual([db, `${db}-wal`]);
    const out = await source.read();
    expect(out.map((q) => q.provider).sort()).toEqual(['github-copilot', 'xai']);
    expect(out.find((q) => q.provider === 'github-copilot')?.fetchedAt).toBe(
      new Date(now - 60_000).toISOString(),
    );
    expect(JSON.stringify(out)).not.toContain('@');
  });

  it('ignores reports past their retention, as oh-my-pi does', async () => {
    writeDb([
      cacheRow(xaiReport(now - 60_000), 'default', nowSec - 1),
      cacheRow(openaiReport(now - 60_000), 'default', nowSec + 3600),
    ]);
    const out = await createOmpUsageCacheSource({ ompDir: dir }).read();
    expect(out.map((q) => q.provider)).toEqual(['openai']);
  });

  it('is empty when there is no database', async () => {
    expect(await createOmpUsageCacheSource({ ompDir: dir }).read()).toEqual([]);
    expect(await createOmpUsageCacheSource({ ompDir: join(dir, 'missing') }).read()).toEqual([]);
  });

  it('leaves no files behind in the agent dir', async () => {
    writeDb([cacheRow(xaiReport(now - 60_000))]);
    // oh-my-pi is not running: closing it checkpointed the WAL away.
    expect(existsSync(`${db}-wal`)).toBe(false);
    const before = (await readdir(join(dir, 'agent'))).sort();
    expect(await createOmpUsageCacheSource({ ompDir: dir }).read()).toHaveLength(1);
    expect((await readdir(join(dir, 'agent'))).sort()).toEqual(before);
  });

  it('reads rows that are still in the WAL while oh-my-pi has the database open', async () => {
    writeDb([]);
    const writer = new DatabaseSync(db);
    try {
      writer.exec('PRAGMA journal_mode=WAL');
      const r = cacheRow(openaiReport(now - 60_000));
      writer
        .prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)')
        .run(r.key, r.value, r.expires_at);
      expect(existsSync(`${db}-wal`)).toBe(true);
      const out = await createOmpUsageCacheSource({ ompDir: dir }).read();
      expect(out.map((q) => q.provider)).toEqual(['openai']);
    } finally {
      writer.close();
    }
  });

  it('leaves an empty WAL alone: SQLite would give it the database file mode', async () => {
    writeDb([cacheRow(xaiReport(now - 60_000))]);
    const writer = new DatabaseSync(db);
    try {
      writer.exec('PRAGMA journal_mode=WAL');
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      await chmod(db, 0o600);
      await chmod(`${db}-wal`, 0o644);
      expect(statSync(`${db}-wal`).size).toBe(0);
      expect(await createOmpUsageCacheSource({ ompDir: dir }).read()).toHaveLength(1);
      expect(statSync(`${db}-wal`).mode & 0o777).toBe(0o644);
    } finally {
      writer.close();
    }
  });

  it('rejects when the database cannot be read, so the failure is logged', async () => {
    await writeFile(db, 'this is not a database, just text that is long enough to matter');
    await expect(createOmpUsageCacheSource({ ompDir: dir }).read()).rejects.toThrow();
  });

  it('rejects when the cache table is missing', async () => {
    const w = new DatabaseSync(db);
    w.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    w.close();
    await expect(createOmpUsageCacheSource({ ompDir: dir }).read()).rejects.toThrow(/cache/);
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter } from './index.js';
import { quotaFromConfig } from './quota.js';

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const ACCOUNT = 'acct-0000-fixture';
const SECRET_EMAIL = 'someone@example.invalid';

/** A global config as Claude Code writes it, with unrelated account data that must not leak. */
function config(overrides: Record<string, unknown> = {}) {
  return {
    numStartups: 42,
    userID: 'user-secret-id',
    oauthAccount: {
      accountUuid: ACCOUNT,
      emailAddress: SECRET_EMAIL,
      organizationName: 'Secret Org',
    },
    projects: { '/work/secret-project': { allowedTools: [] } },
    cachedUsageUtilization: {
      fetchedAtMs: NOW - 4 * 60_000,
      accountUuid: ACCOUNT,
      utilization: {
        five_hour: { utilization: 10, resets_at: '2026-10-23T05:00:00.000Z' },
        seven_day: { utilization: 20, resets_at: '2026-10-26T00:00:00.000Z' },
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 62,
            resets_at: '2026-10-23T05:37:00.000Z',
            scope: null,
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 38,
            resets_at: '2026-10-26T04:00:00.000Z',
            scope: null,
          },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 51,
            resets_at: '2026-10-26T04:00:00.000Z',
            scope: { model: { id: null, display_name: 'Opus' }, surface: null },
          },
        ],
        spend: {
          used: { amount_minor: 1234, currency: 'AUD', exponent: 2 },
          limit: { amount_minor: 5000, currency: 'AUD', exponent: 2 },
          enabled: true,
        },
        extra_usage: {
          is_enabled: true,
          used_credits: 999,
          monthly_limit: 9999,
          decimal_places: 2,
          currency: 'AUD',
        },
      },
    },
    ...overrides,
  };
}

describe('quotaFromConfig', () => {
  it('maps limits to windows, preferring them over the legacy fields', () => {
    expect(quotaFromConfig(config(), NOW)).toEqual({
      agent: 'claude-code',
      fetchedAt: '2026-10-23T03:56:00.000Z',
      stale: false,
      windows: [
        {
          id: 'five_hour',
          kind: 'session',
          model: null,
          usedPercent: 62,
          resetsAt: '2026-10-23T05:37:00.000Z',
        },
        {
          id: 'seven_day',
          kind: 'weekly',
          model: null,
          usedPercent: 38,
          resetsAt: '2026-10-26T04:00:00.000Z',
        },
        {
          id: 'weekly:Opus',
          kind: 'weekly-model',
          model: 'Opus',
          usedPercent: 51,
          resetsAt: '2026-10-26T04:00:00.000Z',
        },
      ],
      extraUsage: { used: 12.34, limit: 50, currency: 'AUD' },
      source: 'claude-code-cache',
    });
  });

  it('never exposes any other key of the config', () => {
    const out = JSON.stringify(quotaFromConfig(config(), NOW));
    for (const leak of [SECRET_EMAIL, 'Secret Org', 'user-secret-id', 'secret-project', ACCOUNT])
      expect(out).not.toContain(leak);
  });

  it('falls back to the legacy five_hour / seven_day fields and extra_usage', () => {
    const c = config();
    const u = c.cachedUsageUtilization.utilization as Record<string, unknown>;
    delete u.limits;
    delete u.spend;
    expect(quotaFromConfig(c, NOW)).toMatchObject({
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 10, resetsAt: '2026-10-23T05:00:00.000Z' },
        { id: 'seven_day', kind: 'weekly', usedPercent: 20, resetsAt: '2026-10-26T00:00:00.000Z' },
      ],
      extraUsage: { used: 9.99, limit: 99.99, currency: 'AUD' },
    });
  });

  it('is stale when fetched more than an hour ago', () => {
    const c = config();
    c.cachedUsageUtilization.fetchedAtMs = NOW - 61 * 60_000;
    expect(quotaFromConfig(c, NOW)?.stale).toBe(true);
  });

  it('has no extra usage when it is disabled or absent', () => {
    const c = config();
    const u = c.cachedUsageUtilization.utilization as Record<string, unknown>;
    delete u.spend;
    delete u.extra_usage;
    expect(quotaFromConfig(c, NOW)?.extraUsage).toBeNull();
  });

  it('is null for a different account, a missing key or malformed data', () => {
    expect(quotaFromConfig(config({ oauthAccount: { accountUuid: 'other' } }), NOW)).toBeNull();
    expect(quotaFromConfig(config({ cachedUsageUtilization: undefined }), NOW)).toBeNull();
    expect(
      quotaFromConfig(config({ cachedUsageUtilization: { fetchedAtMs: 'x' } }), NOW),
    ).toBeNull();
    expect(quotaFromConfig(null, NOW)).toBeNull();
    expect(quotaFromConfig([1, 2], NOW)).toBeNull();
    expect(
      quotaFromConfig(
        config({
          cachedUsageUtilization: { ...config().cachedUsageUtilization, fetchedAtMs: 1e300 },
        }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe('adapter quota()', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'glassbox-quota-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads <claudeDir>/.claude.json for a custom config dir and watches that file', async () => {
    const adapter = createClaudeCodeAdapter({ claudeDir: dir });
    expect(adapter.quotaFiles?.()).toEqual([join(dir, '.claude.json')]);
    expect(await adapter.quota?.()).toBeNull();
    await writeFile(join(dir, '.claude.json'), JSON.stringify(config()));
    expect((await adapter.quota?.())?.windows).toHaveLength(3);
  });

  it('honours globalConfigPath', async () => {
    const path = join(dir, 'elsewhere.json');
    await writeFile(path, JSON.stringify(config()));
    const adapter = createClaudeCodeAdapter({ claudeDir: join(dir, 'x'), globalConfigPath: path });
    expect(adapter.quotaFiles?.()).toEqual([path]);
    expect(await adapter.quota?.()).not.toBeNull();
  });

  it('keeps the last good snapshot while the file is mid-write', async () => {
    const path = join(dir, '.claude.json');
    const adapter = createClaudeCodeAdapter({ claudeDir: dir });
    await writeFile(path, JSON.stringify(config()));
    const good = await adapter.quota?.();
    await writeFile(path, '{"cachedUsageUtilization": {"fetch');
    expect(await adapter.quota?.()).toEqual(good);
  });
});

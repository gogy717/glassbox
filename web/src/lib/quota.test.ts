import { describe, expect, it } from 'vitest';
import type { QuotaSnapshot, QuotaWindow } from '../../../src/core/model.js';
import { makeI18n } from '../i18n';
import { quotaWindowName, sessionQuota } from './quota';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const win = (over: Partial<QuotaWindow>): QuotaWindow => ({
  id: 'five_hour',
  kind: 'session',
  label: null,
  model: null,
  usedPercent: 10,
  resetsAt: null,
  ...over,
});
const snap = (provider: string, windows: QuotaWindow[]): QuotaSnapshot => ({
  provider,
  agent: null,
  plan: null,
  fetchedAt: '2026-10-24T11:59:00Z',
  stale: false,
  windows,
  extraUsage: null,
  balance: null,
  source: 'test',
});

describe('sessionQuota', () => {
  const quotas = [
    snap('anthropic', [
      win({ usedPercent: 62 }),
      win({ id: 'weekly', kind: 'weekly', usedPercent: 38 }),
    ]),
    snap('openai', [
      win({ usedPercent: 5 }),
      win({ id: 'weekly', kind: 'weekly', usedPercent: 71 }),
    ]),
  ];

  it('names the provider’s window closest to a limit, as the top bar does', () => {
    expect(sessionQuota('claude-code', quotas, NOW)?.window.usedPercent).toBe(62);
    expect(sessionQuota('codex', quotas, NOW)?.window.kind).toBe('weekly');
  });

  it('places no session next to a plan when its agent can use any provider, or none is known', () => {
    expect(sessionQuota('oh-my-pi', quotas, NOW)).toBeNull();
    expect(sessionQuota('opencode', quotas, NOW)).toBeNull();
    expect(sessionQuota('grok', quotas, NOW)).toBeNull();
  });

  it('skips a window past its reset, and has nothing to say when every window is', () => {
    const past = '2026-10-24T11:00:00Z';
    const reset = [
      snap('anthropic', [
        win({ usedPercent: 99, resetsAt: past }),
        win({ id: 'w', kind: 'weekly', usedPercent: 40 }),
      ]),
    ];
    expect(sessionQuota('claude-code', reset, NOW)?.window.usedPercent).toBe(40);
    expect(
      sessionQuota('claude-code', [snap('anthropic', [win({ resetsAt: past })])], NOW),
    ).toBeNull();
  });
});

describe('quotaWindowName', () => {
  const { t } = makeI18n('en');
  it('uses the provider’s own name, else names the window by its kind', () => {
    expect(quotaWindowName(win({ label: 'SuperGrok Weekly Credits' }), t)).toBe(
      'SuperGrok Weekly Credits',
    );
    expect(quotaWindowName(win({}), t)).toBe('5-hour window');
    expect(quotaWindowName(win({ kind: 'weekly-model', model: 'Opus' }), t)).toBe('Weekly · Opus');
  });
});

/**
 * Synthetic oh-my-pi usage cache rows (`cache` table of `agent.db`), shaped like oh-my-pi
 * 18.12's `UsageReport`. Nothing here is copied from a real cache. Every row carries account
 * identity in the places oh-my-pi keeps it, so tests can prove none of it surfaces.
 */

export const NOW = Date.parse('2026-10-24T02:00:00.000Z');
export const SECRET_EMAIL = 'someone@example.invalid';
export const SECRET_ACCOUNT = 'acct-0000-fixture';
export const SECRET_ORG = 'Secret Org';

const DAY = 24 * 60 * 60_000;

export interface LimitSpec {
  id: string;
  label: string;
  /** Omitted: the limit has no window. */
  window?: { id: string; label?: string; durationMs?: number; resetsAt?: number };
  amount: {
    used?: number;
    limit?: number;
    remaining?: number;
    usedFraction?: number;
    remainingFraction?: number;
    unit: string;
  };
  status?: string;
}

export function limit(provider: string, spec: LimitSpec): Record<string, unknown> {
  return {
    id: spec.id,
    label: spec.label,
    scope: { provider, accountId: SECRET_ACCOUNT, windowId: spec.window?.id, shared: true },
    ...(spec.window ? { window: { label: spec.window.id, ...spec.window } } : {}),
    amount: spec.amount,
    status: spec.status ?? 'ok',
  };
}

export function report(
  provider: string,
  fetchedAt: number,
  limits: Record<string, unknown>[],
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provider,
    fetchedAt,
    limits,
    metadata: { email: SECRET_EMAIL, accountId: SECRET_ACCOUNT, orgName: SECRET_ORG, ...metadata },
  };
}

/** The `value` column: oh-my-pi's cache envelope around a report (or null once invalidated). */
export function cacheValue(
  value: Record<string, unknown> | null,
  expiresAt = NOW + 60_000,
): string {
  return JSON.stringify({ value, expiresAt });
}

/** A whole `cache` row, keyed the way oh-my-pi keys usage reports. */
export function cacheRow(
  value: Record<string, unknown> | null,
  baseUrl = 'default',
  expiresAtSec = Math.floor((NOW + DAY) / 1000),
): { key: string; value: string; expires_at: number } {
  const provider = typeof value?.provider === 'string' ? value.provider : 'unknown';
  return {
    key: `usage_cache:report:${provider}:${baseUrl}:${SECRET_EMAIL}:${SECRET_ACCOUNT}`,
    value: cacheValue(value),
    expires_at: expiresAtSec,
  };
}

/** SuperGrok: weekly credits plus per-product weekly limits, all in percent. */
export function xaiReport(fetchedAt = NOW - 5 * 60_000): Record<string, unknown> {
  const window = { id: '1w', label: 'Weekly', durationMs: 7 * DAY, resetsAt: NOW + 2 * DAY };
  const pct = (used: number) => ({
    used,
    limit: 100,
    remaining: 100 - used,
    usedFraction: used / 100,
    remainingFraction: 1 - used / 100,
    unit: 'percent',
  });
  return report(
    'xai-oauth',
    fetchedAt,
    [
      limit('xai-oauth', {
        id: 'xai-oauth:credits:1w',
        label: 'SuperGrok Weekly Credits',
        window,
        amount: pct(25),
      }),
      limit('xai-oauth', {
        id: 'xai-oauth:product:grokbuild:1w',
        label: 'Grok Build (Weekly)',
        window,
        amount: pct(9),
      }),
    ],
    { endpoint: 'https://billing.example.invalid/v1/billing', billingKind: 'weekly' },
  );
}

/** ChatGPT free plan through Codex sign-in: one 30-day window, percent without a fraction. */
export function openaiReport(fetchedAt = NOW - 5 * 60_000): Record<string, unknown> {
  return report(
    'openai-codex',
    fetchedAt,
    [
      limit('openai-codex', {
        id: 'openai-codex:primary',
        label: '30 days',
        window: { id: '30d', label: '30 days', durationMs: 30 * DAY, resetsAt: NOW + 20 * DAY },
        amount: { used: 38, limit: 100, remaining: 62, unit: 'percent' },
      }),
    ],
    { planType: 'free', orgId: SECRET_ACCOUNT },
  );
}

/** Copilot: monthly window without a duration; premium requests not reported (limit 0). */
export function copilotReport(fetchedAt = NOW - 5 * 60_000): Record<string, unknown> {
  const window = { id: 'monthly', label: 'Monthly', resetsAt: Date.parse('2026-11-01T00:00:00Z') };
  return report(
    'github-copilot',
    fetchedAt,
    [
      limit('github-copilot', {
        id: 'copilot:premium',
        label: 'Premium Requests',
        window,
        amount: { used: 0, limit: 0, remaining: 0, unit: 'requests' },
        status: 'unknown',
      }),
      limit('github-copilot', {
        id: 'copilot:chat',
        label: 'Chat Requests',
        window,
        amount: { used: 1, limit: 200, remaining: 199, usedFraction: 0.005, unit: 'requests' },
      }),
      limit('github-copilot', {
        id: 'copilot:completions',
        label: 'Completions',
        window,
        amount: { used: 15, limit: 2000, remaining: 1985, unit: 'requests' },
      }),
    ],
    { plan: 'individual', quotaResetDate: '2026-11-01' },
  );
}

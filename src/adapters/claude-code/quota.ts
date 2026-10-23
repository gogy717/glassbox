/**
 * Plan quota from Claude Code's own cache: `cachedUsageUtilization` in its global config file
 * (`~/.claude.json`). No network, no credentials.
 *
 * That file also holds the user's e-mail and account data. Only `cachedUsageUtilization` and
 * `oauthAccount.accountUuid` are ever read out of it; nothing else is kept, logged or returned.
 */
import { readFile } from 'node:fs/promises';
import type { QuotaSnapshot, QuotaWindow } from '../../core/model.js';
import { msToIso } from './records.js';

const STALE_MS = 60 * 60 * 1000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

function fromLimit(limit: unknown): QuotaWindow | null {
  const l = obj(limit);
  const usedPercent = num(l?.percent);
  if (!l || usedPercent === null || typeof l.kind !== 'string') return null;
  const resetsAt = iso(l.resets_at);
  const model = obj(obj(obj(l.scope)?.model))?.display_name;
  switch (l.kind) {
    case 'session':
      return { id: 'five_hour', kind: 'session', model: null, usedPercent, resetsAt };
    case 'weekly_all':
      return { id: 'seven_day', kind: 'weekly', model: null, usedPercent, resetsAt };
    case 'weekly_scoped':
      if (typeof model !== 'string') return null;
      return { id: `weekly:${model}`, kind: 'weekly-model', model, usedPercent, resetsAt };
    default:
      return {
        id: typeof model === 'string' ? `${l.kind}:${model}` : l.kind,
        kind: 'other',
        model: typeof model === 'string' ? model : null,
        usedPercent,
        resetsAt,
      };
  }
}

function fromLegacy(value: unknown, id: string, kind: QuotaWindow['kind']): QuotaWindow | null {
  const w = obj(value);
  const usedPercent = num(w?.utilization);
  return usedPercent === null
    ? null
    : { id, kind, model: null, usedPercent, resetsAt: iso(w?.resets_at) };
}

const money = (v: unknown) => {
  const m = obj(v);
  const amount = num(m?.amount_minor);
  return amount === null ? null : amount / 10 ** (num(m?.exponent) ?? 0);
};

function extraUsage(u: Obj): QuotaSnapshot['extraUsage'] {
  const spend = obj(u.spend);
  if (spend && spend.enabled !== false) {
    const used = money(spend.used);
    if (used !== null) {
      const currency = obj(spend.used)?.currency;
      return {
        used,
        limit: money(spend.limit),
        currency: typeof currency === 'string' ? currency : null,
      };
    }
  }
  const extra = obj(u.extra_usage);
  const credits = num(extra?.used_credits);
  if (extra && extra.is_enabled !== false && credits !== null) {
    const scale = 10 ** (num(extra.decimal_places) ?? 0);
    const limit = num(extra.monthly_limit);
    return {
      used: credits / scale,
      limit: limit === null ? null : limit / scale,
      currency: typeof extra.currency === 'string' ? extra.currency : null,
    };
  }
  return null;
}

/** Quota from a parsed global config, or null when absent, malformed or for another account. */
export function quotaFromConfig(config: unknown, now: number = Date.now()): QuotaSnapshot | null {
  const root = obj(config);
  const cached = obj(root?.cachedUsageUtilization);
  const account = obj(root?.oauthAccount)?.accountUuid;
  if (!cached) return null;
  if (typeof cached.accountUuid !== 'string' || cached.accountUuid !== account) return null;
  return quotaFromUtilization(cached.utilization, cached.fetchedAtMs, now, 'claude-code-cache');
}

/**
 * Quota from a usage endpoint body (cached by Claude Code, or fetched with `--fetch-quota`), or
 * null when it is malformed.
 */
export function quotaFromUtilization(
  utilization: unknown,
  fetchedAtMsValue: unknown,
  now: number,
  source: string,
): QuotaSnapshot | null {
  const u = obj(utilization);
  const fetchedAtMs = num(fetchedAtMsValue);
  const fetchedAt = msToIso(fetchedAtMs);
  if (!u || fetchedAtMs === null || fetchedAt === null) return null;

  const windows: QuotaWindow[] = [];
  const add = (w: QuotaWindow | null) => {
    if (w && !windows.some((x) => x.id === w.id)) windows.push(w);
  };
  for (const limit of Array.isArray(u.limits) ? u.limits : []) add(fromLimit(limit));
  add(fromLegacy(u.five_hour, 'five_hour', 'session'));
  add(fromLegacy(u.seven_day, 'seven_day', 'weekly'));
  const order: QuotaWindow['kind'][] = ['session', 'weekly', 'weekly-model', 'other'];
  windows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  return {
    agent: 'claude-code',
    fetchedAt,
    stale: now - fetchedAtMs > STALE_MS,
    windows,
    extraUsage: extraUsage(u),
    source,
  };
}

export type QuotaRead = { kind: 'ok'; quota: QuotaSnapshot | null } | { kind: 'unreadable' };

/** Reads the config file. `unreadable` means it exists but is not valid JSON (mid-write). */
export async function readQuotaFile(path: string, now: number = Date.now()): Promise<QuotaRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { kind: 'ok', quota: null };
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return { kind: 'unreadable' };
  }
  return { kind: 'ok', quota: quotaFromConfig(config, now) };
}

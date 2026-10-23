/**
 * Opt-in (`--fetch-quota`): asks xAI for the SuperGrok plan usage with Grok CLI's own sign-in.
 * The endpoint is the one oh-my-pi asks for its `xai-oauth` provider (and the path Grok CLI's
 * billing extension asks), `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`; it
 * answers the weekly credit window and its share per product (GrokBot, Grok Build, ...).
 *
 * Only the access token (`key`) and `expires_at` are read out of `auth.json`; the e-mail, names
 * and ids beside them are not. The token is sent to cli-chat-proxy.grok.com and nowhere else (no
 * redirects), and is never logged or kept between requests. An expired token is never refreshed:
 * refreshing rotates it and could sign Grok CLI out, so glassbox waits until Grok CLI has
 * refreshed it itself.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QuotaSnapshot, QuotaWindow } from '../../core/model.js';
import type { QuotaSource } from '../../core/quota-source.js';
import { type Attempt, getJson, periodicFetch, STALE_MS } from '../../quota/periodic-fetch.js';

export const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
/** Treat a token this close to expiry as expired: it could lapse mid-request. */
const EXPIRY_MARGIN_MS = 60_000;
/** Products as oh-my-pi labels them, so windows read the same whichever source is newer. */
const PRODUCT_NAMES: Record<string, string> = { GrokBuild: 'Grok Build', Api: 'API' };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
const percent = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
const isoMs = (v: unknown) => {
  const ms = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
};

/** Why there is no usable token, for the log; never includes the token itself. */
type TokenRead = { token: string } | { missing: string };

/**
 * The token in Grok CLI's `auth.json`: one entry per sign-in, keyed by issuer and client; the
 * one that expires last wins.
 */
export function tokenFrom(text: string, now: number): TokenRead {
  let root: Obj | null;
  try {
    root = obj(JSON.parse(text));
  } catch {
    return { missing: 'the Grok sign-in is not valid JSON' };
  }
  let best: { token: string; expiresAt: number | null } | null = null;
  for (const value of Object.values(root ?? {})) {
    const entry = obj(value);
    const token = entry?.key;
    if (typeof token !== 'string' || token === '') continue;
    const expiresAt = isoMs(entry?.expires_at);
    if (!best || (expiresAt ?? -1) > (best.expiresAt ?? -1)) best = { token, expiresAt };
  }
  if (!best) return { missing: 'not signed in to Grok (`grok login`)' };
  if (best.expiresAt !== null && best.expiresAt - EXPIRY_MARGIN_MS <= now) {
    return { missing: 'the Grok sign-in has expired; Grok CLI renews it the next time it runs' };
  }
  return { token: best.token };
}

/**
 * Windows from a `/v1/billing?format=credits` answer: the weekly credits, then each product's
 * share of them. Empty when the answer has no weekly period: an error envelope, or an account
 * billed monthly (oh-my-pi then asks `/v1/billing` without `format`; glassbox does not).
 */
export function billingWindows(body: unknown): QuotaWindow[] {
  const config = obj(obj(body)?.config);
  const period = obj(config?.currentPeriod);
  const type = period?.type;
  if (!config || typeof type !== 'string' || !type.toUpperCase().includes('WEEK')) return [];
  const end = isoMs(period?.end);
  const resetsAt = end === null ? null : new Date(end).toISOString();
  const windows: QuotaWindow[] = [];
  const add = (id: string, label: string, usedPercent: number) => {
    if (!windows.some((w) => w.id === id)) {
      windows.push({ id, kind: 'weekly', label, model: null, usedPercent, resetsAt });
    }
  };
  const credits = percent(config.creditUsagePercent);
  if (credits !== null) add('credits:1w', 'SuperGrok Weekly Credits', credits);
  for (const item of Array.isArray(config.productUsage) ? config.productUsage : []) {
    const p = obj(item);
    const product = typeof p?.product === 'string' ? p.product.trim() : '';
    const slug = product.toLowerCase().replace(/[^a-z0-9]/g, '');
    // A product without a number has not been used this week.
    const used = p?.usagePercent == null ? 0 : percent(p.usagePercent);
    if (slug && used !== null) {
      add(`product:${slug}:1w`, `${PRODUCT_NAMES[product] ?? product} (Weekly)`, used);
    }
  }
  return windows;
}

export function xaiSnapshot(
  windows: QuotaWindow[],
  fetchedAtMs: number,
  now: number,
): QuotaSnapshot {
  return {
    provider: 'xai',
    agent: 'grok',
    // The answer does not name the plan.
    plan: null,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    stale: now - fetchedAtMs > STALE_MS,
    windows,
    extraUsage: null,
    balance: null,
    source: 'xai-api',
  };
}

export interface XaiQuotaOptions {
  /** The Grok config dir, which holds `auth.json`. */
  grokDir: string;
  /** Minimum time between requests, failed or not. */
  intervalMs?: number;
  log?: (msg: string) => void;
  /** Injected in tests. */
  fetch?: typeof fetch;
  readText?: (path: string) => Promise<string>;
  now?: () => number;
}

export function createXaiQuotaSource(opts: XaiQuotaOptions): QuotaSource {
  const doFetch = opts.fetch ?? fetch;
  const readText = opts.readText ?? ((path: string) => readFile(path, 'utf8'));
  const now = opts.now ?? Date.now;

  async function attempt(): Promise<Attempt<QuotaWindow[]>> {
    let text: string;
    try {
      text = await readText(join(opts.grokDir, 'auth.json'));
    } catch {
      return { problem: 'no Grok sign-in found' };
    }
    const read = tokenFrom(text, now());
    if ('missing' in read) return { problem: read.missing };
    const res = await getJson(
      doFetch,
      BILLING_URL,
      {
        Authorization: `Bearer ${read.token}`,
        Accept: 'application/json',
        // Grok CLI's header: the proxy validates the bearer as a CLI sign-in.
        'X-XAI-Token-Auth': 'xai-grok-cli',
      },
      read.token,
      'the billing endpoint',
    );
    if ('problem' in res) return res;
    // An error envelope has no windows; it must not replace real ones.
    const windows = billingWindows(res.ok);
    return windows.length > 0
      ? { ok: windows }
      : { problem: 'the billing endpoint answered in an unknown format' };
  }

  const loop = periodicFetch({
    attempt,
    name: 'quota fetch (xAI)',
    intervalMs: opts.intervalMs,
    log: opts.log,
    now,
  });

  return {
    id: 'xai-api',
    async read() {
      const last = await loop.latest();
      // Rebuilt on every read so `stale` follows the clock.
      return last ? [xaiSnapshot(last.value, last.fetchedAtMs, now())] : [];
    },
  };
}

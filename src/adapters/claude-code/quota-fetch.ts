/**
 * Opt-in (`--fetch-quota`): asks Anthropic's usage endpoint for the plan quota with Claude Code's
 * own sign-in, so the quota stays fresh without `/usage` or ClaudeBar refreshing Claude Code's
 * cache.
 *
 * Only `claudeAiOauth.accessToken`, `expiresAt` and the plan (`subscriptionType`, `rateLimitTier`)
 * are read out of the credentials. The token is
 * sent to api.anthropic.com and nowhere else, and is never logged or kept between requests. An
 * expired token is never refreshed: refreshing rotates it and could sign Claude Code out, so
 * glassbox waits until Claude Code has refreshed it itself.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QuotaSnapshot } from '../../core/model.js';
import { type Obj, obj } from '../../quota/shared.js';
import { planName, quotaFromUtilization } from './quota.js';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Where Claude Code keeps its sign-in on macOS, instead of `.credentials.json`. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
/** Treat a token this close to expiry as expired: it could lapse mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

export interface QuotaFetcher {
  /** The last fetched quota, fetching first when the interval has passed. Never rejects. */
  latest(): Promise<QuotaSnapshot | null>;
}

export interface QuotaFetcherOptions {
  /** The Claude config dir, which holds `.credentials.json`. */
  claudeDir: string;
  /** Minimum time between requests, failed or not. */
  intervalMs?: number;
  log?: (msg: string) => void;
  /** Injected in tests. */
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  readText?: (path: string) => Promise<string>;
  keychain?: () => Promise<string>;
  now?: () => number;
}

const readKeychain = () =>
  new Promise<string>((resolve, reject) =>
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: TIMEOUT_MS },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    ),
  );

/** Why there is no usable token, for the log; never includes the token itself. */
type TokenRead = { token: string; plan: string | null } | { missing: string };

function tokenFrom(text: string, now: number): TokenRead {
  let oauth: Obj | null;
  try {
    oauth = obj(obj(JSON.parse(text))?.claudeAiOauth);
  } catch {
    return { missing: 'the credentials are not valid JSON' };
  }
  const token = oauth?.accessToken;
  if (typeof token !== 'string' || token === '') return { missing: 'not signed in to Claude' };
  const expiresAt = oauth?.expiresAt;
  if (typeof expiresAt === 'number' && expiresAt - EXPIRY_MARGIN_MS <= now) {
    return { missing: 'the sign-in has expired; Claude Code renews it on its next request' };
  }
  return { token, plan: planName(oauth?.subscriptionType, oauth?.rateLimitTier) };
}

export function createQuotaFetcher(opts: QuotaFetcherOptions): QuotaFetcher {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = opts.log ?? (() => {});
  const platform = opts.platform ?? process.platform;
  const doFetch = opts.fetch ?? fetch;
  const readText = opts.readText ?? ((path: string) => readFile(path, 'utf8'));
  const keychain = opts.keychain ?? readKeychain;
  const now = opts.now ?? Date.now;

  let body: unknown = null;
  let plan: string | null = null;
  let fetchedAtMs = 0;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  /** The last failure logged, so a failure repeating every interval is logged once. */
  let lastProblem: string | null = null;

  const problem = (msg: string) => {
    if (msg !== lastProblem) log(`quota fetch: ${msg}`);
    lastProblem = msg;
  };

  async function readToken(): Promise<TokenRead> {
    let text: string | null = null;
    try {
      text = await readText(join(opts.claudeDir, '.credentials.json'));
    } catch {
      if (platform === 'darwin') text = await keychain().catch(() => null);
    }
    return text === null ? { missing: 'no Claude Code sign-in found' } : tokenFrom(text, now());
  }

  async function refresh(): Promise<void> {
    const read = await readToken();
    if ('missing' in read) return problem(read.missing);
    let res: Response;
    try {
      res = await doFetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${read.token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return problem(`request failed (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!res.ok) return problem(`the usage endpoint answered HTTP ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return problem('the usage endpoint did not answer JSON');
    }
    // An error envelope parses as a quota with no windows; it must not replace a real one.
    if (!quotaFromUtilization(json, now(), now(), 'anthropic-usage-api')?.windows.length) {
      return problem('the usage endpoint answered in an unknown format');
    }
    body = json;
    plan = read.plan;
    fetchedAtMs = now();
    if (lastProblem !== null) log('quota fetch: working again');
    lastProblem = null;
  }

  return {
    async latest() {
      if (!inFlight && now() - lastAttempt >= intervalMs) {
        lastAttempt = now();
        inFlight = refresh().finally(() => {
          inFlight = null;
        });
      }
      if (inFlight) await inFlight;
      // Rebuilt on every read so `stale` follows the clock.
      return body === null
        ? null
        : quotaFromUtilization(body, fetchedAtMs, now(), 'anthropic-usage-api', plan);
    },
  };
}

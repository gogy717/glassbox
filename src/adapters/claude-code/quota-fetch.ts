/**
 * Opt-in (`--fetch-quota`): asks Anthropic's usage endpoint for the plan quota with Claude Code's
 * own sign-in, so the quota stays fresh without `/usage` or ClaudeBar refreshing Claude Code's
 * cache.
 *
 * Only `claudeAiOauth.accessToken`, `expiresAt` and the plan (`subscriptionType`, `rateLimitTier`)
 * are read out of the credentials. The token is sent to api.anthropic.com and nowhere else (no
 * redirects), and is never logged or kept between requests. An expired token is never refreshed:
 * refreshing rotates it and could sign Claude Code out, so glassbox waits until Claude Code has
 * refreshed it itself. The request loop is `periodicFetch`, shared with the other providers.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QuotaSnapshot } from '../../core/model.js';
import { type Attempt, getJson, periodicFetch } from '../../quota/periodic-fetch.js';
import { type Obj, obj } from '../../quota/shared.js';
import { planName, quotaFromUtilization } from './quota.js';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Where Claude Code keeps its sign-in on macOS, instead of `.credentials.json`. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 10_000;
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
      { timeout: KEYCHAIN_TIMEOUT_MS },
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
  // A header cannot carry it, and fetch would quote it in the error.
  if (!/^[\x21-\x7e]+$/.test(token)) return { missing: 'the sign-in token is malformed' };
  const expiresAt = oauth?.expiresAt;
  if (typeof expiresAt === 'number' && expiresAt - EXPIRY_MARGIN_MS <= now) {
    return { missing: 'the sign-in has expired; Claude Code renews it on its next request' };
  }
  return { token, plan: planName(oauth?.subscriptionType, oauth?.rateLimitTier) };
}

/** A usage answer worth keeping, and the plan the credentials named when it was fetched. */
interface Usage {
  body: unknown;
  plan: string | null;
}

export function createQuotaFetcher(opts: QuotaFetcherOptions): QuotaFetcher {
  const platform = opts.platform ?? process.platform;
  const doFetch = opts.fetch ?? fetch;
  const readText = opts.readText ?? ((path: string) => readFile(path, 'utf8'));
  const keychain = opts.keychain ?? readKeychain;
  const now = opts.now ?? Date.now;

  async function readToken(): Promise<TokenRead> {
    let text: string | null = null;
    try {
      text = await readText(join(opts.claudeDir, '.credentials.json'));
    } catch {
      if (platform === 'darwin') text = await keychain().catch(() => null);
    }
    return text === null ? { missing: 'no Claude Code sign-in found' } : tokenFrom(text, now());
  }

  async function attempt(): Promise<Attempt<Usage>> {
    const read = await readToken();
    if ('missing' in read) return { problem: read.missing };
    const res = await getJson(
      doFetch,
      USAGE_URL,
      {
        Authorization: `Bearer ${read.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
      read.token,
      'the usage endpoint',
    );
    if ('problem' in res) return res;
    // An error envelope parses as a quota with no windows; it must not replace a real one.
    if (!quotaFromUtilization(res.ok, now(), now(), 'anthropic-usage-api')?.windows.length) {
      return { problem: 'the usage endpoint answered in an unknown format' };
    }
    return { ok: { body: res.ok, plan: read.plan } };
  }

  const loop = periodicFetch({
    attempt,
    name: 'quota fetch (Anthropic)',
    intervalMs: opts.intervalMs,
    log: opts.log,
    now,
  });

  return {
    async latest() {
      const last = await loop.latest();
      // Rebuilt on every read so `stale` follows the clock.
      return last
        ? quotaFromUtilization(
            last.value.body,
            last.fetchedAtMs,
            now(),
            'anthropic-usage-api',
            last.value.plan,
          )
        : null;
    },
  };
}

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeCodeAdapter } from '../adapters/claude-code/index.js';
import { createDemoQuota } from '../core/fixtures/demo.js';
import type { QuotaSnapshot } from '../core/model.js';
import { FETCH_QUOTA_PROVIDERS } from './args.js';
import { createFetchQuota } from './fetch-quota.js';

// Every file read in this module graph goes through the spy, so a credential read is seen.
const readFile = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  readFile.mockImplementation(fs.readFile);
  return { ...fs, readFile };
});

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const TOKEN = 'sk-fixture-token';
const CREDENTIAL_FILES = /[/\\](\.credentials|auth)\.json$/;

let root: string;
let claudeDir: string;
let grokDir: string;
let logs: string[];
let fetch: ReturnType<typeof vi.fn>;
/** Every environment variable read, by name. */
let envReads: string[];
let vars: Record<string, string | undefined>;
let env: Record<string, string | undefined>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  root = await mkdtemp(join(tmpdir(), 'glassbox-fetch-quota-'));
  claudeDir = join(root, 'claude');
  grokDir = join(root, 'grok');
  logs = [];
  envReads = [];
  fetch = vi.fn(async () => new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  vars = {};
  env = new Proxy(vars, {
    get: (target, name) => {
      if (typeof name === 'string') envReads.push(name);
      return target[name as string];
    },
  });
  readFile.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

/** Claude Code signed in until `claudeExpiresAt`; no Grok sign-in and no DeepSeek key yet. */
async function signIn(opts: { claudeExpiresAt: number }) {
  await mkdir(claudeDir, { recursive: true });
  await mkdir(grokDir, { recursive: true });
  await writeFile(
    join(claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: opts.claudeExpiresAt } }),
  );
}

/** Everything the server reads for quotas: Claude Code's adapter, then every other source. */
async function readAll(fq: ReturnType<typeof createFetchQuota>) {
  const adapter = createClaudeCodeAdapter({ claudeDir, quotaFetcher: fq.anthropic });
  await adapter.quota?.();
  for (const source of fq.sources) await source.read();
}

const credentialReads = () =>
  readFile.mock.calls.map(([path]) => String(path)).filter((p) => CREDENTIAL_FILES.test(p));

const stale = (provider: string): QuotaSnapshot => ({
  ...createDemoQuota(new Date(NOW - 16 * 60 * 60_000)),
  provider,
  stale: true,
});

describe('createFetchQuota', () => {
  it('with no provider, makes no request and reads no credential or environment variable', async () => {
    await signIn({ claudeExpiresAt: NOW + 60 * 60_000 });
    const fq = createFetchQuota({
      providers: [],
      claudeDir,
      grokDir,
      log: (m) => logs.push(m),
      env,
    });
    expect(fq.anthropic).toBeUndefined();
    expect(fq.sources).toEqual([]);
    await readAll(fq);
    vi.setSystemTime(NOW + 10 * 60_000);
    await readAll(fq);
    expect(fetch).not.toHaveBeenCalled();
    expect(credentialReads()).toEqual([]);
    expect(envReads).toEqual([]);
    // Claude Code's own cache is still read: it is not a credential.
    expect(readFile).toHaveBeenCalledWith(join(claudeDir, '.claude.json'), 'utf8');
    expect(logs).toEqual([
      'asking no provider for plan usage: showing only what the agents cache themselves',
    ]);
  });

  it('asks every provider by default, each with its own credential', async () => {
    await signIn({ claudeExpiresAt: NOW + 60 * 60_000 });
    await writeFile(
      join(grokDir, 'auth.json'),
      JSON.stringify({ a: { key: TOKEN, expires_at: new Date(NOW + 60 * 60_000).toISOString() } }),
    );
    vars.DEEPSEEK_API_KEY = TOKEN;
    const fq = createFetchQuota({
      providers: [...FETCH_QUOTA_PROVIDERS],
      claudeDir,
      grokDir,
      log: (m) => logs.push(m),
      env,
    });
    await readAll(fq);
    const hosts = fetch.mock.calls.map(([url]) => new URL(String(url)).host);
    expect(hosts).toEqual(['api.anthropic.com', 'cli-chat-proxy.grok.com', 'api.deepseek.com']);
    expect(credentialReads()).toEqual([
      join(claudeDir, '.credentials.json'),
      join(grokDir, 'auth.json'),
    ]);
    expect(envReads).toContain('DEEPSEEK_API_KEY');
    expect(logs[0]).toBe(
      'asking for plan usage every 5 minutes: Anthropic (your Claude Code sign-in), ' +
        'xAI (your Grok CLI sign-in), DeepSeek ($DEEPSEEK_API_KEY) (--no-fetch-quota to stop)',
    );
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('logs each missing or expired credential once, and says why its quota is stale', async () => {
    await signIn({ claudeExpiresAt: NOW - 60_000 });
    const fq = createFetchQuota({
      providers: [...FETCH_QUOTA_PROVIDERS],
      claudeDir,
      grokDir,
      log: (m) => logs.push(m),
      env,
    });
    await readAll(fq);
    vi.setSystemTime(NOW + 10 * 60_000);
    await readAll(fq);
    expect(fetch).not.toHaveBeenCalled();
    expect(logs.slice(1)).toEqual([
      'quota fetch (Anthropic): the sign-in has expired; Claude Code renews it on its next request',
      'quota fetch (xAI): no Grok sign-in found',
      'quota fetch (DeepSeek): DEEPSEEK_API_KEY is not set',
    ]);
    expect(fq.staleReason(stale('anthropic'))).toBe('sign-in-expired');
    expect(fq.staleReason(stale('xai'))).toBe('no-credentials');
    expect(fq.staleReason(stale('deepseek'))).toBe('no-credentials');
    expect(fq.staleReason(stale('openai'))).toBe('cache-only');
    expect(fq.staleReason(stale('github-copilot'))).toBe('cache-only');
  });

  it('says a provider it was told not to ask is not fetched, and a failed request failed', async () => {
    await signIn({ claudeExpiresAt: NOW + 60 * 60_000 });
    const fq = createFetchQuota({
      providers: ['anthropic'],
      claudeDir,
      grokDir,
      log: (m) => logs.push(m),
      env,
    });
    await readAll(fq);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fq.staleReason(stale('anthropic'))).toBe('fetch-failed');
    expect(fq.staleReason(stale('xai'))).toBe('not-fetching');
    expect(fq.staleReason(stale('deepseek'))).toBe('not-fetching');
    expect(credentialReads()).toEqual([join(claudeDir, '.credentials.json')]);
    expect(envReads).toEqual([]);
  });
});

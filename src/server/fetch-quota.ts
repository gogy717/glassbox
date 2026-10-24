/**
 * The providers glassbox asks for plan usage over the network (every one unless
 * `--no-fetch-quota`), and why a stale quota is stale given them.
 */
import { createQuotaFetcher, type QuotaFetcher } from '../adapters/claude-code/quota-fetch.js';
import { createXaiQuotaSource } from '../adapters/grok/quota-fetch.js';
import type { QuotaProvider, QuotaSnapshot, QuotaStaleReason } from '../core/model.js';
import type { FetchStatus, QuotaSource } from '../core/quota-source.js';
import { createDeepSeekBalanceSource } from '../quota/deepseek-balance.js';
import { FETCH_QUOTA_PROVIDERS, type FetchQuotaProvider } from './args.js';

/** Whom glassbox asks, and with which credential, for the startup log. */
const FETCH_QUOTA_WITH: Record<FetchQuotaProvider, string> = {
  anthropic: 'Anthropic (your Claude Code sign-in)',
  xai: 'xAI (your Grok CLI sign-in)',
  deepseek: 'DeepSeek ($DEEPSEEK_API_KEY)',
};

export interface FetchQuotaOptions {
  /** The providers to ask; with none, no fetcher exists and no credential is ever read. */
  providers: FetchQuotaProvider[];
  /** Holds Claude Code's sign-in. */
  claudeDir: string;
  /** Holds Grok CLI's sign-in; read even with --no-grok, which only hides Grok sessions. */
  grokDir: string;
  log: (msg: string) => void;
  /** Injected in tests. */
  fetch?: typeof fetch;
  readText?: (path: string) => Promise<string>;
  env?: Record<string, string | undefined>;
}

export interface FetchQuota {
  /** Anthropic's fetcher, for the Claude Code adapter to weigh against Claude Code's cache. */
  anthropic: QuotaFetcher | undefined;
  /** The other providers' fetchers. */
  sources: QuotaSource[];
  /** Why a stale quota is stale; undefined when glassbox cannot tell. */
  staleReason(q: QuotaSnapshot): QuotaStaleReason | undefined;
}

export function createFetchQuota(opts: FetchQuotaOptions): FetchQuota {
  const { providers, log } = opts;
  const io = { fetch: opts.fetch, readText: opts.readText, log };
  const fetchers = new Map<QuotaProvider, FetchStatus>();
  const sources: QuotaSource[] = [];
  const anthropic = providers.includes('anthropic')
    ? createQuotaFetcher({ claudeDir: opts.claudeDir, ...io })
    : undefined;
  if (anthropic) fetchers.set('anthropic', anthropic);
  if (providers.includes('xai')) {
    const xai = createXaiQuotaSource({ grokDir: opts.grokDir, ...io });
    fetchers.set('xai', xai);
    sources.push(xai);
  }
  if (providers.includes('deepseek')) {
    const deepseek = createDeepSeekBalanceSource({ env: opts.env, fetch: opts.fetch, log });
    fetchers.set('deepseek', deepseek);
    sources.push(deepseek);
  }
  if (providers.length > 0) {
    const whom = providers.map((p) => FETCH_QUOTA_WITH[p]).join(', ');
    log(`asking for plan usage every 5 minutes: ${whom} (--no-fetch-quota to stop)`);
  } else {
    log('asking no provider for plan usage: showing only what the agents cache themselves');
  }

  const fetchable: readonly QuotaProvider[] = FETCH_QUOTA_PROVIDERS;
  return {
    anthropic,
    sources,
    staleReason(q) {
      if (!fetchable.includes(q.provider)) return 'cache-only';
      const fetcher = fetchers.get(q.provider);
      return fetcher ? (fetcher.problem() ?? undefined) : 'not-fetching';
    },
  };
}

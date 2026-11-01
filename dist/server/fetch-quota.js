/**
 * The providers glassbox asks for plan usage over the network (every one unless
 * `--no-fetch-quota`), and why a stale quota is stale given them.
 */
import { createQuotaFetcher } from '../adapters/claude-code/quota-fetch.js';
import { createXaiQuotaSource } from '../adapters/grok/quota-fetch.js';
import { createDeepSeekBalanceSource } from '../quota/deepseek-balance.js';
import { FETCH_QUOTA_PROVIDERS } from './args.js';
/** Whom glassbox asks, and with which credential, for the startup log. */
const FETCH_QUOTA_WITH = {
    anthropic: 'Anthropic (your Claude Code sign-in)',
    xai: 'xAI (your Grok CLI sign-in)',
    deepseek: 'DeepSeek ($DEEPSEEK_API_KEY)',
};
export function createFetchQuota(opts) {
    const { providers, log } = opts;
    const io = { fetch: opts.fetch, readText: opts.readText, log };
    const fetchers = new Map();
    const sources = [];
    const anthropic = providers.includes('anthropic')
        ? createQuotaFetcher({ claudeDir: opts.claudeDir, ...io })
        : undefined;
    if (anthropic)
        fetchers.set('anthropic', anthropic);
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
    }
    else {
        log('asking no provider for plan usage: showing only what the agents cache themselves');
    }
    const fetchable = FETCH_QUOTA_PROVIDERS;
    return {
        anthropic,
        sources,
        staleReason(q) {
            if (!fetchable.includes(q.provider))
                return 'cache-only';
            const fetcher = fetchers.get(q.provider);
            return fetcher ? (fetcher.problem() ?? undefined) : 'not-fetching';
        },
    };
}
//# sourceMappingURL=fetch-quota.js.map
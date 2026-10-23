/** Display names of the providers whose plan quotas glassbox shows. */
import type { QuotaProvider } from '../../../src/core/model.js';

const NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  'github-copilot': 'GitHub Copilot',
  deepseek: 'DeepSeek',
};

/** What people call the plan's product, for the top bar where space is short. */
const SHORT_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  xai: 'Grok',
  'github-copilot': 'Copilot',
  deepseek: 'DeepSeek',
};

/** "Anthropic" for 'anthropic'; a provider without a known name shows its id as is. */
export const providerName = (provider: QuotaProvider): string => NAMES[provider] ?? provider;

/** "Claude" for 'anthropic'; a provider without a known name shows its id as is. */
export const providerShortName = (provider: QuotaProvider): string =>
  SHORT_NAMES[provider] ?? provider;

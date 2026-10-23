import type {
  AgentKind,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindow,
} from '../../../src/core/model.js';
import type { T } from '../i18n';

/**
 * The plan provider of an agent that only ever talks to one. oh-my-pi and OpenCode can use any
 * provider, so a session of theirs is not placed next to any one plan.
 */
const SINGLE_PROVIDER: Partial<Record<AgentKind, QuotaProvider>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  grok: 'xai',
};

/**
 * The plan window to name next to a session of `kind`: its provider's window closest to a limit,
 * the one the top bar's meter shows. A window past its reset time is history, not current usage.
 * Null when the agent has no single provider, or its provider has no current window.
 */
export function sessionQuota(
  kind: AgentKind,
  quotas: readonly QuotaSnapshot[],
  now: number,
): { snapshot: QuotaSnapshot; window: QuotaWindow } | null {
  const provider = SINGLE_PROVIDER[kind];
  const snapshot = provider ? quotas.find((q) => q.provider === provider) : undefined;
  if (!snapshot) return null;
  const window = snapshot.windows
    .filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now)
    .reduce<QuotaWindow | null>((a, b) => (!a || b.usedPercent > a.usedPercent ? b : a), null);
  return window ? { snapshot, window } : null;
}

/** A window's name: the provider's own, else by its kind ("5-hour window", "Weekly · Opus"). */
export function quotaWindowName(w: QuotaWindow, t: T): string {
  if (w.label) return w.label;
  switch (w.kind) {
    case 'session':
      return t('quota.windowSession');
    case 'weekly':
      return t('quota.windowWeekly');
    case 'weekly-model':
      return t('quota.windowModel', { model: w.model ?? w.id });
    case 'monthly':
      return t('quota.windowMonthly');
    default:
      return w.id;
  }
}

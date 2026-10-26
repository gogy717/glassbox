import type { Locale } from './i18n';
import { AGENT_TONES } from './lib/agent-names';
import { PRICE_KINDS, type Price } from './lib/prices';
import type { GroupBy } from './lib/sessions';

export type ThemePref = 'system' | 'light' | 'dark';
export interface Prefs {
  /** English unless the person picked Chinese in the settings, whatever the browser prefers. */
  locale: Locale;
  theme: ThemePref;
  showProbes: boolean;
  /** The CLI whose token rate the top bar shows; null for all of them. */
  rateAgent: string | null;
  /** A desktop notification when a session begins to wait for you; the browser must allow it. */
  notify: boolean;
  /** How the session list groups its rows (D, F7): by project, or by when each last ran. */
  groupBy: GroupBy;
  /** The list's folded groups, by key: a project's name, or `/pinned`, `/today` … `/earlier`. */
  folded: string[];
  /** Pinned sessions, by id, in the order pinned. */
  pinned: string[];
  /** Whether Stats has said, once, why it opened on the last 7 days early in a week. */
  statsNoteSeen: boolean;
  /** API prices set in Settings, over the defaults, by model id (USD per million tokens). */
  prices: Record<string, Price>;
}

const KEY = 'glassbox.prefs';
export const DEFAULT_PREFS: Prefs = {
  locale: 'en',
  theme: 'system',
  showProbes: false,
  rateAgent: null,
  notify: false,
  groupBy: 'project',
  folded: [],
  pinned: [],
  statsNoteSeen: false,
  prices: {},
};

/** The strings of a saved list, each once; anything else that landed there is dropped. */
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [];

/** Saved prices: each model's row whole (every price a number, zero or more), or left out. */
function prices(v: unknown): Record<string, Price> {
  const out: Record<string, Price> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [model, row] of Object.entries(v)) {
    if (!model || typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (PRICE_KINDS.every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]) && r[k] >= 0))
      out[model] = Object.fromEntries(PRICE_KINDS.map((k) => [k, r[k]])) as unknown as Price;
  }
  return out;
}

/** Storage can be unavailable (private windows, blocked site data); prefs are a convenience. */
export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null;
    return {
      // Older versions saved 'auto' (the browser's language); that now means the default.
      locale: raw?.locale === 'zh' ? 'zh' : 'en',
      theme: raw?.theme === 'light' || raw?.theme === 'dark' ? raw.theme : 'system',
      showProbes: raw?.showProbes === true,
      // A CLI glassbox knows; anything else (an old or mistyped value) means every CLI.
      rateAgent: (AGENT_TONES as readonly unknown[]).includes(raw?.rateAgent)
        ? (raw?.rateAgent as string)
        : null,
      notify: raw?.notify === true,
      groupBy: raw?.groupBy === 'time' ? 'time' : 'project',
      folded: strings(raw?.folded),
      pinned: strings(raw?.pinned),
      statsNoteSeen: raw?.statsNoteSeen === true,
      prices: prices(raw?.prices),
    };
  } catch {
    return { ...DEFAULT_PREFS, folded: [], pinned: [], prices: {} };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Not persisted; the choice still applies for this page.
  }
}

export function applyTheme(theme: ThemePref): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

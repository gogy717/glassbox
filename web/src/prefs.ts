import type { Locale } from './i18n';
import { AGENT_TONES } from './lib/agent-names';

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
}

const KEY = 'glassbox.prefs';
const DEFAULTS: Prefs = {
  locale: 'en',
  theme: 'system',
  showProbes: false,
  rateAgent: null,
  notify: false,
};

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
    };
  } catch {
    return DEFAULTS;
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

import { useSyncExternalStore } from 'react';

/** What the prompt list's field searches, remembered per viewer like the detail panel's prefs. */
export interface SearchPrefs {
  /** The prompts' titles, or everything the page holds for the agent (`searchSession`). */
  scope: 'titles' | 'everything';
}

export type SearchScope = SearchPrefs['scope'];

const KEY = 'glassbox.search';
const DEFAULTS: SearchPrefs = { scope: 'titles' };

/** Storage can be unavailable (private windows, blocked site data); prefs are a convenience. */
function load(): SearchPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<SearchPrefs> | null;
    return { scope: raw?.scope === 'everything' ? 'everything' : 'titles' };
  } catch {
    return DEFAULTS;
  }
}

let current: SearchPrefs | null = null;
const listeners = new Set<() => void>();

const get = () => {
  current ??= load();
  return current;
};

function set(patch: Partial<SearchPrefs>): void {
  current = { ...get(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Not persisted; the choice still applies for this page.
  }
  for (const cb of listeners) cb();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** The search prefs, and a setter that remembers a change. */
export function useSearchPrefs(): [SearchPrefs, (patch: Partial<SearchPrefs>) => void] {
  return [useSyncExternalStore(subscribe, get, get), set];
}

/** Tests: forget what an earlier test chose. */
export function resetSearchPrefs(): void {
  current = null;
}

import { useSyncExternalStore } from 'react';

/** How details are shown, remembered per viewer like the app's other prefs. */
export interface DetailPrefs {
  /** Readable text, or the JSON as recorded. */
  view: 'readable' | 'json';
  /** Request messages, newest or oldest first. */
  order: 'newest' | 'oldest';
  /** Model replies' markdown rendered, or shown as written. */
  markdown: 'rendered' | 'source';
  /** A request's card: what it sent, or the bill of its context. */
  request: 'details' | 'context';
}

const KEY = 'glassbox.detail';
const DEFAULTS: DetailPrefs = {
  view: 'readable',
  order: 'newest',
  markdown: 'rendered',
  request: 'details',
};

/** Storage can be unavailable (private windows, blocked site data); prefs are a convenience. */
function load(): DetailPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<DetailPrefs> | null;
    return {
      view: raw?.view === 'json' ? 'json' : 'readable',
      order: raw?.order === 'oldest' ? 'oldest' : 'newest',
      markdown: raw?.markdown === 'source' ? 'source' : 'rendered',
      request: raw?.request === 'context' ? 'context' : 'details',
    };
  } catch {
    return DEFAULTS;
  }
}

let current: DetailPrefs | null = null;
const listeners = new Set<() => void>();

const get = () => {
  current ??= load();
  return current;
};

function set(patch: Partial<DetailPrefs>): void {
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

/** The detail prefs, shared by every open panel, and a setter that remembers a change. */
export function useDetailPrefs(): [DetailPrefs, (patch: Partial<DetailPrefs>) => void] {
  return [useSyncExternalStore(subscribe, get, get), set];
}

/** Tests: forget what an earlier test chose. */
export function resetDetailPrefs(): void {
  current = null;
}

import { useSyncExternalStore } from 'react';

/** How the Files tab is scoped, remembered per viewer like the detail panel's prefs. */
export interface FilesPrefs {
  /** The selected agent's sub-agents' files too (the summary bar counts them as well). */
  subAgents: boolean;
}

const KEY = 'glassbox.files';
const DEFAULTS: FilesPrefs = { subAgents: true };

/** Storage can be unavailable (private windows, blocked site data); prefs are a convenience. */
function load(): FilesPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<FilesPrefs> | null;
    return { subAgents: raw?.subAgents !== false };
  } catch {
    return DEFAULTS;
  }
}

let current: FilesPrefs | null = null;
const listeners = new Set<() => void>();

const get = () => {
  current ??= load();
  return current;
};

function set(patch: Partial<FilesPrefs>): void {
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

/** The Files tab's prefs, and a setter that remembers a change. */
export function useFilesPrefs(): [FilesPrefs, (patch: Partial<FilesPrefs>) => void] {
  return [useSyncExternalStore(subscribe, get, get), set];
}

/** Tests: forget what an earlier test chose. */
export function resetFilesPrefs(): void {
  current = null;
}

import { type Dirent, type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DirWatcher {
  close(): void;
  /** Replace the watched set. Files already inside a newly added dir are reported. */
  setDirs(dirs: string[]): void;
}

export interface WatchOptions {
  /** Stat-poll interval; the fallback for missed or unsupported fs.watch events. */
  pollMs?: number;
  /** Set false to rely on polling alone (e.g. network filesystems). */
  fsWatch?: boolean;
}

interface DirState {
  /** file name → stat signature as of the last scan */
  files: Map<string, string>;
  watcher: FSWatcher | null;
}

/**
 * Reports paths of files that are created or changed in `dirs` (non-recursive).
 *
 * Dirs that exist when the watch starts are baselined synchronously, so only later changes
 * are reported; the caller reads current contents itself after starting the watch. Dirs
 * that appear later, or are added through `setDirs`, report every file they contain —
 * those files may have been written before anyone was looking. Reports can repeat (fs.watch
 * and the poll may both see a change), so `onChange` must be idempotent.
 */
export function watchDirs(
  dirs: string[],
  onChange: (path: string) => void,
  opts: WatchOptions = {},
): DirWatcher {
  const pollMs = opts.pollMs ?? 1000;
  const useFsWatch = opts.fsWatch ?? true;
  const states = new Map<string, DirState>();
  let closed = false;
  let polling = false;

  const startWatcher = (dir: string, state: DirState) => {
    if (!useFsWatch || state.watcher) return;
    try {
      const w = watch(dir, { persistent: false }, (_event, name) => {
        if (!closed && name) onChange(join(dir, name.toString()));
      });
      w.on('error', () => {
        // The dir was removed or became unreadable; the poll restarts the watch if it returns.
        w.close();
        if (state.watcher === w) state.watcher = null;
      });
      state.watcher = w;
    } catch {
      // Not there yet; retried on every poll.
    }
  };

  const add = (dir: string, files: Map<string, string>) => {
    const state: DirState = { files, watcher: null };
    states.set(dir, state);
    startWatcher(dir, state);
    return state;
  };

  const scan = async (dir: string, state: DirState) => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Closed, or this dir was dropped, while we read it: a watcher now would never be closed.
    if (closed || states.get(dir) !== state) return;
    startWatcher(dir, state);
    const next = new Map<string, string>();
    for (const e of entries) {
      if (!e.isFile()) continue;
      const path = join(dir, e.name);
      try {
        const sig = signature(await stat(path));
        next.set(e.name, sig);
        if (!closed && states.get(dir) === state && state.files.get(e.name) !== sig) {
          onChange(path);
        }
      } catch {
        // Deleted between readdir and stat.
      }
    }
    state.files = next;
  };

  const poll = async () => {
    if (polling || closed) return;
    polling = true;
    try {
      for (const [dir, state] of states) await scan(dir, state);
    } finally {
      polling = false;
    }
  };

  for (const dir of new Set(dirs)) add(dir, scanSync(dir));
  const timer = setInterval(() => void poll(), pollMs);
  timer.unref();

  return {
    close() {
      closed = true;
      clearInterval(timer);
      for (const state of states.values()) state.watcher?.close();
      states.clear();
    },
    setDirs(next) {
      if (closed) return;
      const wanted = new Set(next);
      for (const [dir, state] of states) {
        if (wanted.has(dir)) continue;
        state.watcher?.close();
        states.delete(dir);
      }
      for (const dir of wanted) {
        if (states.has(dir)) continue;
        const state = add(dir, new Map());
        void scan(dir, state);
      }
    },
  };
}

function scanSync(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      try {
        files.set(e.name, signature(statSync(join(dir, e.name))));
      } catch {
        // Deleted between readdir and stat.
      }
    }
  } catch {
    // Missing dir: everything that shows up in it later counts as new.
  }
  return files;
}

function signature(st: { ino: number; size: number; mtimeMs: number }): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}`;
}

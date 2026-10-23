/**
 * OpenCode adapter: sessions, sub-agents and live state from OpenCode's SQLite database
 * (`opencode.db` in its data dir), read without ever writing to it.
 */
import { join } from 'node:path';
import type { AgentAdapter } from '../../core/adapter.js';
import { OpenCodeDb } from './db.js';
import {
  classifyPath,
  discoverSessions,
  type LiveIo,
  newLiveCache,
  readLiveStatus,
  sessionFile,
} from './discovery.js';
import { OpenCodeSessionParser } from './parser.js';

export interface OpenCodeAdapterOptions {
  /** OpenCode's data dir: `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`. */
  opencodeDir: string;
  /** Where a database that cannot be read is reported, once until it can be read again. */
  log?: (msg: string) => void;
}

export function createOpenCodeAdapter(
  { opencodeDir, log }: OpenCodeAdapterOptions,
  io?: LiveIo,
): AgentAdapter {
  const db = new OpenCodeDb(join(opencodeDir, 'opencode.db'), log);
  const live = newLiveCache();
  return {
    kind: 'opencode',
    discover: () => discoverSessions(db, live.last),
    listFiles: async () => [sessionFile(db.path)],
    // OpenCode writes the database and its journal here; nothing else in the dir is watched.
    watchDirs: () => [opencodeDir],
    classify: (_source, path) => classifyPath(db.path, path),
    liveStatus: () => readLiveStatus(db, live, io),
    readJson: async (source) => (await db.tree(source.nativeId)) ?? undefined,
    createParser: (source) => new OpenCodeSessionParser(source),
  };
}

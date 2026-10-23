/** Grok Build adapter: the only entry point the rest of glassbox imports. */
import type { AgentAdapter } from '../../core/adapter.js';
import {
  classifyPath,
  discoverSessions,
  type LiveCache,
  listSessionFiles,
  readLiveStatus,
  sessionWatchDirs,
} from './discovery.js';
import { GrokSessionParser } from './parser.js';

export interface GrokAdapterOptions {
  /** The Grok config dir: `$GROK_HOME` or `~/.grok`. */
  grokDir: string;
}

export function createGrokAdapter({ grokDir }: GrokAdapterOptions): AgentAdapter {
  const live: LiveCache = { pidOk: new Map() };
  return {
    kind: 'grok',
    discover: () => discoverSessions(grokDir, live),
    listFiles: listSessionFiles,
    watchDirs: sessionWatchDirs,
    classify: classifyPath,
    liveStatus: () => readLiveStatus(grokDir, live),
    createParser: (source) => new GrokSessionParser(source),
  };
}

/**
 * OpenCode adapter: sessions, sub-agents and live state from OpenCode's SQLite database
 * (`opencode.db` in its data dir), read without ever writing to it.
 */
import { join } from 'node:path';
import { OpenCodeDb } from './db.js';
import { classifyPath, discoverSessions, newLiveCache, readLiveStatus, sessionFile, } from './discovery.js';
import { OpenCodeSessionParser } from './parser.js';
export function createOpenCodeAdapter({ opencodeDir, log }, io) {
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
//# sourceMappingURL=index.js.map
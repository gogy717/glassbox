import { stat } from 'node:fs/promises';
/** `resolveSession` for the run manager, answered from the session list. */
export function sessionResolver(store) {
    return (sessionId) => {
        const s = store.listSessions().find((x) => x.id === sessionId);
        return s ? { nativeId: s.nativeId, cwd: s.cwd, live: s.live } : null;
    };
}
const MAX_DIRECTORIES = 20;
/** Working directories of known sessions that still exist, most recently used first. */
export async function recentDirectories(sessions) {
    const byTime = [...sessions].sort((a, b) => a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
    const out = [];
    const seen = new Set();
    for (const s of byTime) {
        if (out.length >= MAX_DIRECTORIES)
            break;
        if (!s.cwd || seen.has(s.cwd))
            continue;
        seen.add(s.cwd);
        if (await isDirectory(s.cwd))
            out.push(s.cwd);
    }
    return out;
}
export async function isDirectory(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * As soon as a run learns its session id (system/init), have the store look for that
 * session, so a tab navigating to it gets its snapshot without waiting for discovery.
 */
export function linkRunSessions(runs, store) {
    const seen = new Set();
    return runs.onRun((run) => {
        if (!run.sessionId || seen.has(run.sessionId))
            return;
        seen.add(run.sessionId);
        void store.expectSession(run.sessionId);
    });
}
//# sourceMappingURL=run-service.js.map
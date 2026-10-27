/**
 * The storage half of the adapter: find sessions, classify watched paths, read live status.
 * Everything comes from OpenCode's database through `OpenCodeDb`, which only ever reads.
 *
 * Discovery reads the `session` table alone. A child session (`parent_id` set) is a sub-agent
 * of its parent and appears inside the parent's session, never on its own.
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseMessageRow, parseSessionRow, toIso } from './records.js';
/** With an OpenCode process running, an unfinished call this recent is still going. */
const ALIVE_WINDOW_MS = 60 * 60_000;
/** Where processes cannot be listed, an unfinished call must have been written this recently. */
const QUIET_WINDOW_MS = 10 * 60_000;
/**
 * Sessions whose own row changed this recently are looked at. OpenCode updates the row when
 * a call starts, but not while its parts stream, so this is wider than the windows above.
 */
const CANDIDATE_WINDOW_MS = 24 * 60 * 60_000;
/** How long a process listing is reused. */
const PROCESS_TTL_MS = 5000;
/** The one source of every session: its rows in the database, keyed by the database's path. */
export function sessionFile(dbPath) {
    return { path: dbPath, format: 'json', role: 'session', agentId: null, workflowRunId: null };
}
/**
 * The database or its journal changed: re-read the session. `-shm` is not a change (readers
 * write to it too), and nothing else in the data dir is a session's.
 */
export function classifyPath(dbPath, path) {
    return path === dbPath || path === `${dbPath}-wal` ? sessionFile(dbPath) : null;
}
/** The root of `id`'s session tree: the highest ancestor the table still has. */
function rootOf(id, parents) {
    const seen = new Set();
    let current = id;
    for (;;) {
        seen.add(current);
        const parent = parents.get(current) ?? null;
        if (parent === null || !parents.has(parent) || seen.has(parent))
            return current;
        current = parent;
    }
}
export async function discoverSessions(db, live = new Map()) {
    const rows = await db.sessions();
    if (!rows)
        return [];
    const infos = [];
    for (const row of rows) {
        const info = parseSessionRow(row);
        if (info)
            infos.push(info);
    }
    const parents = new Map(infos.map((s) => [s.id, s.parentId]));
    // A sub-agent at work updates its own row, not its parent's.
    const treeUpdated = new Map();
    for (const info of infos) {
        const root = rootOf(info.id, parents);
        treeUpdated.set(root, Math.max(treeUpdated.get(root) ?? 0, info.updatedMs ?? 0));
    }
    return infos
        .filter((info) => rootOf(info.id, parents) === info.id)
        .map((info) => {
        const cwd = info.directory;
        return {
            agent: 'opencode',
            nativeId: info.id,
            location: db.path,
            summary: {
                id: `opencode:${info.id}`,
                agent: 'opencode',
                nativeId: info.id,
                title: info.title,
                cwd,
                project: cwd ? basename(cwd) || cwd : 'opencode',
                startedAt: info.createdAt,
                updatedAt: toIso(treeUpdated.get(info.id)) ?? info.createdAt ?? new Date(0).toISOString(),
                live: live.get(info.id) ?? 'closed',
                version: info.version,
                model: info.model,
                usage: null,
                counts: null,
            },
        };
    });
}
/** Executable names of OpenCode: the binary, and the copy some installers hide as `.opencode`. */
const PROCESS_NAMES = new Set(['opencode', '.opencode']);
/** Whether an OpenCode process is running; null where processes cannot be listed. */
export function opencodeRunning() {
    if (process.platform === 'linux') {
        let pids;
        try {
            pids = readdirSync('/proc');
        }
        catch {
            return Promise.resolve(null);
        }
        for (const pid of pids) {
            if (!/^\d+$/.test(pid))
                continue;
            try {
                if (PROCESS_NAMES.has(readFileSync(`/proc/${pid}/comm`, 'utf8').trim()))
                    return Promise.resolve(true);
            }
            catch {
                // Exited while we looked.
            }
        }
        return Promise.resolve(false);
    }
    if (process.platform === 'win32')
        return Promise.resolve(null);
    // macOS and the BSDs: `ps` names every process's executable.
    return new Promise((resolve) => {
        execFile('ps', ['-axo', 'comm='], { timeout: 2000, maxBuffer: 8 << 20 }, (err, out) => {
            if (err)
                resolve(null);
            else
                resolve(String(out)
                    .split('\n')
                    .some((line) => PROCESS_NAMES.has(basename(line.trim()))));
        });
    });
}
export function newLiveCache() {
    return { processes: null, last: new Map() };
}
/**
 * OpenCode records no running-session registry. A session tree is busy while one of its
 * sessions' newest message is an assistant message without `time.completed` or an error (a
 * model call, or the tools of one, still going), and that message (its row or one of its
 * parts) was written within the last hour while an OpenCode process runs, or within ten
 * minutes where processes cannot be listed. A killed OpenCode leaves such a message behind,
 * which is why recency counts. Idle and waiting (a permission prompt) are not recorded, so
 * the rest is closed.
 */
export async function readLiveStatus(db, cache = newLiveCache(), io = {}) {
    const now = (io.now ?? Date.now)();
    if (!cache.processes || now - cache.processes.at >= PROCESS_TTL_MS)
        cache.processes = { at: now, running: await (io.running ?? opencodeRunning)() };
    const running = cache.processes.running;
    const out = new Map();
    if (running === false) {
        cache.last = out;
        return out;
    }
    const activity = await db.activity(now - CANDIDATE_WINDOW_MS);
    if (!activity)
        return cache.last;
    const since = now - (running ? ALIVE_WINDOW_MS : QUIET_WINDOW_MS);
    const parents = new Map(activity.sessions.map((s) => [s.id, s.parent_id]));
    for (const [sessionId, { row, writtenMs }] of activity.latest) {
        if (writtenMs < since)
            continue;
        const message = parseMessageRow(row);
        if (message.kind !== 'assistant' || message.completedMs !== null || message.error)
            continue;
        out.set(rootOf(sessionId, parents), 'busy');
    }
    cache.last = out;
    return out;
}
//# sourceMappingURL=discovery.js.map
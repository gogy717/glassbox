/**
 * The filesystem half of the oh-my-pi adapter: find sessions, classify their files, read live
 * status and saved tool output. Everything here only reads under omp's dirs; nothing is ever
 * written or locked.
 *
 * Sessions live in `<agent dir>/sessions/<cwd slug>/<ISO>_<id>.jsonl`. A dir of the same name
 * beside each one holds its sub-agents' sessions (`<AgentId>.jsonl`, their own sub-agents below
 * `<AgentId>/`) and the artifacts omp saved for tool output it cut short (`<n>.<tool>.log`).
 * A catalog scan reads the first 64 KB of each session (the title slot and the header) and its
 * last 16 KB (the omp build that wrote last), and only again once the file changed.
 */
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { activityOf, heldLeases, leaseName } from './live.js';
import { parseOmpLine } from './records.js';
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 16 * 1024;
/** A cut-short result's artifact is read up to this size; the rest is left on disk. */
const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export function newCache() {
    return { heads: new Map(), leases: new Map(), subIds: new Map() };
}
async function entries(dir) {
    try {
        return await readdir(dir);
    }
    catch {
        return [];
    }
}
/** Up to `bytes` from the start or the end of a file, whole lines only; null when unreadable. */
async function readRange(path, from, bytes) {
    try {
        const fh = await open(path, 'r');
        try {
            const { size } = await fh.stat();
            const start = from === 'head' ? 0 : Math.max(0, size - bytes);
            const buf = Buffer.alloc(Math.min(bytes, size - start));
            const { bytesRead } = await fh.read(buf, 0, buf.length, start);
            const text = buf.subarray(0, bytesRead).toString('utf8');
            // A cut line at either end is not a record.
            if (from === 'tail' && start > 0)
                return text.slice(text.indexOf('\n') + 1);
            return from === 'head' && bytesRead < size ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
        }
        finally {
            await fh.close();
        }
    }
    catch {
        return null;
    }
}
/** The title slot and header from a file's first lines; the newest omp build from its tail. */
async function readHead(path, key) {
    const head = { key, id: null, title: null, cwd: null, startedAt: null, version: null };
    let headerTitle = null;
    for (const line of ((await readRange(path, 'head', HEAD_BYTES)) ?? '').split('\n')) {
        const rec = parseOmpLine(line);
        if (rec.kind === 'title-slot')
            head.title = rec.title;
        else if (rec.kind === 'header') {
            head.id = rec.id;
            head.cwd = rec.cwd;
            head.startedAt = rec.startedAt;
            headerTitle = rec.title;
        }
        else if (rec.kind === 'entry') {
            head.version = rec.node.version ?? head.version;
            // The header is the first record after the slot; entries mean it was not there.
            break;
        }
    }
    head.title ??= headerTitle;
    for (const line of ((await readRange(path, 'tail', TAIL_BYTES)) ?? '').split('\n')) {
        const rec = parseOmpLine(line);
        if (rec.kind === 'entry' && rec.node.version)
            head.version = rec.node.version;
    }
    return head;
}
/** A session transcript, not a backup (`.bak`) or an advisor's transcript (`__advisor*`). */
function isTranscriptName(name) {
    return name.endsWith('.jsonl') && !name.includes('.bak') && !name.startsWith('__advisor');
}
/** The dir beside a session file: its sub-agents and artifacts. */
export function sessionStem(location) {
    return location.endsWith('.jsonl') ? location.slice(0, -'.jsonl'.length) : location;
}
/** Every session under `<agentDir>/sessions`, with its live state (leases under `ompDir`). */
export async function discoverSessions(agentDir, ompDir, cache, held) {
    const sessionsDir = join(agentDir, 'sessions');
    const byId = new Map();
    const seen = new Set();
    for (const group of await entries(sessionsDir)) {
        const groupPath = join(sessionsDir, group);
        for (const name of await entries(groupPath)) {
            if (!isTranscriptName(name))
                continue;
            const path = join(groupPath, name);
            let info;
            try {
                info = await stat(path);
                if (!info.isFile())
                    continue;
            }
            catch {
                continue;
            }
            seen.add(path);
            const key = `${info.ino}:${info.size}:${info.mtimeMs}`;
            let head = cache.heads.get(path);
            if (head?.key !== key) {
                head = await readHead(path, key);
                cache.heads.set(path, head);
            }
            if (!head.id)
                continue;
            const cwd = head.cwd;
            const source = {
                agent: 'oh-my-pi',
                nativeId: head.id,
                location: path,
                summary: {
                    id: `oh-my-pi:${head.id}`,
                    agent: 'oh-my-pi',
                    nativeId: head.id,
                    title: head.title,
                    cwd,
                    project: cwd ? basename(cwd) || cwd : group,
                    startedAt: head.startedAt,
                    // omp appends each entry as it is made, and rewrites the title slot in place.
                    updatedAt: info.mtime.toISOString(),
                    live: 'closed',
                    version: head.version,
                    model: null,
                    usage: null,
                    counts: null,
                },
            };
            const prev = byId.get(head.id);
            if (!prev || prev.summary.updatedAt < source.summary.updatedAt)
                byId.set(head.id, source);
        }
    }
    for (const path of [...cache.heads.keys()])
        if (!seen.has(path))
            cache.heads.delete(path);
    const sources = [...byId.values()];
    const live = await readLiveStatus(ompDir, sources, cache, held);
    for (const source of sources)
        source.summary.live = live.get(source.nativeId) ?? 'closed';
    return sources;
}
function sourceFile(path, role, agentId) {
    return { path, format: 'jsonl', role, agentId, workflowRunId: null };
}
/**
 * Role of a path inside a session, or null when it is not one of the session's transcripts
 * (artifacts and sub-agent output files are read on demand, or not at all). A sub-agent's id is
 * its path below the session dir: `Scout`, or `Scout/Helper` for one Scout spawned.
 */
export function classifyPath(source, path) {
    if (path === source.location)
        return sourceFile(path, 'main', null);
    const rel = relative(sessionStem(source.location), path);
    if (rel === '' || rel.startsWith('..'))
        return null;
    const parts = rel.split(sep);
    const name = parts.at(-1) ?? '';
    if (!isTranscriptName(name))
        return null;
    parts[parts.length - 1] = name.slice(0, -'.jsonl'.length);
    if (parts.some((p) => p === '' || p === '.' || p === '..'))
        return null;
    return sourceFile(path, 'subagent', parts.join('/'));
}
/**
 * Sub-agent transcripts below `dir`, depth first. As omp does, it descends only into the real
 * dir of a transcript it found (`Scout/` beside `Scout.jsonl`), so a link cannot loop.
 */
async function transcriptsUnder(dir, out) {
    let dirents;
    try {
        dirents = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    const files = new Set(dirents.filter((d) => d.isFile()).map((d) => d.name));
    const dirs = new Set(dirents.filter((d) => d.isDirectory()).map((d) => d.name));
    for (const name of [...files].sort()) {
        if (!isTranscriptName(name))
            continue;
        out.push(join(dir, name));
        const stem = name.slice(0, -'.jsonl'.length);
        if (dirs.has(stem))
            await transcriptsUnder(join(dir, stem), out);
    }
}
/** The session file, then every sub-agent's. */
export async function listSessionFiles(source) {
    const paths = [];
    await transcriptsUnder(sessionStem(source.location), paths);
    const files = [sourceFile(source.location, 'main', null)];
    for (const path of paths) {
        const file = classifyPath(source, path);
        if (file)
            files.push(file);
    }
    return files;
}
/**
 * The session's own dir (the server's watcher is not recursive), the dir beside it, and the dir
 * each known sub-agent keeps its own sub-agents in, whether or not it exists yet.
 */
export function sessionWatchDirs(source, subagents) {
    const stem = sessionStem(source.location);
    const dirs = new Set([dirname(source.location), stem]);
    for (const id of subagents)
        dirs.add(join(stem, ...id.split('/')));
    return [...dirs];
}
/**
 * Live state of the sessions a process has open, keyed by session id. Missing means 'closed'.
 * A session whose own agent is idle is still busy while one of its sub-agents works.
 */
export async function readLiveStatus(ompDir, sources, cache, held) {
    const out = new Map();
    const leases = held === undefined ? await heldLeases() : held;
    if (!leases || leases.size === 0)
        return out;
    const holds = (id) => {
        if (!cache.leases.has(id))
            cache.leases.set(id, leaseName(ompDir, id));
        const name = cache.leases.get(id);
        return name ? leases.has(name) : false;
    };
    for (const source of sources) {
        if (!holds(source.nativeId))
            continue;
        let state = (await activityOf(source.location)) ?? 'busy';
        if (state === 'idle') {
            const subs = [];
            await transcriptsUnder(sessionStem(source.location), subs);
            for (const path of subs) {
                if (!cache.subIds.has(path))
                    cache.subIds.set(path, (await readHead(path, '')).id);
                const id = cache.subIds.get(path);
                if (id && holds(id) && (await activityOf(path)) === 'busy') {
                    state = 'busy';
                    break;
                }
            }
        }
        out.set(source.nativeId, state);
    }
    return out;
}
/** Artifact files are `<id>.<tool>.log`, the tool name reduced to `[A-Za-z0-9_-]`. */
const ARTIFACT_NAME = /^(\d+)\.[A-Za-z0-9_-]+\.log$/;
/**
 * The text of `artifact://<id>`, read synchronously because `toolResult` is. Sub-agents usually
 * share their session's artifact dir and id space; one started from a prepared session or a
 * seance keeps its own beside its transcript (`<session dir>/<agent>/`), so a sub-agent's id is
 * looked up there first. Regular files only (a FIFO cannot stall the server); the first
 * ARTIFACT_MAX_BYTES at most.
 */
export function readArtifact(source, id, agent = null) {
    if (!/^\d+$/.test(id))
        return null;
    const stem = sessionStem(source.location);
    const parts = agent?.split('/') ?? [];
    const own = parts.length > 0 && parts.every((p) => p !== '' && p !== '.' && p !== '..');
    for (const dir of own ? [join(stem, ...parts), stem] : [stem]) {
        const text = readArtifactIn(dir, id);
        if (text !== undefined)
            return text;
    }
    return null;
}
/** The artifact's text; null when it is there but cannot be read, undefined when it is not. */
function readArtifactIn(dir, id) {
    let name;
    try {
        name = readdirSync(dir).find((n) => ARTIFACT_NAME.exec(n)?.[1] === id);
    }
    catch {
        return undefined;
    }
    if (!name)
        return undefined;
    let fd;
    try {
        fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    }
    catch {
        return null;
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile())
            return null;
        const buf = Buffer.alloc(Math.min(st.size, ARTIFACT_MAX_BYTES));
        let got = 0;
        while (got < buf.length) {
            const n = readSync(fd, buf, got, buf.length - got, got);
            if (n === 0)
                break;
            got += n;
        }
        const text = buf.subarray(0, got).toString('utf8');
        if (st.size <= ARTIFACT_MAX_BYTES)
            return text;
        const mb = (n) => (n / 1024 / 1024).toFixed(1);
        return `${text}\n\n[glassbox: the first ${mb(ARTIFACT_MAX_BYTES)} MB of ${mb(st.size)} MB; the rest is in ${join(dir, name)}]`;
    }
    catch {
        return null;
    }
    finally {
        closeSync(fd);
    }
}
//# sourceMappingURL=discovery.js.map
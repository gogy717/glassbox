/**
 * Filesystem half of the Codex adapter. Reads rollout files only — never the SQLite catalog,
 * and never `auth.json`, `config.toml`, or other credential files.
 *
 * Discover keeps one file in memory at a time. Plain jsonl contributes its first line (capped).
 * A `.jsonl.zst` archive goes through Node's built-in zlib zstd, asynchronously so a big
 * archive does not block the event loop. That inflates the whole frame; the body is discarded
 * after `session_meta`. Without zstd in the runtime, archives are skipped and diagnostics list
 * `archived-sessions`.
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync, } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';
import { parseRolloutLine } from './records.js';
/** A rollout touched in this window is `busy`. Codex has no pid registry. */
const LIVE_WINDOW_MS = 30_000;
/**
 * `session_meta` is the first line and can carry `base_instructions`. Cap the plain-file read
 * so a catalog scan does not pull the transcript into memory.
 */
const HEADER_BYTES = 8 * 1024 * 1024;
/** First read for a header; real ones are ~20 KB. Grows ×4 up to HEADER_BYTES. */
const HEAD_CHUNK = 64 * 1024;
export function newLiveClaims() {
    return { byPath: new Map(), owners: new Map() };
}
/**
 * What `classify` knows that a new scan does not: claims made after the scan started, and
 * plain rollouts that vanished before their archive was scanned (compressed in place), so
 * the archive can still be claimed when it appears.
 */
export function carryClaims(claims, prev, next) {
    const out = newLiveClaims();
    const keep = (path, found) => {
        if (next.byPath.has(path) || next.byPath.has(`${path}.zst`))
            return;
        out.byPath.set(path, found);
        out.owners.set(found.file.agentId ?? found.ownerId, found.ownerId);
    };
    for (const [path, found] of claims.byPath)
        keep(path, found);
    for (const [path, found] of prev?.byPath ?? [])
        if (!path.endsWith('.zst'))
            keep(path, found);
    return out;
}
export function resolveDecompress(io) {
    if (io && Object.hasOwn(io, 'decompress'))
        return io.decompress;
    // Runs on the thread pool. Missing on runtimes without zstd.
    return typeof zstdDecompress === 'function' ? promisify(zstdDecompress) : undefined;
}
/** Full rollout text, or null when the file is missing or zstd is unavailable/invalid. */
export async function readRolloutText(path, io) {
    try {
        if (path.endsWith('.zst')) {
            const decompress = resolveDecompress(io);
            if (!decompress)
                return null;
            return (await decompress(await readFile(path))).toString('utf8');
        }
        return await readFile(path, 'utf8');
    }
    catch {
        return null;
    }
}
/** `AgentAdapter.readFile`: an archive's jsonl text. Rejects when it cannot be decoded. */
export async function readEncoded(file, io) {
    if (isSecretName(basename(file.path)))
        throw new Error('not a rollout file');
    const text = await readRolloutText(file.path, io);
    if (text === null)
        throw new Error(`cannot decode ${basename(file.path)}`);
    return text;
}
function isRolloutName(name) {
    return name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'));
}
/** Names this adapter must never read, even if a rollout symlink points at them. */
function isSecretName(name) {
    const base = name.toLowerCase();
    return base === 'auth.json' || base === 'config.toml' || base.endsWith('.sqlite');
}
function uuidsIn(name) {
    return name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
}
function firstLine(text) {
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
}
function headerFromLine(line) {
    const rec = parseRolloutLine(line);
    if (rec.kind !== 'session-meta' || rec.id === '')
        return null;
    return {
        id: rec.id,
        parentThreadId: rec.parentThreadId,
        cwd: rec.cwd,
        startedAt: rec.startedAt,
        version: rec.version,
    };
}
function safeHeader(line) {
    try {
        return headerFromLine(line);
    }
    catch {
        // One broken header hides only its own file, never the whole list.
        return null;
    }
}
/**
 * One file per rollout id. Codex compresses a finished rollout to `.jsonl.zst` before it
 * deletes the plain file, so both can exist for a moment: the plain one wins while it is
 * readable (the server cannot tell that two files hold the same records, and would read them
 * twice). Otherwise a readable file wins, then the newer.
 */
function prefer(a, b) {
    if (a.readable !== b.readable)
        return a.readable ? a : b;
    const az = a.path.endsWith('.zst');
    if (az !== b.path.endsWith('.zst'))
        return az ? b : a;
    return a.mtimeMs >= b.mtimeMs ? a : b;
}
/**
 * Walk `parent_thread_id` to the session that should own this rollout. A missing parent
 * (orphan, or a header we could not read) is its own session.
 */
function rootOf(id, hits) {
    const seen = new Set();
    let current = id;
    while (!seen.has(current)) {
        seen.add(current);
        const parent = hits.get(current)?.parentThreadId;
        if (!parent || !hits.has(parent))
            return current;
        current = parent;
    }
    return id;
}
function sourceFile(hit, role) {
    return {
        path: hit.path,
        format: 'jsonl',
        role,
        agentId: role === 'subagent' ? hit.nativeId : null,
        workflowRunId: null,
        // zstd-compressed jsonl: the server reads it whole through `readEncoded`.
        ...(hit.path.endsWith('.zst') ? { encoded: true } : {}),
    };
}
function summaryFor(hit, title, now, latestMs) {
    const cwd = hit.cwd;
    const base = cwd ? basename(cwd) : '';
    return {
        id: `codex:${hit.nativeId}`,
        agent: 'codex',
        nativeId: hit.nativeId,
        title,
        cwd,
        project: base || cwd || 'codex',
        startedAt: hit.startedAt,
        updatedAt: new Date(latestMs).toISOString(),
        // Codex appends each record as it is produced, so a plain file's mtime is its last record
        // (within 11 ms on local files); an archive's mtime is when it was compressed.
        // Sub-agent rollouts count: the parent is quiet while it waits on them.
        live: now - latestMs < LIVE_WINDOW_MS ? 'busy' : 'closed',
        version: hit.version,
        model: null,
        usage: null,
        counts: null,
    };
}
async function walk(dir, seenDirs, seenFiles, out) {
    let realDir;
    try {
        realDir = await realpath(dir);
        if (!(await stat(realDir)).isDirectory())
            return;
    }
    catch {
        return;
    }
    if (seenDirs.has(realDir))
        return;
    seenDirs.add(realDir);
    let names;
    try {
        names = await readdir(realDir);
    }
    catch {
        return;
    }
    for (const name of names) {
        const path = join(realDir, name);
        let info;
        try {
            info = await stat(path);
        }
        catch {
            continue;
        }
        if (info.isDirectory()) {
            await walk(path, seenDirs, seenFiles, out);
            continue;
        }
        if (!info.isFile() || !isRolloutName(name))
            continue;
        let fileReal;
        try {
            fileReal = await realpath(path);
        }
        catch {
            continue;
        }
        if (seenFiles.has(fileReal) || isSecretName(basename(fileReal)))
            continue;
        seenFiles.add(fileReal);
        out.push(fileReal);
    }
}
async function rolloutFiles(codexDir) {
    const out = [];
    const seenDirs = new Set();
    const seenFiles = new Set();
    await walk(join(codexDir, 'sessions'), seenDirs, seenFiles, out);
    await walk(join(codexDir, 'archived_sessions'), seenDirs, seenFiles, out);
    return out;
}
/** The first line in `buf`; null when more of the file must be read to find it. */
function headOf(buf, eof) {
    const nl = buf.indexOf(0x0a);
    if (nl !== -1)
        return { line: buf.subarray(0, nl).toString('utf8'), bytes: nl + 1 };
    // No newline yet: the whole file (or the cap) is all there is of the first line.
    if (buf.length >= HEADER_BYTES)
        return { line: buf.toString('utf8'), bytes: null, capped: true };
    return eof ? { line: buf.toString('utf8'), bytes: null } : null;
}
async function readPlainHead(path) {
    let fh;
    try {
        fh = await open(path, 'r');
    }
    catch {
        return null;
    }
    try {
        const { size } = await fh.stat();
        for (let want = HEAD_CHUNK;; want *= 4) {
            const buf = Buffer.alloc(Math.min(size, want, HEADER_BYTES));
            const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
            // A short read is the end, even if the file shrank since `stat`.
            const eof = bytesRead < buf.length || bytesRead >= size;
            const head = headOf(buf.subarray(0, bytesRead), eof);
            if (head)
                return head;
        }
    }
    catch {
        return null;
    }
    finally {
        await fh.close();
    }
}
/**
 * `readPlainHead` for `classify`, which the contract makes synchronous. Regular files only. A
 * finished first line goes in `cache`, so a rollout reported on every write is read once.
 */
function readPlainHeadSync(path, cache) {
    const known = cache.get(path);
    if (known?.line != null && known.bytes > 0) {
        try {
            const st = statSync(path);
            if (st.ino === known.ino && st.size >= known.bytes)
                return { line: known.line, bytes: known.bytes };
        }
        catch {
            return null;
        }
    }
    let fd;
    try {
        // Non-blocking, so a FIFO cannot stall the event loop before it is turned down.
        fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    }
    catch {
        return null;
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile())
            return null;
        for (let want = HEAD_CHUNK;; want *= 4) {
            const buf = Buffer.alloc(Math.min(want, HEADER_BYTES));
            const bytesRead = readSync(fd, buf, 0, buf.length, 0);
            const head = headOf(buf.subarray(0, bytesRead), bytesRead < buf.length);
            if (!head)
                continue;
            if (head.bytes !== null) {
                const { ino, size, mtimeMs } = st;
                cache.set(path, { ino, size, mtimeMs, bytes: head.bytes, line: head.line });
            }
            return head;
        }
    }
    catch {
        return null;
    }
    finally {
        closeSync(fd);
    }
}
async function readCompressedHead(path, decompress) {
    try {
        return firstLine((await decompress(await readFile(path))).toString('utf8'));
    }
    catch {
        return null;
    }
}
async function readTitles(codexDir) {
    const titles = new Map();
    let text;
    try {
        text = await readFile(join(codexDir, 'session_index.jsonl'), 'utf8');
    }
    catch {
        return titles;
    }
    for (const line of text.split('\n')) {
        if (line.trim() === '')
            continue;
        try {
            const value = JSON.parse(line);
            if (typeof value !== 'object' || value === null)
                continue;
            const row = value;
            if (typeof row.id !== 'string' || row.id === '')
                continue;
            if (typeof row.thread_name !== 'string' || row.thread_name.trim() === '')
                continue;
            titles.set(row.id, row.thread_name);
        }
        catch {
            // A torn index line is not a title.
        }
    }
    return titles;
}
function placeholder(path, nativeId, mtimeMs) {
    return {
        path,
        nativeId,
        parentThreadId: null,
        cwd: null,
        startedAt: null,
        version: null,
        mtimeMs,
        readable: false,
    };
}
function keep(hits, hit) {
    const prev = hits.get(hit.nativeId);
    hits.set(hit.nativeId, prev ? prefer(prev, hit) : hit);
}
export async function scanCodexDir(codexDir, io, cache = new Map()) {
    const decompress = resolveDecompress(io);
    const [paths, titles, sessionsDir] = await Promise.all([
        rolloutFiles(codexDir),
        readTitles(codexDir),
        realpath(join(codexDir, 'sessions')).catch(() => join(codexDir, 'sessions')),
    ]);
    const hits = new Map();
    let sawSkippedArchive = false;
    let unattributed = false;
    const present = new Set(paths);
    for (const path of [...cache.keys()])
        if (!present.has(path))
            cache.delete(path);
    for (const path of paths) {
        let st;
        try {
            st = await stat(path);
        }
        catch {
            continue;
        }
        const mtimeMs = st.mtimeMs;
        const compressed = path.endsWith('.jsonl.zst');
        const names = uuidsIn(basename(path));
        if (compressed && !decompress) {
            // No runtime zstd: the bytes cannot be read, so the archive is skipped (diagnostics list
            // `archived-sessions`). A single filename id can still be named.
            sawSkippedArchive = true;
            if (names.length === 1)
                keep(hits, placeholder(path, names[0] ?? '', mtimeMs));
            else
                unattributed = true;
            continue;
        }
        const line = await cachedHead(path, st, compressed, decompress, cache);
        if (line === null) {
            if (names.length === 1)
                keep(hits, placeholder(path, names[0] ?? '', mtimeMs));
            else
                unattributed = true;
            continue;
        }
        const parsed = safeHeader(line);
        if (!parsed) {
            if (names.length === 1) {
                keep(hits, { ...placeholder(path, names[0] ?? '', mtimeMs), readable: true });
            }
            else
                unattributed = true;
            continue;
        }
        keep(hits, {
            path,
            nativeId: parsed.id,
            parentThreadId: parsed.parentThreadId,
            cwd: parsed.cwd,
            startedAt: parsed.startedAt,
            version: parsed.version,
            mtimeMs,
            readable: true,
        });
    }
    const now = Date.now();
    const sources = [];
    const files = new Map();
    const byPath = new Map();
    const unreadable = new Set();
    const owners = new Map();
    const latest = new Map();
    for (const hit of hits.values()) {
        const ownerId = rootOf(hit.nativeId, hits);
        owners.set(hit.nativeId, ownerId);
        latest.set(ownerId, Math.max(latest.get(ownerId) ?? 0, hit.mtimeMs));
    }
    for (const hit of hits.values()) {
        if (!hit.readable)
            unreadable.add(hit.nativeId);
        if (owners.get(hit.nativeId) !== hit.nativeId)
            continue;
        sources.push({
            agent: 'codex',
            nativeId: hit.nativeId,
            location: hit.path,
            summary: summaryFor(hit, titles.get(hit.nativeId) ?? null, now, latest.get(hit.nativeId) ?? hit.mtimeMs),
        });
    }
    for (const hit of hits.values()) {
        if (!hit.readable)
            continue;
        const ownerId = owners.get(hit.nativeId) ?? hit.nativeId;
        const file = sourceFile(hit, hit.nativeId === ownerId ? 'rollout' : 'subagent');
        const list = files.get(ownerId);
        if (list)
            list.push(file);
        else
            files.set(ownerId, [file]);
        byPath.set(hit.path, { ownerId, file });
    }
    for (const list of files.values()) {
        list.sort((a, b) => {
            if (a.role === b.role)
                return a.path.localeCompare(b.path);
            return a.role === 'rollout' ? -1 : 1;
        });
    }
    return {
        sources,
        files,
        byPath,
        owners,
        unreadable,
        flagAll: sawSkippedArchive || unattributed,
        sessionsDir,
    };
}
async function cachedHead(path, st, compressed, decompress, cache) {
    const hit = cache.get(path);
    if (hit && hit.ino === st.ino) {
        if (compressed && hit.size === st.size && hit.mtimeMs === st.mtimeMs)
            return hit.line;
        if (!compressed && st.size >= hit.bytes)
            return hit.line;
    }
    if (compressed) {
        const line = await readCompressedHead(path, decompress);
        cache.set(path, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, bytes: 0, line });
        return line;
    }
    const head = await readPlainHead(path);
    if (head === null)
        return null;
    // Only a finished first line is final; an unfinished one is read again next scan.
    if (head.bytes !== null)
        cache.set(path, {
            ino: st.ino,
            size: st.size,
            mtimeMs: st.mtimeMs,
            bytes: head.bytes,
            line: head.line,
        });
    else
        cache.delete(path);
    return head.line;
}
/**
 * The file if it belongs to `source`. A rollout that appeared after the last scan (a new
 * sub-agent) is claimed from its header, read here, so its first lines are not missed.
 * 'later' while that cannot be told: the header is unfinished, or names a parent not seen yet.
 */
export function classifyScanned(scan, source, path, claims = newLiveClaims(), heads = new Map()) {
    if (path.endsWith('.zst')) {
        return isRealPath(path) ? classifyArchive(scan, source, path, claims) : null;
    }
    const found = scan.byPath.get(path) ?? claims.byPath.get(path);
    if (found)
        return found.ownerId === source.nativeId ? found.file : null;
    const name = basename(path);
    if (!name.endsWith('.jsonl') || !isRolloutName(name) || isSecretName(name))
        return null;
    if (!isRealPath(path))
        return null;
    const head = readPlainHeadSync(path, heads);
    if (!head || head.capped)
        return null;
    // Not written yet: the next write reports it again.
    if (head.bytes === null)
        return 'later';
    const parsed = safeHeader(head.line);
    if (!parsed)
        return null;
    let ownerId = parsed.id;
    if (parsed.parentThreadId) {
        const parent = parsed.parentThreadId;
        ownerId = scan.owners.get(parent) ?? claims.owners.get(parent) ?? null;
        // Parent unseen so far (it may be the next file reported).
        if (ownerId === null)
            return 'later';
    }
    const hit = { ...parsed, nativeId: parsed.id, path, mtimeMs: 0, readable: true };
    const file = sourceFile(hit, ownerId === parsed.id ? 'rollout' : 'subagent');
    claims.byPath.set(path, { ownerId, file });
    claims.owners.set(parsed.id, ownerId);
    return ownerId === source.nativeId ? file : null;
}
/**
 * Rollouts are known by their real path. Under another name (a symlinked folder) the same
 * bytes would be read twice, and a planted link could point at anything, credentials included.
 */
function isRealPath(path) {
    try {
        return realpathSync.native(path) === path;
    }
    catch {
        return false;
    }
}
/**
 * An archive is a finished rollout compressed in place. While its plain file is there, that
 * file holds the same records and is the one listed. Once it is gone the archive is claimed,
 * and the server reads the session again from `listFiles`, which lists the archive instead.
 */
function classifyArchive(scan, source, path, claims) {
    const plain = path.slice(0, -'.zst'.length);
    if (existsSync(plain))
        return null;
    const found = scan.byPath.get(path) ??
        claims.byPath.get(path) ??
        scan.byPath.get(plain) ??
        claims.byPath.get(plain);
    if (!found || found.ownerId !== source.nativeId)
        return null;
    return { ...found.file, path, encoded: true };
}
/** Local and UTC dates of `now` as `sessions/YYYY/MM/DD`: where Codex writes new rollouts. */
function todayDirs(sessionsDir, now) {
    const two = (n) => String(n).padStart(2, '0');
    const local = [String(now.getFullYear()), two(now.getMonth() + 1), two(now.getDate())];
    const utc = [String(now.getUTCFullYear()), two(now.getUTCMonth() + 1), two(now.getUTCDate())];
    return [...new Set([join(sessionsDir, ...local), join(sessionsDir, ...utc)])];
}
/**
 * The folders holding this session's plain rollouts, and today's, where a new sub-agent's
 * rollout appears. The server's watcher is not recursive, so a tree root would report nothing.
 * Archives never change and are not watched.
 */
export function watchDirsFor(scan, codexDir, source, now = new Date()) {
    const dirs = new Set();
    for (const file of scan?.files.get(source.nativeId) ?? [])
        if (!file.path.endsWith('.zst'))
            dirs.add(dirname(file.path));
    if (!source.location.endsWith('.zst'))
        dirs.add(dirname(source.location));
    for (const dir of todayDirs(scan?.sessionsDir ?? join(codexDir, 'sessions'), now))
        dirs.add(dir);
    return [...dirs];
}
/**
 * Busy sessions only. Missing ids mean `closed`. Restats the session's plain rollouts (sub-agents
 * included) and does not re-read them.
 */
export async function busySessions(scan) {
    const now = Date.now();
    const out = new Map();
    for (const source of scan.sources) {
        let mtimeMs = Date.parse(source.summary.updatedAt);
        const paths = new Set([source.location]);
        for (const file of scan.files.get(source.nativeId) ?? [])
            paths.add(file.path);
        for (const path of paths) {
            if (path.endsWith('.zst'))
                continue;
            try {
                mtimeMs = Math.max(mtimeMs, (await stat(path)).mtimeMs);
            }
            catch {
                // Keep the mtime captured at scan time.
            }
        }
        if (now - mtimeMs < LIVE_WINDOW_MS)
            out.set(source.nativeId, 'busy');
    }
    return out;
}
//# sourceMappingURL=discovery.js.map
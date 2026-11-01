/**
 * The filesystem half of the adapter: find sessions, classify their files, read live status.
 * Everything here only reads under the Claude config dir; nothing is ever written.
 */
import { readdirSync } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { cleanPrompt, isProbeCwd, isSlashCommand, PROBE_NAME, parseRecord, pickTitle, promptOrigin, turnInput, } from './records.js';
/** Head and tail windows. They grow only when a single line is longer than the window. */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
/** Once this much of the head is read and parsed, stop looking for a first prompt. */
const HEAD_SOFT_BYTES = 1024 * 1024;
/** Hard limit per window, e.g. a first prompt carrying pasted screenshots. */
const WINDOW_CAP_BYTES = 16 * 1024 * 1024;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
export const sessionDir = (source) => source.location.replace(/\.jsonl$/, '');
async function entries(dir) {
    try {
        return await readdir(dir);
    }
    catch {
        return [];
    }
}
async function readLines(fh, start, length) {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8').split('\n');
}
/** Scans the start of the file, growing the window until the first prompt line is complete. */
async function scanHead(fh, size) {
    for (let len = HEAD_BYTES;; len *= 4) {
        const whole = len >= size;
        const lines = await readLines(fh, 0, Math.min(len, size));
        // The last line of a partial window is cut: drop it.
        const s = scan(whole ? lines : lines.slice(0, -1));
        // A slash command may yet turn out local: what came before it is settled, the rest may not be.
        const t = titleInputs(s.inputs.slice(0, s.openAt ?? s.inputs.length));
        const enough = s.firstTs !== null &&
            s.cwd !== null &&
            (t.firstHuman !== null || (t.firstAny !== null && s.openAt === null));
        if (enough ||
            whole ||
            len >= WINDOW_CAP_BYTES ||
            (len >= HEAD_SOFT_BYTES && s.firstTs !== null))
            return s;
    }
}
/** Scans the end of the file, growing the window until it holds a complete timestamped line. */
async function scanTail(fh, size) {
    for (let len = TAIL_BYTES;; len *= 4) {
        const start = Math.max(0, size - len);
        const lines = await readLines(fh, start, size - start);
        // The first line of a partial window is cut: drop it.
        const s = scan(start === 0 ? lines : lines.slice(1));
        if (s.lastTs !== null || start === 0 || len >= WINDOW_CAP_BYTES)
            return s;
    }
}
/**
 * Whether a person's slash command reached the model, decided record by record as the parser
 * attributes requests to turns, so discovery and an opened session agree on the title. A reply
 * keeps the call with the command's turn. A call sent at or after the next prompt was written
 * early for that prompt (see the parser's `claimEarlyRequest`). An unanswered call is dropped as
 * abandoned when the next request starts, unless an error or an interrupt ended it.
 */
const commands = {
    onCall(s, id, ts) {
        if (s.undecided) {
            s.undecided.input.reached = s.undecided.call.failed;
            s.undecided = null;
        }
        if (s.pending && !s.pending.call)
            s.pending.call = { id, ts, failed: false };
    },
    onReply(s, requestRef) {
        if (s.undecided) {
            // Its own late reply keeps it; a reply to anything else is a new request, which drops it.
            const own = requestRef !== null && requestRef === s.undecided.call.id;
            s.undecided.input.reached = own || s.undecided.call.failed;
            s.undecided = null;
            if (own)
                return;
        }
        if (s.pending) {
            s.pending.input.reached = true;
            s.pending = null;
        }
    },
    onFailure(s) {
        const call = s.pending?.call ?? s.undecided?.call;
        if (call)
            call.failed = true;
    },
    /** A new turn starts; returns a call written early for it. */
    onPrompt(s, ts) {
        const p = s.pending;
        s.pending = null;
        if (!p)
            return null;
        if (!p.call) {
            p.input.reached = false;
            return null;
        }
        if (p.call.ts && ts && p.call.ts >= ts) {
            p.input.reached = false;
            return p.call;
        }
        if (p.call.failed)
            p.input.reached = true;
        else
            s.undecided = { input: p.input, call: p.call };
        return null;
    },
    /**
     * The lines end: a call still waiting stays with its command, as no later request drops it.
     * Where they end mid-file, more lines may decide otherwise: `openAt` says from where.
     */
    finish(s) {
        const open = [s.pending?.input, s.undecided?.input].map((i) => (i ? s.inputs.indexOf(i) : -1));
        const first = Math.min(...open.filter((i) => i >= 0));
        s.openAt = Number.isFinite(first) ? first : null;
        if (s.pending)
            s.pending.input.reached = s.pending.call !== null;
        if (s.undecided)
            s.undecided.input.reached = true;
        s.pending = null;
        s.undecided = null;
    },
};
/** The parser's title inputs, read from the prompts so far. */
function titleInputs(inputs) {
    return {
        firstHuman: inputs.find((i) => i.human && i.reached === true)?.title ?? null,
        firstAny: inputs.find((i) => i.reached === true)?.title ?? null,
        command: inputs[0]?.title ?? null,
    };
}
function scan(lines) {
    const s = {
        cwd: null,
        version: null,
        firstTs: null,
        lastTs: null,
        inputs: [],
        pending: null,
        undecided: null,
        openAt: null,
        customTitle: null,
        agentName: null,
        aiTitle: null,
        model: null,
    };
    for (const line of lines) {
        if (!line)
            continue;
        const r = parseRecord(line);
        if (r.kind === 'invalid' || r.kind === 'other')
            continue;
        if ('ts' in r && r.ts) {
            if (s.firstTs === null || r.ts < s.firstTs)
                s.firstTs = r.ts;
            if (s.lastTs === null || r.ts > s.lastTs)
                s.lastTs = r.ts;
        }
        if ('cwd' in r && r.cwd && s.cwd === null)
            s.cwd = r.cwd;
        if ('version' in r && r.version)
            s.version = r.version;
        if (r.kind === 'custom-title' && r.title)
            s.customTitle = r.title;
        if (r.kind === 'ai-title' && r.title)
            s.aiTitle = r.title;
        if (r.kind === 'agent-name' && r.title)
            s.agentName = r.title;
        if (r.kind === 'assistant' && r.model && r.model !== '<synthetic>' && !r.isSidechain)
            s.model = r.model;
        if (r.kind === 'api-request' && r.agentId === null)
            commands.onCall(s, r.id, r.ts);
        if (r.kind === 'assistant' && !r.isSidechain)
            commands.onReply(s, r.requestRef);
        if (r.kind === 'system' && !r.isSidechain && r.subtype === 'api_error')
            commands.onFailure(s);
        if (r.kind !== 'user' || r.isSidechain)
            continue;
        if (r.interrupt)
            commands.onFailure(s);
        const origin = promptOrigin(r, true);
        if (origin === null)
            continue;
        const early = commands.onPrompt(s, r.ts);
        // A turn, so it decides earlier commands as the parser does; never a title.
        if (origin === 'auto-continuation')
            continue;
        const title = cleanPrompt(turnInput(r, origin).prompt);
        if (!title)
            continue;
        const command = origin === 'human' && isSlashCommand(r.text);
        const input = { title, human: origin === 'human', reached: command ? null : true };
        s.inputs.push(input);
        if (command)
            s.pending = { input, call: early };
    }
    commands.finish(s);
    return s;
}
async function realCwd(cwd) {
    try {
        return await realpath(cwd);
    }
    catch {
        return cwd;
    }
}
async function scanFile(path, nativeId, size, mtime) {
    const fh = await open(path, 'r');
    let h;
    let t;
    try {
        if (size <= HEAD_BYTES + TAIL_BYTES) {
            h = scan(await readLines(fh, 0, size));
            t = h;
        }
        else {
            h = await scanHead(fh, size);
            t = await scanTail(fh, size);
        }
    }
    finally {
        await fh.close();
    }
    const cwd = h.cwd ?? t.cwd;
    const probe = [t.customTitle, h.customTitle, t.agentName, h.agentName].includes(PROBE_NAME) ||
        (cwd !== null && isProbeCwd(await realCwd(cwd)));
    return {
        size,
        mtimeMs: mtime.getTime(),
        probe,
        summary: {
            id: `claude-code:${nativeId}`,
            agent: 'claude-code',
            nativeId,
            title: pickTitle({
                customTitle: t.customTitle ?? h.customTitle,
                agentName: t.agentName ?? h.agentName,
                aiTitle: t.aiTitle ?? h.aiTitle,
                ...titleInputs(h.inputs),
            }),
            cwd,
            project: cwd ? basename(cwd) : basename(dirname(path)),
            startedAt: h.firstTs,
            // The file's mtime is when its last line was written; the head's times are older.
            updatedAt: t.lastTs ?? mtime.toISOString(),
            version: t.version ?? h.version,
            model: t.model ?? h.model,
            usage: null,
            counts: null,
        },
    };
}
export async function discoverSessions(claudeDir, registry, cache = new Map()) {
    const projects = join(claudeDir, 'projects');
    const seenDirs = new Set();
    const seenFiles = new Set();
    const byId = new Map();
    for (const name of await entries(projects)) {
        let dir;
        try {
            dir = await realpath(join(projects, name));
            if (!(await stat(dir)).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        // Symlinked project dirs point at the same sessions.
        if (seenDirs.has(dir))
            continue;
        seenDirs.add(dir);
        for (const file of await entries(dir)) {
            if (!SESSION_FILE.test(file))
                continue;
            const nativeId = file.slice(0, -'.jsonl'.length);
            const location = join(dir, file);
            try {
                const st = await stat(location);
                let scanned = cache.get(location);
                if (!scanned || scanned.size !== st.size || scanned.mtimeMs !== st.mtime.getTime()) {
                    scanned = await scanFile(location, nativeId, st.size, st.mtime);
                    cache.set(location, scanned);
                }
                seenFiles.add(location);
                const probe = scanned.probe || registry.probes.has(nativeId);
                const summary = {
                    ...scanned.summary,
                    live: registry.live.get(nativeId) ?? 'closed',
                    ...(probe ? { tags: ['probe'] } : {}),
                };
                const prev = byId.get(nativeId);
                if (!prev || prev.summary.updatedAt < summary.updatedAt)
                    byId.set(nativeId, { agent: 'claude-code', nativeId, location, summary });
            }
            catch {
                // Vanished or unreadable while scanning: it will show up on the next discovery.
            }
        }
    }
    for (const path of cache.keys())
        if (!seenFiles.has(path))
            cache.delete(path);
    return [...byId.values()];
}
const file = (path, role, agentId = null, workflowRunId = null) => ({
    path,
    format: path.endsWith('.jsonl') ? 'jsonl' : 'json',
    role,
    agentId,
    workflowRunId,
});
const AGENT_FILE = /^agent-(.+?)(\.meta\.json|\.jsonl)$/;
/** Role of a path inside a session, or null when it is not one of the session's files. */
export function classifyPath(source, path) {
    if (path === source.location)
        return file(path, 'main');
    const rel = relative(sessionDir(source), path);
    if (rel.startsWith('..'))
        return null;
    const parts = rel.split(sep);
    const name = parts.at(-1) ?? '';
    const agent = AGENT_FILE.exec(name);
    if (parts.length === 2 && parts[0] === 'subagents' && agent) {
        return file(path, agent[2] === '.jsonl' ? 'subagent' : 'subagent-meta', agent[1] ?? null);
    }
    if (parts.length === 4 && parts[0] === 'subagents' && parts[1] === 'workflows') {
        const runId = parts[2] ?? null;
        if (name === 'journal.jsonl')
            return file(path, 'workflow-journal', null, runId);
        if (agent)
            return file(path, agent[2] === '.jsonl' ? 'workflow-agent' : 'workflow-agent-meta', agent[1] ?? null, runId);
    }
    if (parts.length === 2 && parts[0] === 'workflows' && name.endsWith('.json'))
        return file(path, 'workflow-state', null, name.slice(0, -'.json'.length));
    return null;
}
export async function listSessionFiles(source) {
    const dir = sessionDir(source);
    const paths = [source.location];
    const sub = join(dir, 'subagents');
    for (const n of await entries(sub))
        paths.push(join(sub, n));
    const wfs = join(sub, 'workflows');
    for (const run of await entries(wfs))
        for (const n of await entries(join(wfs, run)))
            paths.push(join(wfs, run, n));
    const states = join(dir, 'workflows');
    for (const n of await entries(states))
        paths.push(join(states, n));
    return paths.flatMap((p) => classifyPath(source, p) ?? []);
}
export function sessionWatchDirs(source) {
    const dir = sessionDir(source);
    const wfs = join(dir, 'subagents', 'workflows');
    let runs = [];
    try {
        runs = readdirSync(wfs).map((r) => join(wfs, r));
    }
    catch {
        // No workflow runs yet.
    }
    return [
        dirname(source.location),
        dir,
        join(dir, 'subagents'),
        wfs,
        ...runs,
        join(dir, 'workflows'),
    ];
}
const LIVE = {
    busy: 'busy',
    waiting: 'waiting',
    idle: 'idle',
    shell: 'idle',
};
const RANK = { busy: 4, waiting: 3, idle: 2, unknown: 1, closed: 0 };
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        // EPERM: the process exists but belongs to someone else.
        return err.code === 'EPERM';
    }
}
/** `<claudeDir>/sessions/*.json`: one entry per running Claude Code process. */
export async function readLiveRegistry(claudeDir) {
    const dir = join(claudeDir, 'sessions');
    const out = new Map();
    const probes = new Set();
    for (const name of await entries(dir)) {
        if (!name.endsWith('.json'))
            continue;
        let entry;
        try {
            entry = JSON.parse(await readFile(join(dir, name), 'utf8'));
        }
        catch {
            continue;
        }
        const r = (entry ?? {});
        const { pid, sessionId, status, cwd } = r;
        if (typeof pid !== 'number' || typeof sessionId !== 'string' || !alive(pid))
            continue;
        if (r.name === PROBE_NAME || (typeof cwd === 'string' && isProbeCwd(await realCwd(cwd))))
            probes.add(sessionId);
        const known = typeof status === 'string' && Object.hasOwn(LIVE, status);
        const state = (known ? LIVE[status] : undefined) ?? 'unknown';
        const prev = out.get(sessionId);
        if (!prev || RANK[state] > RANK[prev])
            out.set(sessionId, state);
    }
    return { live: out, probes };
}
//# sourceMappingURL=discovery.js.map
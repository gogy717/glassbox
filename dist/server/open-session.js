import { activityTarget } from '../core/activity.js';
import { isEmptyChanges, mergeChanges } from '../core/changes.js';
import { MAIN_AGENT_ID, } from '../core/model.js';
import { ContextLedger } from '../shared/context-bill.js';
import { SHELL_TOOLS } from '../shared/tool-category.js';
import { detectTrouble } from '../shared/trouble.js';
import { Coalescer } from './coalescer.js';
import { isActive } from './live.js';
import { JsonlTailer, readJsonFile } from './tail/tailer.js';
import { watchDirs } from './tail/watch.js';
/** Files are fed to a fresh parser in this order, so referenced entities exist first. */
const ROLE_ORDER = [
    // Claude Code
    'main',
    // Codex: the session's own rollout before its sub-agents'
    'rollout',
    // Grok: session metadata, then the logs (its parser is order-independent; this is the
    // order the files fill in during a live turn)
    'summary',
    'tool-definitions',
    'events',
    'updates',
    'chat-history',
    'usage',
    // Both
    'subagent-meta',
    'subagent',
    // Claude Code workflows
    'workflow-state',
    'workflow-journal',
    'workflow-agent-meta',
    'workflow-agent',
];
/** A file keeps being replaced while we read it: give up after this many full re-parses. */
const MAX_PARSE_ATTEMPTS = 3;
/**
 * A repeated call as a row may name it, for every client to show: a command's summary, or the
 * tool and what it works on (`activityTarget`), never a command line.
 */
export function troubleLabel(tool) {
    const target = activityTarget(tool.name, tool.input);
    if (target === null)
        return tool.name;
    return SHELL_TOOLS.has(tool.name) ? target : `${tool.name} ${target}`;
}
class TroubleWatch {
    session = null;
    agents = new Map();
    turns = new Map();
    requests = new Map();
    toolCalls = new Map();
    reset(snapshot) {
        for (const map of [this.agents, this.turns, this.requests, this.toolCalls])
            map.clear();
        this.apply(snapshot);
    }
    /** The span of the main agent's latest turn that has ended, or null. */
    lastTurn() {
        let best = null;
        for (const t of this.turns.values()) {
            if (t.agentId !== MAIN_AGENT_ID || !t.endedAt)
                continue;
            const to = Date.parse(t.endedAt);
            const from = Date.parse(t.startedAt);
            if (Number.isNaN(to) || Number.isNaN(from))
                continue;
            if (!best || to > best.to)
                best = { from, to };
        }
        return best;
    }
    apply(p) {
        this.session = p.session;
        for (const a of p.agents)
            this.agents.set(a.id, { id: a.id, parentId: a.parentId, status: a.status });
        for (const t of p.turns)
            this.turns.set(t.id, {
                id: t.id,
                agentId: t.agentId,
                startedAt: t.startedAt,
                endedAt: t.endedAt,
                status: t.status,
            });
        for (const r of p.requests)
            this.requests.set(r.id, {
                id: r.id,
                agentId: r.agentId,
                turnId: r.turnId,
                status: r.status,
                startedAt: r.startedAt,
                ...(r.compactedBefore ? { compactedBefore: true } : {}),
            });
        for (const t of p.toolCalls)
            this.toolCalls.set(t.id, {
                id: t.id,
                agentId: t.agentId,
                requestId: t.requestId,
                name: t.name,
                input: t.input,
                status: t.status,
                startedAt: t.startedAt,
            });
        const removed = 'removed' in p ? p.removed : undefined;
        const maps = {
            agents: this.agents,
            turns: this.turns,
            requests: this.requests,
            toolCalls: this.toolCalls,
        };
        for (const [kind, ids] of Object.entries(removed ?? {}))
            for (const id of ids)
                maps[kind]?.delete(id);
    }
    /** The strongest sign of a running session now; none of one that is not running. */
    strongest(now) {
        const session = this.session;
        if (!session || !isActive(session.live))
            return null;
        const { agents, turns, requests, toolCalls } = this;
        const input = { session, agents, turns, requests, toolCalls };
        return detectTrouble(input, MAIN_AGENT_ID, now, troubleLabel)[0] ?? null;
    }
}
/** An agent's requests in the order they were sent; one without a recorded start comes first. */
const byStart = (a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
/** Lines of a decoded archive fed to the parser between two yields to the event loop. */
const ARCHIVE_CHUNK_LINES = 20_000;
/**
 * One parsed session kept up to date from its files.
 *
 * All file reads and parser ingestion run on one promise chain, so a file's lines reach the
 * parser in order and a rebuild never interleaves with incremental reads.
 */
export class OpenSession {
    adapter;
    source;
    opts;
    parser;
    /** Per agent, the bill of its requests' contexts, fed only what is new; the parser's. */
    ledgers = new Map();
    ledgersOf = null;
    files = new Map();
    watcher = null;
    chain = Promise.resolve();
    dirty = new Set();
    /**
     * Paths `classify` rejected. A rejection is final, so a sibling session's transcript in the
     * same project dir is looked at once, not on every write.
     */
    foreign = new Set();
    drainQueued = false;
    pending = null;
    flusher;
    closed = false;
    live;
    watch = new TroubleWatch();
    /** The strongest sign of trouble as last read, sent with every summary while it runs. */
    trouble = null;
    /** The parser's latest summary, so a sign read again can be sent with it. */
    latest = null;
    constructor(adapter, source, opts) {
        this.adapter = adapter;
        this.source = source;
        this.opts = opts;
        this.live = opts.live;
        this.flusher = new Coalescer(opts.patchMs, () => this.flush());
    }
    get id() {
        return this.source.summary.id;
    }
    /** Full initial parse. Resolves once the parser holds everything currently on disk. */
    load() {
        // Watch first: anything written after this point is reported, so nothing written between
        // listing the files and finishing the read can be missed.
        this.watcher = watchDirs(this.adapter.watchDirs(this.source), (p) => this.onPath(p), {
            pollMs: this.opts.pollMs,
        });
        return this.enqueue(async () => {
            const started = performance.now();
            const { parser, files, stats } = await this.parseFromScratch();
            this.parser = parser;
            this.files = files;
            const snapshot = parser.snapshot();
            this.watch.reset(snapshot);
            this.trouble = this.readTrouble();
            this.opts.onSummary(this.withTrouble(snapshot.session), this.watch.lastTurn());
            const ms = Math.round(performance.now() - started);
            this.opts.log(`opened ${this.id}: ${stats.files} files, ${stats.lines} lines in ${ms} ms`);
        });
    }
    /**
     * One full parse, nothing watched or kept: the session as it is on disk now, for a one-off
     * aggregate (the weekly receipt). The instance is done with afterwards.
     */
    async readOnce() {
        const { parser, files, stats } = await this.parseFromScratch();
        this.closed = true;
        return {
            snapshot: parser.snapshot(),
            files: [...files.values()].map((t) => t.file),
            lines: stats.lines,
        };
    }
    /**
     * What the agent's finished requests carried in their contexts. The ledger is kept between
     * calls and fed the requests that finished since; a request it holds that changed place or
     * went (a rebuild, a request re-issued) starts it again.
     */
    contextBill(agentId) {
        const parser = this.parser;
        if (this.ledgersOf !== parser) {
            this.ledgers = new Map();
            this.ledgersOf = parser;
        }
        const snapshot = parser.snapshot();
        const finished = snapshot.requests
            .filter((r) => r.agentId === agentId && r.status !== 'in-flight')
            .sort(byStart);
        let ledger = this.ledgers.get(agentId);
        if (!ledger || ledger.fed.some((id, i) => finished[i]?.id !== id)) {
            ledger = new ContextLedger(agentId, snapshot.session.cwd);
            this.ledgers.set(agentId, ledger);
        }
        for (const r of finished.slice(ledger.fed.length))
            ledger.add(r, r.hasDetail ? parser.requestDetail(r.id) : null);
        return ledger.bill();
    }
    /** The parser's snapshot, its summary as the session list has it. */
    snapshot() {
        const snapshot = this.parser.snapshot();
        return { ...snapshot, session: this.withTrouble(snapshot.session) };
    }
    /**
     * Reads the signs of trouble again, as time alone moves some (a wait, a prompt running on),
     * and sends the summary when its sign changed. Called on every live poll; patches between
     * two polls carry the sign last read.
     */
    refreshTrouble() {
        if (this.closed || !this.latest)
            return;
        const next = this.readTrouble();
        if (JSON.stringify(next) === JSON.stringify(this.trouble))
            return;
        this.trouble = next;
        this.opts.onSummary(this.withTrouble(this.latest), this.watch.lastTurn());
    }
    readTrouble() {
        try {
            return this.watch.strongest((this.opts.now ?? Date.now)());
        }
        catch (err) {
            // A detector bug must cost this session's sign, not its updates.
            this.opts.log(`session ${this.id}: signs of trouble failed: ${errorText(err)}`);
            return null;
        }
    }
    /** `summary` with its strongest sign while the session runs; none while it does not. */
    withTrouble(summary) {
        this.latest = summary;
        return isActive(summary.live) ? { ...summary, trouble: this.trouble } : summary;
    }
    setLive(live) {
        if (this.closed || live === this.live)
            return;
        this.live = live;
        if (!this.parser)
            return;
        try {
            this.queueChanges(this.parser.setLive(live));
        }
        catch (err) {
            // A parser bug must cost this session's live flag, not the server.
            this.opts.log(`session ${this.id}: setLive failed: ${errorText(err)}`);
        }
    }
    /** Re-ask the adapter which dirs to watch; new workflow run dirs show up this way. */
    refreshWatchDirs() {
        if (this.closed || !this.watcher)
            return;
        this.watcher.setDirs(this.adapter.watchDirs(this.source));
    }
    close() {
        this.closed = true;
        this.watcher?.close();
        this.watcher = null;
        this.flusher.cancel();
        this.pending = null;
        this.dirty.clear();
    }
    enqueue(task) {
        const run = this.chain.then(task);
        this.chain = run.catch((err) => this.opts.log(`session ${this.id}: ${errorText(err)}`));
        return run;
    }
    onPath(path) {
        if (this.closed)
            return;
        this.dirty.add(path);
        if (this.drainQueued)
            return;
        this.drainQueued = true;
        void this.enqueue(async () => {
            this.drainQueued = false;
            await this.drain();
        });
    }
    async drain() {
        while (!this.closed && this.dirty.size > 0) {
            const path = this.dirty.values().next().value;
            this.dirty.delete(path);
            const fresh = !this.files.has(path);
            const tracked = this.track(path);
            if (!tracked)
                continue;
            const result = await this.read(this.parser, tracked, false);
            if (this.closed)
                return;
            if (result.reset) {
                await this.rebuild();
                continue;
            }
            if (result.changes.length === 0)
                continue;
            if (fresh)
                this.opts.onBackfill?.();
            this.queueChanges(mergeChanges(...result.changes));
        }
    }
    /** The tracked entry for `path`, classifying paths seen for the first time. */
    track(path) {
        const known = this.files.get(path);
        if (known)
            return known;
        if (this.foreign.has(path))
            return null;
        const file = this.adapter.classify(this.source, path);
        // Undecided (e.g. a header still being written): the next write reports the path again.
        if (file === 'later')
            return null;
        if (!file) {
            this.foreign.add(path);
            // Possibly a new directory (e.g. a workflow run) that holds files to watch.
            this.refreshWatchDirs();
            return null;
        }
        // A database's journal stands for the source keyed by the database: share its entry.
        const tracked = this.files.get(file.path) ?? newTracked(file);
        this.files.set(file.path, tracked);
        this.files.set(path, tracked);
        return tracked;
    }
    /** A truncated or replaced file: entities parsed from the old contents must go. */
    async rebuild() {
        const started = performance.now();
        const { parser, files } = await this.parseFromScratch();
        if (this.closed)
            return;
        this.parser = parser;
        this.files = files;
        // Changes collected against the old parser are covered by the new snapshot.
        this.pending = null;
        this.flusher.cancel();
        const snapshot = parser.snapshot();
        this.watch.reset(snapshot);
        this.trouble = this.readTrouble();
        const session = this.withTrouble(snapshot.session);
        this.opts.onBackfill?.();
        this.opts.onSummary(session, this.watch.lastTurn());
        this.opts.onReset({ ...snapshot, session });
        const ms = Math.round(performance.now() - started);
        this.opts.log(`rebuilt ${this.id} after a file was truncated or replaced (${ms} ms)`);
    }
    async parseFromScratch() {
        for (let attempt = 1;; attempt++) {
            const parser = this.adapter.createParser(this.source);
            const listed = await this.adapter.listFiles(this.source);
            const files = new Map();
            for (const file of [...listed].sort(byRoleThenPath))
                files.set(file.path, newTracked(file));
            const stats = { files: files.size, lines: 0 };
            let replaced = false;
            for (const tracked of files.values()) {
                const result = await this.read(parser, tracked, true);
                if (this.closed)
                    break;
                // A fresh tailer only resets when the file was replaced while we were reading it.
                if (result.reset) {
                    replaced = true;
                    break;
                }
                stats.lines += result.lines;
            }
            if (replaced && attempt < MAX_PARSE_ATTEMPTS)
                continue;
            try {
                parser.setLive(this.live);
            }
            catch (err) {
                this.opts.log(`session ${this.id}: setLive failed: ${errorText(err)}`);
            }
            return { parser, files, stats };
        }
    }
    /** `fullParse`: reading into a fresh parser (open or rebuild), not following a change. */
    async read(parser, tracked, fullParse) {
        const { file } = tracked;
        if (file.encoded) {
            if (fullParse)
                return this.readArchive(parser, tracked);
            // Archives are write-once, so a report about one we have read is noise. A new one (or
            // one that failed) may be replacing a live file (Codex compresses finished rollouts in
            // place): start over from listFiles, which knows which copy to read.
            return tracked.archive === 'read' ? { reset: false, changes: [], lines: 0 } : { reset: true };
        }
        if (file.format === 'json') {
            const json = await this.readJson(tracked);
            if (json === undefined || json.version === tracked.lastJson)
                return { reset: false, changes: [], lines: 0 };
            tracked.lastJson = json.version;
            return { reset: false, changes: [parser.ingestJson(file, json.value)], lines: 0 };
        }
        const tailer = tracked.tailer;
        const changes = [];
        let lines = 0;
        for (;;) {
            const r = await tailer.read(this.opts.chunkBytes);
            // Gone counts as a reset: its contents may live on under another name, e.g. archived.
            if (r.reset || r.gone)
                return { reset: true };
            if (r.lines.length > 0) {
                changes.push(parser.ingestLines(file, r.lines));
                lines += r.lines.length;
            }
            if (!r.more)
                break;
            // Let HTTP requests for other sessions through between chunks of a large file.
            await new Promise((resolve) => setImmediate(resolve));
            // Closed meanwhile (the server stopping): what is left would be ingested for nobody.
            if (this.closed)
                break;
        }
        return { reset: false, changes, lines };
    }
    /** A json source's current value: from the adapter when it supplies its sources, else from disk. */
    async readJson(tracked) {
        if (!this.adapter.readJson) {
            const json = await readJsonFile(tracked.file.path);
            // The text is the version: re-serializing the value would throw on a deeply nested file.
            return json && { version: json.text, value: json.value };
        }
        try {
            const json = await this.adapter.readJson(this.source, tracked.file);
            tracked.failing = false;
            return json;
        }
        catch (err) {
            if (!tracked.failing)
                this.opts.log(`session ${this.id}: could not read ${tracked.file.path}: ${errorText(err)}`);
            tracked.failing = true;
            return undefined;
        }
    }
    async readArchive(parser, tracked) {
        const { file } = tracked;
        const skip = (why) => {
            tracked.archive = 'failed';
            this.opts.log(`session ${this.id}: skipped ${file.path}: ${why}`);
            return { reset: false, changes: [], lines: 0 };
        };
        if (!this.adapter.readFile)
            return skip('encoded, but the adapter has no readFile');
        let text;
        try {
            text = await this.adapter.readFile(file);
        }
        catch (err) {
            return skip(errorText(err));
        }
        tracked.archive = 'read';
        if (file.format === 'json') {
            try {
                return { reset: false, changes: [parser.ingestJson(file, JSON.parse(text))], lines: 0 };
            }
            catch (err) {
                return skip(`not JSON: ${errorText(err)}`);
            }
        }
        // Same lines a tailer would produce; the last one counts even without a newline.
        const all = text
            .split('\n')
            .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
            .filter((l) => l.trim() !== '');
        const changes = [];
        for (let i = 0; i < all.length; i += ARCHIVE_CHUNK_LINES) {
            if (i > 0)
                await new Promise((resolve) => setImmediate(resolve));
            if (this.closed)
                break;
            changes.push(parser.ingestLines(file, all.slice(i, i + ARCHIVE_CHUNK_LINES)));
        }
        return { reset: false, changes, lines: all.length };
    }
    queueChanges(changes) {
        if (this.closed || isEmptyChanges(changes))
            return;
        this.pending = this.pending ? mergeChanges(this.pending, changes) : changes;
        this.flusher.request();
    }
    flush() {
        const changes = this.pending;
        this.pending = null;
        if (this.closed || !changes)
            return;
        try {
            const patch = this.parser.patch(changes);
            this.watch.apply(patch);
            const session = this.withTrouble(patch.session);
            this.opts.onSummary(session, this.watch.lastTurn());
            this.opts.onPatch({ ...patch, session });
        }
        catch (err) {
            this.opts.log(`session ${this.id}: patch failed: ${errorText(err)}`);
        }
    }
}
function newTracked(file) {
    return {
        file,
        tailer: file.format === 'jsonl' && !file.encoded ? new JsonlTailer(file.path) : null,
        lastJson: null,
        archive: file.encoded ? 'unread' : null,
        failing: false,
    };
}
function byRoleThenPath(a, b) {
    const rank = (f) => {
        const i = ROLE_ORDER.indexOf(f.role);
        return i === -1 ? ROLE_ORDER.length : i;
    };
    return rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=open-session.js.map
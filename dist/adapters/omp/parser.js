/**
 * Pure oh-my-pi session parser. The server reads the session files and feeds lines here.
 *
 * Entries form a tree through `id` / `parentId`. Only the active branch is shown: the path from
 * the root to the leaf omp would resume at, plus the side calls (`model_usage`) hanging off it.
 * Entries on other branches (an edit-and-resend, a `/tree` jump) are left out, and diagnostics
 * list `other-branches` when there are any. A tree that is damaged (a parent that is missing, a
 * loop, a repeated id) is `broken-tree` instead: what it hides is not a branch anyone chose.
 *
 * Each assistant message is one `ModelRequest` with its own usage; each `model_usage` entry is
 * one more, with no blocks. A turn starts at every user message, and at injected input (a
 * background result, a skill prompt) that arrives while the agent is idle. omp writes a message
 * when it ends, never while it streams, so a request in flight is not visible (`in-flight`).
 *
 * Sub-agents (`task`) are sessions of their own in `<session>/<AgentId>.jsonl`, nested by
 * spawner. Their files arrive with role `subagent` and become sub-agents of the `task` call that
 * names them. Their ids are scoped by agent: entry ids are only unique within one file.
 *
 * A new entry can move the leaf and replace the branch, so the views are rebuilt from the
 * entries and change sets are the difference with what clients were last given.
 */
import { basename } from 'node:path';
import { activityField, latestTurn } from '../../core/activity.js';
import { emptyChanges } from '../../core/changes.js';
import { lastReplyField, requestsById } from '../../core/last-reply.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import { sumUsage } from '../../core/usage.js';
import { jsonOf, parseOmpLine, } from './records.js';
const PREVIEW_CHARS = 500;
const VIEW_KINDS = ['agents', 'turns', 'requests', 'toolCalls'];
/** Entity ids of a sub-agent carry its id: entry ids are unique within one file only. */
function scoped(agentId, id) {
    return agentId === MAIN_AGENT_ID ? id : `${agentId}/${id}`;
}
function preview(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return null;
    return trimmed.length > PREVIEW_CHARS ? trimmed.slice(0, PREVIEW_CHARS) : trimmed;
}
function plus(iso, ms) {
    if (iso === null || ms === null)
        return null;
    return new Date(Date.parse(iso) + Math.round(ms)).toISOString();
}
function latest(values) {
    let out = null;
    for (const v of values)
        if (v && (out === null || v > out))
            out = v;
    return out;
}
function qualified(provider, model) {
    if (!model)
        return null;
    return provider ? `${provider}/${model}` : model;
}
/**
 * The leaf omp resumes at: the last entry, unless it was written off the branch and names the
 * leaf that stayed active. A named leaf that is gone falls back to the newest entry that is its
 * own leaf (as omp's `resolveSessionLeafId` does). Null: no entries, or a cleared leaf.
 */
function leafOf(order, byId) {
    const last = order.at(-1);
    if (!last)
        return null;
    const leaf = last.node.activeLeafId !== undefined ? last.node.activeLeafId : last.node.id;
    if (leaf === null || leaf === last.node.id || byId.has(leaf))
        return leaf;
    for (let i = order.length - 1; i >= 0; i--) {
        const entry = order[i];
        if (entry.node.activeLeafId === undefined || entry.node.activeLeafId === entry.node.id)
            return entry.node.id;
    }
    return null;
}
/**
 * The active branch in file order; whether any message is left out; and whether the tree is
 * damaged: the walk to the root met a parent that is not in the file, or went round a loop, or
 * an id was written twice (omp never reuses one).
 */
function activeBranch(file) {
    const order = file.order.filter((e) => file.entries.get(e.node.id) === e);
    let broken = order.length < file.order.length;
    const path = new Set();
    let id = leafOf(order, file.entries);
    while (id !== null) {
        const entry = file.entries.get(id);
        if (!entry || path.has(id)) {
            broken = true;
            break;
        }
        path.add(id);
        id = entry.node.parentId;
    }
    // A side call hangs off the entry that was the leaf when it started.
    const shown = (e) => path.has(e.node.id) ||
        (e.body.kind === 'model-usage' && e.node.parentId !== null && path.has(e.node.parentId));
    const entries = order.filter(shown);
    const hidden = order.some((e) => !shown(e) && (e.body.kind === 'user' || e.body.kind === 'assistant'));
    return { entries, hidden, broken };
}
function userOrigin(agentId, body) {
    const byPerson = body.attribution !== 'agent' && !body.synthetic;
    if (agentId === MAIN_AGENT_ID)
        return byPerson ? 'human' : 'other';
    return body.attribution === 'user' && !body.synthetic ? 'human' : 'agent-prompt';
}
function injectedOrigin(body) {
    if (body.customType === 'async-result')
        return 'task-notification';
    return body.attribution === 'user' ? 'human' : 'other';
}
/** A turn goes on while its last answer asked for tools (or it has none yet). */
function turnOpen(turn) {
    return turn !== null && (turn.lastAnswer === null || turn.lastAnswer.stopReason === 'toolUse');
}
/** Names a `task` call gives the agents it spawns (`name`, `tasks[].name`). */
function taskNames(input) {
    if (typeof input !== 'object' || input === null)
        return [];
    const args = input;
    const names = [];
    if (typeof args.name === 'string')
        names.push(args.name);
    if (Array.isArray(args.tasks))
        for (const item of args.tasks)
            if (typeof item === 'object' && item !== null) {
                const name = item.name;
                if (typeof name === 'string')
                    names.push(name);
            }
    return names;
}
export class OmpSessionParser {
    source;
    live;
    title;
    /** When the current title was set; a slot rewritten in place is newer than its audit entries. */
    titleAt = null;
    cwd;
    project;
    version;
    startedAt;
    updatedAt;
    liveSignal;
    readArtifact;
    files = new Map();
    diag = { unknownRecordTypes: {}, parseErrors: 0 };
    /** What clients were last given, as JSON per entity. */
    emittedViews = {
        agents: new Map(),
        turns: new Map(),
        requests: new Map(),
        toolCalls: new Map(),
    };
    emittedSession = '';
    emittedDiagnostics = '';
    /** Views of the current state; null once the state has moved on. */
    cache = null;
    /** The state moved since the last diff or snapshot (a new parser has never been given out). */
    dirty = true;
    /** Change sets handed out and not read yet. */
    unread = [];
    constructor(source, options = {}) {
        this.source = source;
        this.live = source.summary.live;
        this.title = source.summary.title;
        this.cwd = source.summary.cwd;
        this.project = source.summary.project;
        this.version = source.summary.version;
        this.startedAt = source.summary.startedAt;
        this.updatedAt = source.summary.updatedAt;
        this.liveSignal = options.liveSignal ?? true;
        this.readArtifact = options.readArtifact ?? null;
        this.fileFor(MAIN_AGENT_ID, null);
    }
    ingestLines(file, lines) {
        const agent = this.agentOf(file);
        if (agent === null)
            return emptyChanges();
        const agentId = agent.id;
        const state = this.fileFor(agentId, agent.key);
        for (const line of lines) {
            const rec = parseOmpLine(line);
            if (rec.kind === 'invalid') {
                if (line.trim() !== '')
                    this.diag.parseErrors += 1;
                continue;
            }
            if (rec.kind === 'unknown') {
                this.noteUnknown(rec.type);
                continue;
            }
            if (rec.kind === 'title-slot') {
                if (agentId === MAIN_AGENT_ID)
                    this.setTitle(rec.title, rec.updatedAt);
                continue;
            }
            if (rec.kind === 'header') {
                state.startedAt = rec.startedAt ?? state.startedAt;
                if (agentId === MAIN_AGENT_ID)
                    this.onHeader(rec.cwd, rec.startedAt, rec.title);
                continue;
            }
            const { node, body } = rec;
            if (body.kind === 'unknown')
                this.noteUnknown(body.type);
            const entry = { node, body };
            state.entries.set(node.id, entry);
            state.order.push(entry);
            this.touch(node.timestamp);
            if (agentId !== MAIN_AGENT_ID)
                continue;
            if (node.version)
                this.version = node.version;
            if (body.kind === 'title-change')
                this.setTitle(body.title, node.timestamp);
        }
        return this.changed();
    }
    ingestJson() {
        return emptyChanges();
    }
    setLive(live) {
        if (live === this.live)
            return emptyChanges();
        this.live = live;
        return this.changed();
    }
    snapshot() {
        // Unread change sets must still name what changed before now, for clients following
        // patches rather than this snapshot.
        if (this.unread.length > 0)
            this.settle(null);
        const snap = this.built().snap;
        // A client that receives this snapshot is in step with it.
        if (this.dirty)
            this.remember(snap);
        this.dirty = false;
        return snap;
    }
    patch(changes) {
        // Reading the change set first settles it against the views `built()` returns.
        const removedRequests = new Set(changes.removed?.requests ?? []);
        const snap = this.built().snap;
        const pick = (ids, items, hidden) => {
            const want = new Set(ids);
            return items.filter((item) => want.has(item.id) && !hidden?.has(item.id));
        };
        return {
            session: snap.session,
            agents: pick(changes.agents, snap.agents),
            turns: pick(changes.turns, snap.turns),
            requests: pick(changes.requests, snap.requests, removedRequests),
            toolCalls: pick(changes.toolCalls, snap.toolCalls),
            workflows: [],
            diagnostics: changes.diagnostics ? snap.diagnostics : null,
            ...(changes.removed ? { removed: changes.removed } : {}),
        };
    }
    requestDetail(requestId) {
        return this.built().details.get(requestId) ?? null;
    }
    /** The result as omp recorded it, or the whole output from its artifact when it was cut. */
    toolResult(toolCallId) {
        const found = this.built().results.get(toolCallId);
        if (!found)
            return undefined;
        const { result, agent } = found;
        if (result.artifactId && this.readArtifact) {
            const full = this.readArtifact(result.artifactId, agent);
            if (full !== null)
                return full;
        }
        return result.text;
    }
    // --- ingestion -----------------------------------------------------------------------
    /** The agent a file belongs to and its path key; null for a role this parser does not read. */
    agentOf(file) {
        if (file.role === 'main')
            return { id: MAIN_AGENT_ID, key: null };
        if (file.role !== 'subagent')
            return null;
        const key = file.agentId ?? basename(file.path, '.jsonl');
        // A sub-agent may be called anything, `main` included.
        return { id: key === MAIN_AGENT_ID ? `agent:${key}` : key, key };
    }
    fileFor(agentId, key) {
        const existing = this.files.get(agentId);
        if (existing)
            return existing;
        const file = { id: agentId, key, entries: new Map(), order: [], startedAt: null };
        this.files.set(agentId, file);
        return file;
    }
    onHeader(cwd, startedAt, title) {
        if (cwd) {
            this.cwd = cwd;
            this.project = basename(cwd) || cwd;
        }
        if (startedAt)
            this.startedAt = startedAt;
        // Old sessions carry their title in the header; anything dated wins over it.
        if (title && !this.title)
            this.title = title;
    }
    setTitle(title, at) {
        if (!title)
            return;
        if (this.titleAt !== null && (at === null || at < this.titleAt))
            return;
        this.title = title;
        this.titleAt = at;
    }
    touch(value) {
        if (value && value > this.updatedAt)
            this.updatedAt = value;
    }
    noteUnknown(type) {
        this.diag.unknownRecordTypes[type] = (this.diag.unknownRecordTypes[type] ?? 0) + 1;
    }
    // --- change sets ---------------------------------------------------------------------
    /**
     * The change set for a state change, worked out when it is first read, so a full load whose
     * change sets nobody reads costs no diff per batch. One diff covers every change set still
     * unread: the one being read carries it and the rest are empty.
     */
    changed() {
        this.dirty = true;
        this.cache = null;
        const slot = { result: null };
        this.unread.push(slot);
        return lazyChanges(() => {
            if (!slot.result)
                this.settle(slot);
            return slot.result;
        });
    }
    /** One diff for every unread change set; `reader` (or else the oldest) carries it. */
    settle(reader) {
        const changes = this.dirty ? this.diff() : emptyChanges();
        const owner = reader ?? this.unread[0];
        for (const slot of this.unread)
            slot.result = slot === owner ? changes : emptyChanges();
        this.unread = [];
    }
    /** The current views compared with what clients were last given. */
    diff() {
        const snap = this.built().snap;
        const out = emptyChanges();
        const removed = {};
        for (const kind of VIEW_KINDS) {
            const before = this.emittedViews[kind];
            const now = new Set();
            for (const entity of snap[kind]) {
                now.add(entity.id);
                if (before.get(entity.id) !== jsonOf(entity))
                    out[kind].push(entity.id);
            }
            const gone = [...before.keys()].filter((id) => !now.has(id));
            if (gone.length > 0)
                removed[kind] = gone;
        }
        out.session = jsonOf(snap.session) !== this.emittedSession;
        out.diagnostics = jsonOf(snap.diagnostics) !== this.emittedDiagnostics;
        if (Object.keys(removed).length > 0)
            out.removed = removed;
        this.remember(snap);
        this.dirty = false;
        return out;
    }
    remember(snap) {
        for (const kind of VIEW_KINDS)
            this.emittedViews[kind] = new Map(snap[kind].map((e) => [e.id, jsonOf(e)]));
        this.emittedSession = jsonOf(snap.session);
        this.emittedDiagnostics = jsonOf(snap.diagnostics);
    }
    // --- views ---------------------------------------------------------------------------
    built() {
        this.cache ??= this.build();
        return this.cache;
    }
    build() {
        const walks = [...this.files.values()]
            .sort((a, b) => {
            if (a.id === MAIN_AGENT_ID)
                return -1;
            if (b.id === MAIN_AGENT_ID)
                return 1;
            // By path, so a sub-agent comes right before its own sub-agents.
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
            .map((file) => this.walk(file));
        this.link(walks);
        const results = new Map();
        const details = new Map();
        const turns = [];
        const requests = [];
        const toolCalls = [];
        const agents = [];
        for (const walk of walks) {
            const turnViews = this.turnViews(walk);
            const requestViews = this.requestViews(walk, details);
            const toolViews = this.toolViews(walk, results);
            turns.push(...turnViews);
            requests.push(...requestViews);
            toolCalls.push(...toolViews);
            agents.push(this.agentView(walk, turnViews, requestViews, toolViews));
        }
        const main = walks[0];
        const model = main.requests.findLast((r) => r.purpose === null && r.model)?.model ??
            main.model ??
            this.source.summary.model;
        const session = {
            id: `oh-my-pi:${this.source.nativeId}`,
            agent: 'oh-my-pi',
            nativeId: this.source.nativeId,
            title: this.title,
            cwd: this.cwd,
            project: this.project,
            startedAt: this.startedAt,
            updatedAt: this.updatedAt,
            live: this.live,
            version: this.version,
            model,
            ...activityField({
                live: this.live,
                toolCalls,
                requests,
                lastTurn: latestTurn(turns),
                updatedAt: this.updatedAt,
            }),
            ...lastReplyField({
                live: this.live,
                lastTurn: latestTurn(turns),
                request: requestsById(requests),
            }),
            usage: sumUsage(requests.map((r) => r.usage)),
            counts: {
                turns: turns.length,
                requests: requests.length,
                toolCalls: toolCalls.length,
                agents: agents.length,
            },
        };
        const unavailable = ['request-detail', 'in-flight'];
        if (!this.liveSignal)
            unavailable.push('live-state');
        if (walks.some((w) => w.hidden && !w.broken))
            unavailable.push('other-branches');
        if (walks.some((w) => w.broken))
            unavailable.push('broken-tree');
        const diagnostics = {
            unknownRecordTypes: { ...this.diag.unknownRecordTypes },
            parseErrors: this.diag.parseErrors,
            unavailable,
        };
        return {
            snap: { session, agents, turns, requests, toolCalls, workflows: [], diagnostics },
            results,
            details,
        };
    }
    /** Turns, requests and tool calls on one agent's active branch, in order. */
    walk(file) {
        const { entries, hidden, broken } = activeBranch(file);
        const walk = {
            id: file.id,
            file,
            turns: [],
            requests: [],
            tools: [],
            model: null,
            init: null,
            hidden,
            broken,
            parentId: MAIN_AGENT_ID,
            spawnedBy: null,
            outcome: null,
        };
        let turn = null;
        let pending = null;
        let effort = null;
        let compacted = false;
        const byCallId = new Map();
        const starts = new Map();
        const usedToolIds = new Set();
        const open = (id, origin, prompt, at) => {
            const next = {
                id: scoped(file.id, id),
                origin,
                prompt,
                startedAt: at,
                requests: [],
                lastAnswer: null,
            };
            walk.turns.push(next);
            return next;
        };
        for (const { node, body } of entries) {
            switch (body.kind) {
                case 'model-change':
                    walk.model = body.model ?? walk.model;
                    break;
                case 'thinking-change':
                    effort = body.level;
                    break;
                case 'compaction':
                    compacted = true;
                    break;
                case 'session-init':
                    walk.init = body;
                    break;
                case 'user':
                    turn = open(node.id, userOrigin(file.id, body), body.text, body.at);
                    pending = null;
                    break;
                case 'injected':
                    // Mid-turn it is context for the next call; while idle it starts a turn if a call follows.
                    if (!turnOpen(turn))
                        pending = { id: node.id, body };
                    break;
                case 'assistant': {
                    if (turn === null || (pending && !turnOpen(turn))) {
                        if (pending)
                            turn = open(pending.id, injectedOrigin(pending.body), pending.body.text, pending.body.at);
                        else if (file.id === MAIN_AGENT_ID)
                            turn = open(node.id, 'other', '', body.startedAt);
                        else
                            turn = open(node.id, 'agent-prompt', walk.init?.task ?? '', body.startedAt);
                        pending = null;
                    }
                    const req = this.answer(file.id, node, body, turn, effort, compacted);
                    compacted = false;
                    turn.lastAnswer = req;
                    walk.requests.push(req);
                    const at = req.firstBlockAt ?? req.endedAt ?? req.startedAt ?? this.updatedAt;
                    for (const block of body.blocks) {
                        if (block.kind === 'thinking') {
                            req.blocks.push({ kind: 'thinking', text: block.text, durationMs: null, at });
                            continue;
                        }
                        if (block.kind === 'text') {
                            req.blocks.push({ kind: 'text', text: block.text, at });
                            continue;
                        }
                        let id = scoped(file.id, block.id);
                        // Weak providers repeat call ids; the later call takes the later result.
                        for (let n = 2; usedToolIds.has(id); n++)
                            id = `${scoped(file.id, block.id)}#${n}`;
                        usedToolIds.add(id);
                        const tool = {
                            id,
                            request: req,
                            name: block.name,
                            input: block.input,
                            startedAt: starts.get(block.id) ?? null,
                            result: null,
                            spawned: [],
                        };
                        byCallId.set(block.id, tool);
                        req.tools.push(tool);
                        req.blocks.push({ kind: 'tool-use', toolCallId: id, at });
                        walk.tools.push(tool);
                    }
                    break;
                }
                case 'model-usage':
                    walk.requests.push(this.sideCall(file.id, node, body, turn));
                    break;
                case 'tool-start': {
                    starts.set(body.toolCallId, body.at);
                    const tool = byCallId.get(body.toolCallId);
                    if (tool && !tool.result)
                        tool.startedAt = body.at;
                    break;
                }
                case 'tool-result': {
                    const tool = byCallId.get(body.toolCallId);
                    if (tool)
                        tool.result = body;
                    break;
                }
                default:
                    break;
            }
        }
        // Requests outside any turn are numbered among themselves.
        let loose = 0;
        for (const req of walk.requests)
            if (req.turn === null)
                req.index = ++loose;
        return walk;
    }
    answer(agentId, node, body, turn, effort, compactedBefore) {
        const req = {
            id: scoped(agentId, node.id),
            turn,
            index: turn.requests.length + 1,
            model: qualified(body.provider, body.model),
            provider: body.provider,
            api: body.api,
            effort,
            purpose: null,
            startedAt: body.startedAt,
            firstBlockAt: plus(body.startedAt, body.ttftMs),
            endedAt: body.endedAt ?? node.timestamp,
            stopReason: body.stopReason,
            usage: body.usage,
            blocks: [],
            tools: [],
            error: body.error,
            compactedBefore,
        };
        turn.requests.push(req);
        return req;
    }
    /** A `model_usage` entry: a call outside the transcript, with usage and nothing else. */
    sideCall(agentId, node, body, turn) {
        const req = {
            id: scoped(agentId, node.id),
            turn,
            index: turn ? turn.requests.length + 1 : 0,
            model: qualified(body.provider, body.model),
            provider: body.provider,
            api: body.api,
            effort: null,
            purpose: body.purpose ?? 'side call',
            startedAt: null,
            firstBlockAt: null,
            endedAt: node.timestamp,
            stopReason: body.stopReason,
            usage: body.usage,
            blocks: [],
            tools: [],
            error: body.errorMessage
                ? { message: body.errorMessage, status: null, retryAttempt: null }
                : null,
            compactedBefore: false,
        };
        turn?.requests.push(req);
        return req;
    }
    /**
     * Ties each sub-agent to its parent and to the `task` call that spawned it: the call names it
     * (`name`, or the ids in its result). A call that names no one yet (a running sync `task` with
     * generated names) takes the sub-agents that started after it.
     */
    link(walks) {
        const byId = new Map(walks.map((w) => [w.id, w]));
        for (const walk of walks) {
            if (walk.id === MAIN_AGENT_ID)
                continue;
            const path = walk.id === `agent:${MAIN_AGENT_ID}` ? [MAIN_AGENT_ID] : walk.id.split('/');
            const name = path.at(-1) ?? walk.id;
            let parent;
            for (let n = path.length - 1; n > 0 && !parent; n--)
                parent = byId.get(path.slice(0, n).join('/'));
            parent ??= byId.get(MAIN_AGENT_ID);
            walk.parentId = parent.id;
            const tasks = parent.tools.filter((t) => t.name === 'task');
            let spawner;
            for (const task of tasks) {
                const named = task.result?.spawned.find((s) => s.id === name);
                if (!named && !taskNames(task.input).includes(name))
                    continue;
                spawner = task;
                walk.outcome = named?.outcome ?? null;
                break;
            }
            const started = walk.file.startedAt;
            if (!spawner && started)
                spawner = tasks.findLast((t) => t.result === null && (t.startedAt ?? '') <= started);
            if (!spawner)
                continue;
            walk.spawnedBy = spawner;
            spawner.spawned.push(walk.id);
        }
    }
    busy() {
        return this.live === 'busy' || this.live === 'waiting';
    }
    turnStatus(walk, turn) {
        const last = turn.lastAnswer;
        const going = walk.turns.at(-1) === turn && this.busy();
        if (!last || last.stopReason === 'toolUse')
            return going ? 'running' : 'interrupted';
        if (last.stopReason === 'error')
            return 'error';
        if (last.stopReason === 'aborted')
            return 'interrupted';
        return 'complete';
    }
    turnViews(walk) {
        return walk.turns.map((turn, i) => {
            const status = this.turnStatus(walk, turn);
            const ends = turn.requests.flatMap((r) => [
                r.endedAt,
                ...r.tools.map((t) => t.result?.at ?? null),
            ]);
            return {
                id: turn.id,
                agentId: walk.id,
                index: i + 1,
                origin: turn.origin,
                prompt: turn.prompt.trim(),
                startedAt: turn.startedAt ?? turn.requests[0]?.startedAt ?? this.startedAt ?? this.updatedAt,
                endedAt: status === 'running' ? null : (latest(ends) ?? turn.startedAt),
                status,
                requestIds: turn.requests.map((r) => r.id),
            };
        });
    }
    requestViews(walk, details) {
        const system = walk.init?.systemPrompt ?? null;
        return walk.requests.map((req) => {
            details.set(req.id, this.detailOf(req, walk.init));
            return {
                id: req.id,
                agentId: walk.id,
                turnId: req.turn?.id ?? null,
                index: req.index,
                model: req.model,
                effort: req.effort,
                startedAt: req.startedAt,
                firstBlockAt: req.firstBlockAt,
                endedAt: req.endedAt,
                status: this.requestStatus(req),
                stopReason: req.stopReason,
                usage: req.usage,
                blocks: req.blocks,
                toolCallIds: req.tools.map((t) => t.id),
                hasDetail: system !== null && req.purpose === null,
                error: req.error,
                ...(req.compactedBefore ? { compactedBefore: true } : {}),
            };
        });
    }
    requestStatus(req) {
        if (req.stopReason === 'error')
            return 'error';
        if (req.stopReason === 'aborted')
            return 'interrupted';
        return 'complete';
    }
    detailOf(req, init) {
        const params = {
            provider: req.provider,
            api: req.api,
            model: req.model,
            thinkingLevel: req.effort,
            ...(req.purpose ? { purpose: req.purpose } : {}),
        };
        if (init?.systemPrompt && req.purpose === null) {
            return {
                requestId: req.id,
                completeness: 'partial',
                notes: [
                    'oh-my-pi records a sub-agent’s system prompt and tool names when it starts, not the messages of each call.',
                ],
                params,
                system: init.systemPrompt,
                tools: init.tools,
                messages: null,
            };
        }
        return {
            requestId: req.id,
            completeness: 'unavailable',
            notes: [
                'oh-my-pi does not store the request body; it keeps only a digest of the system prompt.',
            ],
            params,
            system: null,
            tools: null,
            messages: null,
        };
    }
    toolViews(walk, results) {
        const lastAnswer = walk.requests.findLast((r) => r.purpose === null);
        return walk.tools.map((tool) => {
            const result = tool.result;
            if (result)
                results.set(tool.id, { result, agent: walk.file.key });
            const startedAt = tool.startedAt ?? tool.request.endedAt;
            const endedAt = result?.at ?? null;
            let status = 'unknown';
            if (result)
                status = result.isError ? 'error' : 'complete';
            else if (this.busy() && tool.request === lastAnswer)
                status = 'running';
            const spawned = tool.spawned[0];
            return {
                id: tool.id,
                agentId: walk.id,
                requestId: tool.request.id,
                name: tool.name,
                input: tool.input,
                status,
                startedAt,
                endedAt,
                durationMs: startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null,
                resultPreview: result ? preview(result.text) : null,
                hasFullResult: result !== null,
                spawned: spawned ? { kind: 'agent', agentId: spawned } : null,
            };
        });
    }
    agentView(walk, turns, requests, tools) {
        const main = walk.id === MAIN_AGENT_ID;
        const running = turns.some((t) => t.status === 'running') ||
            (!main && turns.length === 0 && this.busy() && walk.init !== null);
        let status;
        if (running)
            status = 'running';
        else if (walk.outcome)
            status = walk.outcome;
        else
            status = turns.at(-1)?.status ?? 'unknown';
        const model = walk.requests.findLast((r) => r.purpose === null && r.model)?.model ?? walk.model;
        return {
            id: walk.id,
            kind: main ? 'main' : 'subagent',
            parentId: main ? null : walk.parentId,
            spawnedByToolCallId: walk.spawnedBy?.id ?? null,
            agentType: main ? null : (walk.init?.agent ?? null),
            label: main ? 'Main' : (walk.id.split('/').at(-1) ?? walk.id),
            workflowRunId: null,
            phase: null,
            model,
            status,
            startedAt: main ? this.startedAt : (walk.file.startedAt ?? turns[0]?.startedAt ?? null),
            endedAt: running ? null : (turns.at(-1)?.endedAt ?? null),
            usage: sumUsage(requests.map((r) => r.usage)),
            counts: { turns: turns.length, requests: requests.length, toolCalls: tools.length },
        };
    }
}
const CHANGE_KEYS = [
    'session',
    'agents',
    'turns',
    'requests',
    'toolCalls',
    'workflows',
    'diagnostics',
    'removed',
];
/** A change set whose fields come from `read`, called when one is first used. */
function lazyChanges(read) {
    const out = {};
    for (const key of CHANGE_KEYS)
        Object.defineProperty(out, key, { enumerable: true, get: () => read()[key] });
    return out;
}
//# sourceMappingURL=parser.js.map
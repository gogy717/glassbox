/**
 * Pure OpenCode session parser. The adapter reads a session and every sub-agent session below
 * it from OpenCode's database and hands them over as one `SessionDocument`, sent again whole
 * whenever any of it changes; this class does no I/O.
 *
 * A user message is a turn. An assistant message is one model call; one holding several
 * `step-start` parts (older builds) is one call per step. A step's `step-finish` part carries
 * that call's tokens, and a message without any carries them itself. Child sessions are
 * sub-agents, joined to the `task` tool call that started them.
 *
 * Every ingest rebuilds the views from the document. Change sets are the difference from what
 * clients were last given, so they carry removals too: OpenCode deletes messages when the user
 * reverts. Live state comes from the adapter's guess from unfinished replies, so every snapshot
 * lists `live-state-unfinished-reply`; OpenCode stores no request bodies, hence `request-detail`.
 */
import { basename } from 'node:path';
import { activityField, latestTurn } from '../../core/activity.js';
import { emptyChanges } from '../../core/changes.js';
import { lastReplyField, requestsById } from '../../core/last-reply.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import { sumUsage } from '../../core/usage.js';
import { asDocument, isMessageRow, isPartRow, parseMessageRow, parsePartRow, parseSessionRow, toIso, } from './records.js';
const PREVIEW_CHARS = 500;
const UNAVAILABLE = ['request-detail', 'live-state-unfinished-reply'];
const VIEW_KINDS = ['agents', 'turns', 'requests', 'toolCalls'];
const isContent = (part) => part.kind === 'text' || part.kind === 'reasoning' || part.kind === 'tool';
function stepsOf(parts) {
    const steps = [];
    let current = null;
    for (const part of parts) {
        if (part.kind === 'step-start') {
            if (current && !current.start && !current.finish && !current.parts.some(isContent)) {
                current.start = part;
            }
            else {
                current = { start: part, parts: [], finish: null };
                steps.push(current);
            }
            continue;
        }
        if (!current) {
            current = { start: null, parts: [], finish: null };
            steps.push(current);
        }
        if (part.kind === 'step-finish')
            current.finish = part;
        else
            current.parts.push(part);
    }
    return steps.length > 0 ? steps : [{ start: null, parts: [], finish: null }];
}
/** The parse of a row, reused while the row's data has not changed. */
function reuse(prev, next, row, parse) {
    const hit = prev.get(row.id);
    const rec = hit && hit.data === row.data ? hit.rec : parse();
    next.set(row.id, { data: row.data, rec });
    return rec;
}
function byTime(items, key) {
    // Stable: equal times keep document order.
    return items
        .map((item, i) => ({ item, i, t: key(item) ?? Number.NEGATIVE_INFINITY }))
        .sort((a, b) => a.t - b.t || a.i - b.i)
        .map((x) => x.item);
}
/** JSON text of `value`; empty when it is nested too deep to serialise. */
function jsonText(value) {
    try {
        return JSON.stringify(value) ?? '';
    }
    catch {
        return '';
    }
}
function emptyState() {
    return {
        sessions: [],
        messages: new Map(),
        parts: new Map(),
        updatedMs: null,
        unknown: {},
        parseErrors: 0,
    };
}
export class OpenCodeSessionParser {
    source;
    live;
    state = emptyState();
    /** Ingested values that were not a session document at all. */
    badDocuments = 0;
    messageCache = new Map();
    partCache = new Map();
    /** Built with the views: full tool results and each request's parameters. */
    results = new Map();
    params = new Map();
    /** What clients were last given, as JSON per entity; change sets are the difference. */
    emitted = {
        agents: new Map(),
        turns: new Map(),
        requests: new Map(),
        toolCalls: new Map(),
    };
    emittedSession = '';
    emittedDiagnostics = '';
    views = null;
    constructor(source) {
        this.source = source;
        this.live = source.summary.live;
    }
    /** Not used: OpenCode sessions arrive as json documents. */
    ingestLines() {
        return emptyChanges();
    }
    ingestJson(_file, value) {
        const doc = asDocument(value);
        if (doc)
            this.state = this.parse(doc);
        else
            this.badDocuments += 1;
        return this.changed();
    }
    setLive(live) {
        if (live === this.live)
            return emptyChanges();
        this.live = live;
        return this.changed();
    }
    snapshot() {
        this.views ??= this.build();
        return this.views;
    }
    patch(changes) {
        const snap = this.snapshot();
        const pick = (ids, items) => {
            const want = new Set(ids);
            return items.filter((item) => want.has(item.id));
        };
        return {
            session: snap.session,
            agents: pick(changes.agents, snap.agents),
            turns: pick(changes.turns, snap.turns),
            requests: pick(changes.requests, snap.requests),
            toolCalls: pick(changes.toolCalls, snap.toolCalls),
            workflows: [],
            diagnostics: changes.diagnostics ? snap.diagnostics : null,
            ...(changes.removed ? { removed: changes.removed } : {}),
        };
    }
    requestDetail(requestId) {
        this.snapshot();
        const params = this.params.get(requestId);
        if (!params)
            return null;
        return {
            requestId,
            completeness: 'unavailable',
            notes: [
                'OpenCode stores the messages, parts and tool calls of a session, not the request body it sent to the model.',
            ],
            params,
            system: null,
            tools: null,
            messages: null,
        };
    }
    toolResult(toolCallId) {
        this.snapshot();
        return this.results.get(toolCallId);
    }
    // --- ingestion -----------------------------------------------------------------------
    parse(doc) {
        const state = emptyState();
        const touch = (ms) => {
            if (typeof ms !== 'number' || !Number.isFinite(ms))
                return;
            if (state.updatedMs === null || ms > state.updatedMs)
                state.updatedMs = ms;
        };
        const note = (type) => {
            state.unknown[type] = (state.unknown[type] ?? 0) + 1;
        };
        for (const row of doc.sessions) {
            const info = parseSessionRow(row);
            if (!info) {
                state.parseErrors += 1;
                continue;
            }
            state.sessions.push(info);
            touch(info.updatedMs);
        }
        const messageCache = new Map();
        for (const row of doc.messages) {
            if (!isMessageRow(row)) {
                state.parseErrors += 1;
                continue;
            }
            touch(row.time_updated);
            const rec = reuse(this.messageCache, messageCache, row, () => parseMessageRow(row));
            if (rec.kind === 'invalid')
                state.parseErrors += 1;
            else if (rec.kind === 'other') {
                if (!rec.known)
                    note(rec.type);
            }
            else {
                const list = state.messages.get(rec.sessionId) ?? [];
                list.push(rec);
                state.messages.set(rec.sessionId, list);
            }
        }
        this.messageCache = messageCache;
        for (const [id, list] of state.messages)
            state.messages.set(id, byTime(list, (m) => m.createdMs));
        const partCache = new Map();
        for (const row of doc.parts) {
            if (!isPartRow(row)) {
                state.parseErrors += 1;
                continue;
            }
            touch(row.time_updated);
            const rec = reuse(this.partCache, partCache, row, () => parsePartRow(row));
            if (rec.kind === 'invalid')
                state.parseErrors += 1;
            else if (rec.kind === 'other' && !rec.known)
                note(rec.type);
            const list = state.parts.get(rec.messageId) ?? [];
            list.push(rec);
            state.parts.set(rec.messageId, list);
        }
        this.partCache = partCache;
        // Part ids ascend in creation order.
        for (const list of state.parts.values())
            list.sort((a, b) => (a.id < b.id ? -1 : 1));
        return state;
    }
    /** Rebuilds the views and works out what changed since clients last got them. */
    changed() {
        const snap = this.build();
        this.views = snap;
        const out = emptyChanges();
        const removed = {};
        for (const kind of VIEW_KINDS) {
            const before = this.emitted[kind];
            const now = new Map(snap[kind].map((e) => [e.id, jsonText(e)]));
            for (const [id, json] of now)
                if (before.get(id) !== json)
                    out[kind].push(id);
            const gone = [...before.keys()].filter((id) => !now.has(id));
            if (gone.length > 0)
                removed[kind] = gone;
            this.emitted[kind] = now;
        }
        const session = jsonText(snap.session);
        const diagnostics = jsonText(snap.diagnostics);
        out.session = session !== this.emittedSession;
        out.diagnostics = diagnostics !== this.emittedDiagnostics;
        this.emittedSession = session;
        this.emittedDiagnostics = diagnostics;
        if (Object.keys(removed).length > 0)
            out.removed = removed;
        return out;
    }
    // --- views ---------------------------------------------------------------------------
    build() {
        const st = this.state;
        const rootId = this.source.nativeId;
        const root = st.sessions.find((s) => s.id === rootId) ?? null;
        const children = st.sessions.filter((s) => s.id !== rootId);
        const childIds = new Set(children.map((s) => s.id));
        const agentOf = (sessionId) => sessionId !== null && childIds.has(sessionId) ? sessionId : MAIN_AGENT_ID;
        const at = (ms) => toIso(ms) ?? root?.createdAt ?? this.source.summary.updatedAt ?? new Date(0).toISOString();
        this.results = new Map();
        this.params = new Map();
        const turns = [];
        const requests = [];
        const tools = [];
        /** Sub-agent session → the first `task` call that ran it. */
        const spawnedBy = new Map();
        for (const session of [rootId, ...children.map((s) => s.id)]) {
            const agentId = agentOf(session);
            const drafts = [];
            const byId = new Map();
            let loose = 0;
            let afterSummary = false;
            for (const msg of st.messages.get(session) ?? []) {
                const parts = st.parts.get(msg.id) ?? [];
                if (msg.kind === 'user') {
                    const draft = {
                        turn: this.turnOf(msg, parts, agentId, drafts.length + 1, at),
                        requests: [],
                        completedMs: null,
                    };
                    drafts.push(draft);
                    byId.set(msg.id, draft);
                    continue;
                }
                const draft = (msg.parentId ? byId.get(msg.parentId) : undefined) ?? drafts.at(-1) ?? null;
                const steps = stepsOf(parts);
                for (let i = 0; i < steps.length; i++) {
                    const index = draft ? draft.requests.length + 1 : ++loose;
                    const req = this.requestOf(msg, steps, i, {
                        agentId,
                        turnId: draft?.turn.id ?? null,
                        index,
                        compacted: i === 0 && afterSummary,
                        at,
                        tools,
                        childIds,
                    });
                    requests.push(req);
                    draft?.requests.push(req);
                }
                if (draft && msg.completedMs !== null)
                    draft.completedMs = msg.completedMs;
                afterSummary = msg.summary;
                for (const part of parts) {
                    const child = part.kind === 'tool' ? part.childSessionId : null;
                    if (part.kind === 'tool' && child && childIds.has(child) && !spawnedBy.has(child))
                        spawnedBy.set(child, { id: part.id, input: part.input });
                }
            }
            drafts.forEach((draft, n) => {
                turns.push(this.finishTurn(draft, n === drafts.length - 1));
            });
        }
        const sortedRequests = byTime(requests, (r) => (r.startedAt ? Date.parse(r.startedAt) : null));
        const sortedTools = byTime(tools, (t) => (t.startedAt ? Date.parse(t.startedAt) : null));
        const sortedTurns = byTime(turns, (t) => Date.parse(t.startedAt));
        const agents = [
            this.agentView(MAIN_AGENT_ID, root, sortedTurns, sortedRequests, sortedTools, null),
            ...byTime(children, (s) => (s.createdAt ? Date.parse(s.createdAt) : null)).map((s) => {
                const call = spawnedBy.get(s.id) ?? null;
                const input = call?.input;
                const description = typeof input === 'object' && input !== null
                    ? input.description
                    : undefined;
                return this.agentView(s.id, s, sortedTurns, sortedRequests, sortedTools, {
                    parentId: agentOf(s.parentId),
                    spawnedBy: call?.id ?? null,
                    label: (typeof description === 'string' && description.trim()) || s.label,
                });
            }),
        ];
        return {
            session: this.sessionView(root, agents, sortedTurns, sortedRequests, sortedTools),
            agents,
            turns: sortedTurns,
            requests: sortedRequests,
            toolCalls: sortedTools,
            workflows: [],
            diagnostics: this.diagnosticsView(),
        };
    }
    turnOf(msg, parts, agentId, index, at) {
        const typed = [];
        const injected = [];
        let compaction = false;
        let subtask = null;
        for (const part of parts) {
            if (part.kind === 'text')
                (part.synthetic ? injected : typed).push(part.text);
            else if (part.kind === 'compaction')
                compaction = true;
            else if (part.kind === 'subtask')
                subtask ??= part.prompt;
        }
        let origin = agentId === MAIN_AGENT_ID ? 'human' : 'agent-prompt';
        if (compaction)
            origin = 'other';
        else if (typed.length === 0 && injected.length > 0) {
            // OpenCode reports a background task's result as an injected `<task …>` message.
            origin = injected.some((t) => t.trimStart().startsWith('<task '))
                ? 'task-notification'
                : 'other';
        }
        return {
            id: msg.id,
            agentId,
            index,
            origin,
            prompt: (typed.length > 0 ? typed : injected).join('\n') || (subtask ?? ''),
            startedAt: at(msg.createdMs),
            endedAt: null,
            status: 'unknown',
            requestIds: [],
        };
    }
    finishTurn(draft, last) {
        const reqs = draft.requests;
        const lastReq = reqs.at(-1);
        let status;
        if (!lastReq) {
            // No answer on record: still coming while the session runs, and never coming after.
            // An earlier turn without one was answered together with a later prompt.
            status = !last ? 'complete' : this.live !== 'closed' ? 'running' : 'interrupted';
        }
        else if (reqs.some((r) => r.status === 'in-flight'))
            status = 'running';
        else if (lastReq.status === 'error')
            status = 'error';
        else if (lastReq.status === 'interrupted')
            status = 'interrupted';
        else
            status = 'complete';
        return {
            ...draft.turn,
            status,
            endedAt: status === 'running' ? null : (toIso(draft.completedMs) ?? lastReq?.endedAt ?? null),
            requestIds: reqs.map((r) => r.id),
        };
    }
    requestOf(msg, steps, i, ctx) {
        const step = steps[i];
        const last = i === steps.length - 1;
        const id = i === 0 ? msg.id : `${msg.id}:${i + 1}`;
        let status;
        if (last && msg.error)
            status = msg.error.aborted ? 'interrupted' : 'error';
        else if (step.finish || !last)
            status = 'complete';
        // Completed without a finish reason: stopped before the model answered.
        else if (msg.completedMs !== null)
            status = msg.finish ? 'complete' : 'interrupted';
        else
            status = this.live === 'closed' ? 'interrupted' : 'in-flight';
        const anyFinish = steps.some((s) => s.finish);
        const usage = status === 'in-flight'
            ? null
            : (step.finish?.tokens ?? (!anyFinish && last ? msg.tokens : null));
        const blocks = [];
        const toolCallIds = [];
        // When the model's output ended: the last text or thinking, or the last tool call it made
        // (the step goes on while the tools run).
        let outputEnd = null;
        const reach = (ms) => {
            if (ms !== null && (outputEnd === null || ms > outputEnd))
                outputEnd = ms;
        };
        for (const part of step.parts) {
            if (part.kind === 'reasoning') {
                // Written empty when thinking starts and whole when it ends.
                if (part.text === '' && part.endMs === null)
                    continue;
                blocks.push({
                    kind: 'thinking',
                    text: part.text || null,
                    durationMs: part.startMs !== null && part.endMs !== null
                        ? Math.max(0, part.endMs - part.startMs)
                        : null,
                    at: ctx.at(part.startMs ?? part.createdMs ?? msg.createdMs),
                });
                reach(part.endMs);
            }
            else if (part.kind === 'text') {
                if (part.text === '')
                    continue;
                blocks.push({
                    kind: 'text',
                    text: part.text,
                    at: ctx.at(part.startMs ?? part.createdMs ?? msg.createdMs),
                });
                reach(part.endMs ?? part.startMs);
            }
            else if (part.kind === 'tool') {
                const started = part.startMs ?? part.createdMs;
                blocks.push({
                    kind: 'tool-use',
                    toolCallId: part.id,
                    at: ctx.at(started ?? msg.createdMs),
                });
                toolCallIds.push(part.id);
                reach(started);
                ctx.tools.push(this.toolOf(part, id, ctx.agentId, status, ctx.childIds));
            }
        }
        const startedMs = i === 0 ? msg.createdMs : (step.start?.createdMs ?? null);
        const endedMs = status === 'in-flight'
            ? null
            : (outputEnd ??
                step.finish?.createdMs ??
                (last ? msg.completedMs : (steps[i + 1]?.start?.createdMs ?? null)));
        this.params.set(id, {
            model: msg.model,
            provider: msg.provider,
            agent: msg.agent,
            variant: msg.variant,
        });
        return {
            id,
            agentId: ctx.agentId,
            turnId: ctx.turnId,
            index: ctx.index,
            model: msg.model,
            effort: msg.variant,
            startedAt: toIso(startedMs),
            firstBlockAt: blocks[0]?.at ?? null,
            endedAt: toIso(endedMs),
            status,
            stopReason: step.finish?.reason ?? (last ? msg.finish : null),
            usage,
            blocks,
            toolCallIds,
            hasDetail: false,
            error: last && msg.error && !msg.error.aborted
                ? { message: msg.error.message, status: msg.error.status, retryAttempt: null }
                : null,
            ...(ctx.compacted ? { compactedBefore: true } : {}),
        };
    }
    toolOf(part, requestId, agentId, requestStatus, childIds) {
        let status;
        if (part.status === 'completed')
            status = 'complete';
        else if (part.status === 'error')
            status = 'error';
        else
            status = requestStatus === 'in-flight' ? 'running' : 'unknown';
        const result = part.output ?? part.error;
        if (result !== null)
            this.results.set(part.id, result);
        return {
            id: part.id,
            agentId,
            requestId,
            name: part.tool,
            input: part.input,
            status,
            startedAt: toIso(part.startMs),
            endedAt: status === 'running' ? null : toIso(part.endMs),
            durationMs: part.startMs !== null && part.endMs !== null
                ? Math.max(0, part.endMs - part.startMs)
                : null,
            resultPreview: result !== null ? result.slice(0, PREVIEW_CHARS) : null,
            hasFullResult: result !== null,
            spawned: part.childSessionId && childIds.has(part.childSessionId)
                ? { kind: 'agent', agentId: part.childSessionId }
                : null,
        };
    }
    agentView(id, info, turns, requests, tools, child) {
        const mineTurns = turns.filter((t) => t.agentId === id);
        const mineRequests = requests.filter((r) => r.agentId === id);
        const running = mineTurns.some((t) => t.status === 'running') ||
            mineRequests.some((r) => r.status === 'in-flight');
        const lastTurn = mineTurns.at(-1);
        let status = 'unknown';
        if (running)
            status = 'running';
        else if (lastTurn)
            status = lastTurn.status;
        return {
            id,
            kind: child ? 'subagent' : 'main',
            parentId: child?.parentId ?? null,
            spawnedByToolCallId: child?.spawnedBy ?? null,
            agentType: child ? (info?.agent ?? null) : null,
            label: child ? (child.label ?? info?.agent ?? 'subagent') : 'Main',
            workflowRunId: null,
            phase: null,
            model: mineRequests.findLast((r) => r.model)?.model ?? info?.model ?? null,
            status,
            startedAt: info?.createdAt ?? mineTurns[0]?.startedAt ?? null,
            endedAt: running ? null : (lastTurn?.endedAt ?? null),
            usage: sumUsage(mineRequests.map((r) => r.usage)),
            counts: {
                turns: mineTurns.length,
                requests: mineRequests.length,
                toolCalls: tools.filter((t) => t.agentId === id).length,
            },
        };
    }
    sessionView(root, agents, turns, requests, tools) {
        const base = this.source.summary;
        const cwd = root?.directory ?? base.cwd;
        return {
            ...base,
            id: `opencode:${this.source.nativeId}`,
            agent: 'opencode',
            nativeId: this.source.nativeId,
            title: root ? root.title : base.title,
            cwd,
            project: cwd ? basename(cwd) || cwd : base.project,
            startedAt: root?.createdAt ?? base.startedAt,
            updatedAt: toIso(this.state.updatedMs) ?? base.updatedAt,
            live: this.live,
            version: root?.version ?? base.version,
            model: requests.findLast((r) => r.agentId === MAIN_AGENT_ID && r.model)?.model ??
                root?.model ??
                base.model,
            ...activityField({
                live: this.live,
                toolCalls: tools,
                requests,
                lastTurn: latestTurn(turns),
                updatedAt: toIso(this.state.updatedMs) ?? base.updatedAt,
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
                toolCalls: tools.length,
                agents: agents.length,
            },
        };
    }
    diagnosticsView() {
        return {
            unknownRecordTypes: { ...this.state.unknown },
            parseErrors: this.state.parseErrors + this.badDocuments,
            unavailable: [...UNAVAILABLE],
        };
    }
}
//# sourceMappingURL=parser.js.map
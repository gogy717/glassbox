/**
 * Pure Claude Code session parser: transcript records in, agent-neutral entities out.
 * No I/O — the server reads files and feeds lines/json here.
 */
import { activityField } from '../../core/activity.js';
import { emptyChanges } from '../../core/changes.js';
import { lastReplyField } from '../../core/last-reply.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import { sumUsage } from '../../core/usage.js';
import { newAgent, newRequest, orderedBlocks, requestStart, } from './agent-state.js';
import { lineChangesOf } from './line-changes.js';
import { cleanPrompt, cleanTurnPrompt, isProbeCwd, isSlashCommand, PROBE_NAME, parseRecord, pickTitle, promptOrigin, turnInput, } from './records.js';
import { RequestDetailStore } from './request-detail.js';
import { addAgent, applyJournal, applyState, isRetried, newRun, parseJournalLine, } from './workflows.js';
/** Blocks without `apiBlockIndex` sort after indexed ones, in arrival order. */
const UNINDEXED = 1_000_000;
class Changes {
    session = false;
    diagnostics = false;
    agents = new Set();
    turns = new Set();
    requests = new Set();
    toolCalls = new Set();
    workflows = new Set();
    removedRequests = new Set();
    toChangeSet() {
        // Within one change set an id is either changed or removed, never both.
        const requests = [...this.requests].filter((id) => !this.removedRequests.has(id));
        return {
            ...emptyChanges(),
            session: this.session,
            diagnostics: this.diagnostics,
            agents: [...this.agents],
            turns: [...this.turns],
            requests,
            toolCalls: [...this.toolCalls],
            workflows: [...this.workflows],
            ...(this.removedRequests.size > 0
                ? { removed: { requests: [...this.removedRequests] } }
                : {}),
        };
    }
}
export class ClaudeSessionParser {
    source;
    live;
    agents = new Map();
    turns = new Map();
    requests = new Map();
    tools = new Map();
    /** `requestId` / `message.id` → request entity id. */
    byRequestId = new Map();
    byMessageId = new Map();
    seenUuids = new Set();
    /** `requestId` → the file that first carried it; fork agents copy their parent's record. */
    requestOwner = new Map();
    /** Requests dropped because Claude Code silently re-issued them. */
    superseded = new Set();
    /** Tool call → the agent or workflow run it launched. */
    spawnOf = new Map();
    runs = new Map();
    detail = new RequestDetailStore();
    /** Tool results whose tool_use has not been seen yet (file order is not strict). */
    orphanResults = new Map();
    diag = { unknownRecordTypes: {}, parseErrors: 0 };
    cwd = null;
    version = null;
    startedAt = null;
    updatedAt = null;
    customTitle = null;
    aiTitle = null;
    agentName = null;
    /** Any `api-request` record seen; without them detail and in-flight are unavailable. */
    sawApiRequest = false;
    /**
     * Newest record time when the session was last seen going idle. Main-agent requests that
     * started by then and never got a reply are over; later ones are a registry lag.
     */
    idleMark = null;
    constructor(source) {
        this.source = source;
        this.live = source.summary.live;
        this.agents.set(MAIN_AGENT_ID, newAgent(MAIN_AGENT_ID, 'main', 'Main'));
    }
    ingestLines(file, lines) {
        const ch = new Changes();
        if (file.role === 'workflow-journal') {
            this.ingestJournal(file, lines, ch);
            return ch.toChangeSet();
        }
        for (const line of lines) {
            const rec = parseRecord(line);
            if (rec.kind === 'invalid') {
                this.diag.parseErrors += 1;
                ch.diagnostics = true;
                continue;
            }
            this.ingestRecord(file, rec, ch);
        }
        return ch.toChangeSet();
    }
    ingestJson(file, value) {
        const ch = new Changes();
        const v = (typeof value === 'object' && value !== null ? value : {});
        if (file.role === 'subagent-meta' && file.agentId) {
            const agent = this.ensureAgent(file.agentId, 'subagent', ch);
            if (typeof v.agentType === 'string')
                agent.agentType = v.agentType;
            if (typeof v.description === 'string' && v.description)
                agent.metaLabel = v.description;
            agent.finished = v.finished === true;
            if (typeof v.toolUseId === 'string')
                this.link(agent, v.toolUseId, ch);
            ch.agents.add(agent.id);
            this.markAgentTail(agent.id, ch);
        }
        else if (file.role === 'workflow-agent-meta' && file.agentId && file.workflowRunId) {
            const agent = this.ensureWorkflowAgent(file.agentId, file.workflowRunId, ch);
            if (typeof v.agentType === 'string')
                agent.agentType = v.agentType;
            if (typeof v.description === 'string' && v.description)
                agent.metaLabel = v.description;
            if (typeof v.workflowPhase === 'string')
                agent.phase = v.workflowPhase;
            ch.agents.add(agent.id);
        }
        else if (file.role === 'workflow-state' && file.workflowRunId) {
            const run = this.ensureRun(file.workflowRunId, ch);
            applyState(run, value);
            this.markRun(run, ch);
        }
        return ch.toChangeSet();
    }
    ingestJournal(file, lines, ch) {
        const run = this.ensureRun(file.workflowRunId ?? 'unknown', ch);
        for (const line of lines) {
            const event = parseJournalLine(line);
            if (event === null) {
                this.diag.parseErrors += 1;
                ch.diagnostics = true;
                continue;
            }
            const agentId = applyJournal(run, event);
            if (agentId)
                this.ensureWorkflowAgent(agentId, run.id, ch);
        }
        this.markRun(run, ch);
    }
    setLive(live) {
        const ch = new Changes();
        if (live === this.live)
            return ch.toChangeSet();
        this.live = live;
        this.idleMark =
            live === 'idle'
                ? this.updatedAt
                    ? Date.parse(this.updatedAt)
                    : Number.POSITIVE_INFINITY
                : null;
        ch.session = true;
        // Everything still open may change status.
        for (const r of this.requests.values())
            if (r.stopReason === null)
                this.markRequest(r, ch);
        for (const t of this.tools.values())
            if (!t.result)
                ch.toolCalls.add(t.id);
        for (const t of this.turns.values())
            ch.turns.add(t.id);
        for (const a of this.agents.keys())
            ch.agents.add(a);
        for (const r of this.runs.keys())
            ch.workflows.add(r);
        return ch.toChangeSet();
    }
    snapshot() {
        return {
            session: this.sessionView(),
            agents: [...this.agents.values()].map((a) => this.agentView(a)),
            turns: [...this.turns.values()].map((t) => this.turnView(t)),
            requests: [...this.requests.values()].map((r) => this.requestView(r)),
            toolCalls: [...this.tools.values()].map((t) => this.toolView(t)),
            workflows: [...this.runs.values()].map((r) => this.workflowView(r)),
            diagnostics: this.diagnosticsView(),
        };
    }
    patch(changes) {
        const removed = new Set(changes.removed?.requests ?? []);
        const pick = (ids, map, view) => ids.flatMap((id) => {
            const s = map.get(id);
            return s && !removed.has(id) ? [view(s)] : [];
        });
        return {
            session: this.sessionView(),
            agents: pick(changes.agents, this.agents, (a) => this.agentView(a)),
            turns: pick(changes.turns, this.turns, (t) => this.turnView(t)),
            requests: pick(changes.requests, this.requests, (r) => this.requestView(r)),
            toolCalls: pick(changes.toolCalls, this.tools, (t) => this.toolView(t)),
            workflows: pick(changes.workflows, this.runs, (r) => this.workflowView(r)),
            diagnostics: changes.diagnostics ? this.diagnosticsView() : null,
            ...(changes.removed ? { removed: changes.removed } : {}),
        };
    }
    requestDetail(requestId) {
        return this.requests.has(requestId) ? this.detail.detail(requestId) : null;
    }
    toolResult(toolCallId) {
        const result = this.tools.get(toolCallId)?.result;
        return result ? { content: result.content, toolUseResult: result.toolUseResult } : undefined;
    }
    // --- ingestion ---------------------------------------------------------------------------
    ingestRecord(file, rec, ch) {
        if ('uuid' in rec && rec.uuid) {
            if (this.seenUuids.has(rec.uuid))
                return;
            this.seenUuids.add(rec.uuid);
        }
        const agent = this.agentFor(file, ch);
        agent.prevTs = agent.lastTs;
        if ('ts' in rec && rec.ts) {
            this.touch(rec.ts, ch);
            if (agent.lastTs === null || rec.ts > agent.lastTs)
                agent.lastTs = rec.ts;
        }
        if ('cwd' in rec && rec.cwd && this.cwd === null)
            this.cwd = rec.cwd;
        if ('version' in rec && rec.version)
            this.version = rec.version;
        switch (rec.kind) {
            case 'user':
                this.detail.addUser(file.path, rec.message);
                this.onUser(agent, rec, ch);
                break;
            case 'api-request': {
                // A copy of another agent's request (fork agents) is not this agent's.
                const owner = this.requests.get(rec.id)?.agentId;
                if (owner !== undefined && owner !== agent.id)
                    break;
                this.detail.addRequest(rec.id, {
                    base: rec.base,
                    keep: rec.keep,
                    tail: rec.tail,
                    params: rec.params,
                    shapeHash: rec.shapeHash,
                });
                this.onApiRequest(agent, rec, ch);
                break;
            }
            case 'api-request-shape':
                this.detail.addShape(rec.shapeHash, rec.system, rec.tools);
                break;
            case 'api-request-blob':
                this.detail.addBlob(rec.hash, rec.message);
                break;
            case 'assistant':
                if (!rec.isApiErrorMessage)
                    this.detail.addAssistant(file.path, rec.requestId ?? rec.messageId, rec.apiBlockIndex, rec.content);
                if (rec.requestId) {
                    const owner = this.requestOwner.get(rec.requestId);
                    if (owner === undefined)
                        this.requestOwner.set(rec.requestId, file.path);
                    else if (owner !== file.path)
                        break;
                }
                if (rec.isApiErrorMessage)
                    this.onApiErrorMessage(agent, rec, ch);
                else
                    this.onAssistant(agent, rec, ch);
                break;
            case 'system':
                this.onSystem(agent, rec, ch);
                break;
            case 'custom-title':
                if (rec.title)
                    this.customTitle = rec.title;
                ch.session = true;
                break;
            case 'ai-title':
                if (rec.title)
                    this.aiTitle = rec.title;
                ch.session = true;
                break;
            case 'agent-name':
                if (rec.title)
                    this.agentName = rec.title;
                ch.session = true;
                break;
            case 'other':
                if (!rec.known) {
                    this.diag.unknownRecordTypes[rec.type] =
                        (this.diag.unknownRecordTypes[rec.type] ?? 0) + 1;
                    ch.diagnostics = true;
                }
                break;
        }
    }
    agentFor(file, ch) {
        if (file.role === 'main' || !file.agentId)
            return this.agents.get(MAIN_AGENT_ID);
        if (file.role === 'workflow-agent' && file.workflowRunId)
            return this.ensureWorkflowAgent(file.agentId, file.workflowRunId, ch);
        return this.ensureAgent(file.agentId, 'subagent', ch);
    }
    ensureRun(id, ch) {
        let run = this.runs.get(id);
        if (!run) {
            run = newRun(id);
            this.runs.set(id, run);
            ch.workflows.add(id);
            ch.session = true;
        }
        return run;
    }
    ensureWorkflowAgent(agentId, runId, ch) {
        const agent = this.ensureAgent(agentId, 'workflow-agent', ch);
        if (agent.workflowRunId !== runId) {
            agent.kind = 'workflow-agent';
            agent.workflowRunId = runId;
            ch.agents.add(agent.id);
        }
        const run = this.ensureRun(runId, ch);
        if (!run.agentIds.includes(agentId)) {
            addAgent(run, agentId);
            ch.workflows.add(runId);
        }
        return agent;
    }
    /** A run changed: so may every agent in it (labels, statuses, parent links). */
    markRun(run, ch) {
        ch.workflows.add(run.id);
        for (const id of run.agentIds) {
            ch.agents.add(id);
            this.markAgentTail(id, ch);
        }
        if (run.toolCallId && this.tools.has(run.toolCallId))
            ch.toolCalls.add(run.toolCallId);
    }
    ensureAgent(id, kind, ch) {
        let agent = this.agents.get(id);
        if (!agent) {
            agent = newAgent(id, kind, id);
            agent.parentId = MAIN_AGENT_ID;
            this.agents.set(id, agent);
            ch.agents.add(id);
            ch.session = true;
        }
        return agent;
    }
    /** Records that `toolUseId` launched `agent`; either side may be seen first. */
    link(agent, toolUseId, ch) {
        if (agent.id === MAIN_AGENT_ID)
            return;
        agent.spawnedByToolCallId = toolUseId;
        this.spawnOf.set(toolUseId, { kind: 'agent', agentId: agent.id });
        ch.agents.add(agent.id);
        if (this.tools.has(toolUseId))
            ch.toolCalls.add(toolUseId);
    }
    /** An explicit end for a sub-agent, from its parent's side. */
    endAgent(agentId, status, at, ch) {
        const agent = this.agents.get(agentId);
        if (!agent || agent.id === MAIN_AGENT_ID)
            return;
        agent.end = { status, at };
        ch.agents.add(agent.id);
        this.markAgentTail(agent.id, ch);
    }
    touch(ts, ch) {
        if (this.startedAt === null || ts < this.startedAt)
            this.startedAt = ts;
        if (this.updatedAt === null || ts > this.updatedAt)
            this.updatedAt = ts;
        ch.session = true;
    }
    onUser(agent, rec, ch) {
        for (const part of rec.toolResults) {
            const result = {
                content: part.content,
                toolUseResult: rec.toolUseResult,
                isError: part.isError,
                at: rec.ts,
            };
            const tool = this.tools.get(part.toolUseId);
            // A fork's transcript starts with a copy of its parent's tool result: not this agent's.
            if (tool && tool.agentId !== agent.id)
                continue;
            this.onSpawnResult(part.toolUseId, rec.toolUseResult, rec.ts, ch);
            const spawned = this.spawnOf.get(part.toolUseId);
            if (part.isError && spawned?.kind === 'agent') {
                const text = typeof part.content === 'string' ? part.content : jsonText(part.content);
                this.endAgent(spawned.agentId, /interrupt/i.test(text ?? '') ? 'interrupted' : 'error', rec.ts, ch);
            }
            if (tool) {
                tool.result = result;
                ch.toolCalls.add(tool.id);
                const req = this.requests.get(tool.requestId);
                if (req)
                    this.markRequest(req, ch);
            }
            else
                this.orphanResults.set(part.toolUseId, { ...result, agentId: agent.id });
        }
        if (rec.interrupt)
            this.onInterrupt(agent, rec.ts ?? this.updatedAt ?? this.source.summary.updatedAt, ch);
        if (rec.isCompactSummary)
            agent.compactPending = true;
        let origin = promptOrigin(rec, agent.kind === 'main');
        // A fork's first record pairs the copied tool result with its directive.
        const forkDirective = origin === null &&
            agent.kind !== 'main' &&
            agent.turnIds.length === 0 &&
            rec.toolResults.length > 0 &&
            !rec.isMeta &&
            rec.text.trim() !== '';
        if (forkDirective)
            origin = 'agent-prompt';
        if (origin === null)
            return;
        if (origin === 'task-notification')
            this.onTaskNotification(rec.text, rec.ts, ch);
        const input = turnInput(rec, origin);
        if (agent.kind !== 'main' && agent.turnIds.length === 0)
            origin = 'agent-prompt';
        const turn = {
            id: `${agent.id}/turn-${agent.turnIds.length + 1}`,
            agentId: agent.id,
            index: agent.turnIds.length + 1,
            origin,
            prompt: cleanTurnPrompt(input.prompt),
            sender: input.sender,
            startedAt: rec.ts ?? this.updatedAt ?? this.source.summary.updatedAt,
            requestIds: [],
            interruptedAt: null,
            endMarkAt: null,
            command: isSlashCommand(rec.text),
        };
        // The turn this one follows is no longer the latest: its status may change.
        const previousTurn = agent.turnIds.at(-1);
        if (previousTurn)
            ch.turns.add(previousTurn);
        this.turns.set(turn.id, turn);
        agent.turnIds.push(turn.id);
        ch.turns.add(turn.id);
        ch.agents.add(agent.id);
        this.claimEarlyRequest(agent, turn, previousTurn, ch);
    }
    /**
     * Claude Code can write a queued prompt (a peer message, say) after the api-request it sent
     * for it. A request with no reply yet that was sent at or after this prompt belongs to it,
     * not to the turn before. One sent earlier was the previous turn's, abandoned for the queued
     * prompt, and stays where it is.
     */
    claimEarlyRequest(agent, turn, previousTurnId, ch) {
        const req = this.requests.get(agent.requestIds.at(-1) ?? '');
        const previous = previousTurnId ? this.turns.get(previousTurnId) : undefined;
        if (!req || !previous || req.turnId !== previous.id || !req.hasApi || req.blocks.size > 0)
            return;
        if (!req.apiTs || req.apiTs < turn.startedAt)
            return;
        previous.requestIds = previous.requestIds.filter((id) => id !== req.id);
        req.turnId = turn.id;
        req.index = turn.requestIds.length + 1;
        turn.requestIds.push(req.id);
        this.markRequest(req, ch);
    }
    /**
     * Agent tool results name the agent they launched (and say when it already finished);
     * Workflow tool results name the run.
     */
    onSpawnResult(toolUseId, result, at, ch) {
        if (typeof result !== 'object' || result === null)
            return;
        const { agentId, status, runId, taskId, workflowName } = result;
        if (typeof runId === 'string') {
            const run = this.ensureRun(runId, ch);
            run.toolCallId = toolUseId;
            if (typeof taskId === 'string')
                run.taskId ??= taskId;
            if (typeof workflowName === 'string')
                run.name ??= workflowName;
            this.spawnOf.set(toolUseId, { kind: 'workflow', runId });
            this.markRun(run, ch);
            return;
        }
        if (typeof agentId !== 'string' || typeof status !== 'string')
            return;
        const agent = this.ensureAgent(agentId, 'subagent', ch);
        if (!agent.spawnedByToolCallId)
            this.link(agent, toolUseId, ch);
        if (status === 'completed')
            this.endAgent(agentId, 'complete', at, ch);
    }
    onTaskNotification(text, at, ch) {
        const tag = (name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1]?.trim() ?? null;
        const toolUseId = tag('tool-use-id');
        const taskId = tag('task-id');
        const spawned = toolUseId ? this.spawnOf.get(toolUseId) : undefined;
        const agentId = spawned?.kind === 'agent'
            ? spawned.agentId
            : taskId && this.agents.has(taskId)
                ? taskId
                : null;
        const status = NOTIFIED_STATUS[tag('status') ?? ''] ?? 'complete';
        if (agentId)
            this.endAgent(agentId, status, at, ch);
        const run = spawned?.kind === 'workflow'
            ? this.runs.get(spawned.runId)
            : [...this.runs.values()].find((r) => taskId !== null && r.taskId === taskId);
        if (run && !run.notified) {
            run.notified = { status, at };
            this.markRun(run, ch);
        }
    }
    onInterrupt(agent, at, ch) {
        const req = this.requests.get(agent.requestIds.at(-1) ?? '');
        if (req && req.stopReason === null && !req.interruptedAt) {
            req.interruptedAt = at;
            this.markRequest(req, ch);
        }
        const turn = this.turns.get(agent.turnIds.at(-1) ?? '');
        if (turn) {
            turn.interruptedAt = at;
            ch.turns.add(turn.id);
            ch.agents.add(agent.id);
        }
    }
    onSystem(agent, rec, ch) {
        if (rec.subtype === 'compact_boundary')
            agent.compactPending = true;
        else if (rec.subtype === 'turn_duration') {
            const turn = this.turns.get(agent.turnIds.at(-1) ?? '');
            if (turn && rec.ts) {
                turn.endMarkAt = rec.ts;
                ch.turns.add(turn.id);
                ch.agents.add(agent.id);
            }
        }
        else if (rec.subtype === 'api_error' && rec.error) {
            const req = this.unanswered(agent);
            if (req) {
                req.error = rec.error;
                this.markRequest(req, ch);
            }
        }
    }
    /** The agent's latest request when nothing of its response has arrived yet. */
    unanswered(agent) {
        const req = this.requests.get(agent.requestIds.at(-1) ?? '');
        return req && req.stopReason === null && req.blocks.size === 0 ? req : undefined;
    }
    /** Claude Code's synthetic "API Error" message: the request failed for good. */
    onApiErrorMessage(agent, rec, ch) {
        const known = rec.requestId
            ? this.requests.get(this.byRequestId.get(rec.requestId) ?? '')
            : undefined;
        const req = known ??
            this.unanswered(agent) ??
            this.createRequest(agent, rec.messageId ?? rec.uuid ?? `request-${this.requests.size + 1}`, ch);
        const text = rec.blocks.find((b) => b.type === 'text');
        req.error = {
            message: text?.type === 'text' && text.text ? text.text : 'API error',
            status: rec.apiErrorStatus,
            retryAttempt: req.error?.retryAttempt ?? null,
        };
        this.markRequest(req, ch);
    }
    onApiRequest(agent, rec, ch) {
        if (!this.sawApiRequest) {
            this.sawApiRequest = true;
            ch.diagnostics = true;
        }
        const req = this.requests.get(rec.id) ?? this.createRequest(agent, rec.id, ch);
        req.hasApi = true;
        req.apiTs = rec.ts;
        req.apiModel = rec.model;
        req.apiEffort = rec.effort;
        this.markRequest(req, ch);
    }
    onAssistant(agent, rec, ch) {
        const req = this.resolveRequest(agent, rec, ch);
        req.error = null;
        if (rec.model && rec.model !== '<synthetic>')
            req.model = rec.model;
        if (rec.effort)
            req.effort = rec.effort;
        if (rec.stopReason !== null)
            req.stopReason = rec.stopReason;
        if (rec.usage && rec.outputTokens > req.bestOutput) {
            req.usage = rec.usage;
            req.bestOutput = rec.outputTokens;
        }
        const at = rec.ts ?? this.updatedAt ?? this.source.summary.updatedAt;
        const base = rec.apiBlockIndex ?? UNINDEXED + req.arrivals;
        req.arrivals += 1;
        rec.blocks.forEach((b, j) => {
            const key = base * 100 + j;
            let block;
            if (b.type === 'thinking')
                block = { kind: 'thinking', text: b.text || null, durationMs: rec.thinkingDurationMs, at };
            else if (b.type === 'text')
                block = { kind: 'text', text: b.text, at };
            else if (b.type === 'tool_use') {
                this.ensureTool(agent, req, b.id, b.name, b.input, rec.ts, ch);
                block = { kind: 'tool-use', toolCallId: b.id, at };
            }
            else
                return;
            req.blocks.set(key, {
                block,
                thinkingMs: b.type === 'thinking' ? rec.thinkingDurationMs : null,
            });
        });
        this.markRequest(req, ch);
    }
    /** Finds the entity an assistant record belongs to, creating it on first sight. */
    resolveRequest(agent, rec, ch) {
        let id;
        if (rec.requestRef && this.requests.has(rec.requestRef))
            id = rec.requestRef;
        if (!id && rec.requestId)
            id = this.byRequestId.get(rec.requestId);
        if (!id && rec.messageId)
            id = this.byMessageId.get(rec.messageId);
        const req = (id && this.requests.get(id)) ||
            this.createRequest(agent, rec.requestRef ??
                rec.requestId ??
                rec.messageId ??
                rec.uuid ??
                `request-${this.requests.size + 1}`, ch);
        if (rec.requestId)
            this.byRequestId.set(rec.requestId, req.id);
        if (rec.messageId)
            this.byMessageId.set(rec.messageId, req.id);
        return req;
    }
    createRequest(agent, id, ch) {
        const previous = this.requests.get(agent.requestIds.at(-1) ?? '');
        if (previous && !this.superseded.delete(id) && silentlyAbandoned(previous))
            this.dropRequest(agent, previous, ch);
        const turnId = agent.turnIds.at(-1) ?? null;
        const turn = turnId ? this.turns.get(turnId) : undefined;
        const index = turn
            ? turn.requestIds.length + 1
            : agent.requestIds.filter((r) => this.requests.get(r)?.turnId === null).length + 1;
        const req = newRequest(id, agent.id, turnId, index);
        // Without an api-request, the record before the request (its prompt or tool result) is the
        // best estimate of when it was sent.
        req.triggerTs = agent.prevTs;
        req.compactedBefore = agent.compactPending;
        agent.compactPending = false;
        if (this.requests.size === 0)
            ch.diagnostics = true;
        const last = this.requests.get(agent.requestIds.at(-1) ?? '');
        if (last)
            this.markRequestAndTools(last, ch);
        this.requests.set(id, req);
        agent.requestIds.push(id);
        if (turn) {
            turn.requestIds.push(id);
            // A request after an interrupt marker means the turn carried on.
            turn.interruptedAt = null;
            ch.turns.add(turn.id);
        }
        return req;
    }
    /**
     * Claude Code abandons a request that has no reply yet when a queued message arrives, and
     * re-sends it with the message. The abandoned one never ran: drop it instead of showing it
     * as interrupted.
     */
    dropRequest(agent, req, ch) {
        this.requests.delete(req.id);
        this.superseded.add(req.id);
        agent.requestIds = agent.requestIds.filter((id) => id !== req.id);
        const turn = req.turnId ? this.turns.get(req.turnId) : undefined;
        if (turn) {
            turn.requestIds = turn.requestIds.filter((id) => id !== req.id);
            ch.turns.add(turn.id);
        }
        this.diag.unknownRecordTypes[SUPERSEDED] = (this.diag.unknownRecordTypes[SUPERSEDED] ?? 0) + 1;
        ch.removedRequests.add(req.id);
        ch.requests.delete(req.id);
        ch.agents.add(agent.id);
        ch.diagnostics = true;
        ch.session = true;
    }
    markRequest(req, ch) {
        ch.requests.add(req.id);
        ch.agents.add(req.agentId);
        if (req.turnId)
            ch.turns.add(req.turnId);
        ch.session = true;
    }
    ensureTool(agent, req, id, name, input, ts, ch) {
        if (!this.tools.has(id)) {
            this.tools.set(id, {
                id,
                agentId: agent.id,
                requestId: req.id,
                name,
                input,
                startedAt: ts,
                result: null,
            });
            const orphan = this.orphanResults.get(id);
            if (orphan?.agentId === agent.id) {
                const { agentId: _owner, ...result } = orphan;
                this.tools.get(id).result = result;
                this.orphanResults.delete(id);
            }
            agent.toolCallIds.push(id);
            // An agent launched by this call may have been seen first: its parent is now known.
            const spawned = this.spawnOf.get(id);
            if (spawned?.kind === 'agent')
                ch.agents.add(spawned.agentId);
            const run = spawned?.kind === 'workflow' ? this.runs.get(spawned.runId) : undefined;
            if (run)
                this.markRun(run, ch);
        }
        if (!req.toolCallIds.includes(id))
            req.toolCallIds.push(id);
        ch.toolCalls.add(id);
    }
    // --- derived state -----------------------------------------------------------------------
    requestStatus(r) {
        if (r.stopReason !== null)
            return 'complete';
        if (r.error)
            return 'error';
        if (r.interruptedAt)
            return 'interrupted';
        // An idle session is not waiting on the model: a main request it left open is over.
        // Background sub-agents and workflow agents may still be running, so only the main agent.
        if (r.agentId === MAIN_AGENT_ID && this.idleMark !== null) {
            const start = requestStart(r);
            if (start === null || Date.parse(start) <= this.idleMark)
                return 'interrupted';
        }
        // Some versions never write stop_reason in sidechain transcripts, so a response that has
        // blocks is complete once anything shows it finished: a later request, a tool result,
        // or the end of its agent.
        const answered = r.blocks.size > 0;
        const agent = this.agents.get(r.agentId);
        const superseded = agent !== undefined && agent.requestIds.at(-1) !== r.id;
        if (superseded || (agent && this.agentEnded(agent)))
            return answered ? 'complete' : 'interrupted';
        if (answered && r.toolCallIds.some((id) => this.tools.get(id)?.result))
            return 'complete';
        return this.live === 'closed' ? 'interrupted' : 'in-flight';
    }
    /** A sub-agent with an explicit end signal (never true for the main agent). */
    agentEnded(a) {
        return this.agentEndStatus(a) !== null;
    }
    /** How a sub-agent ended, from any end signal; null while open (always for the main agent). */
    agentEndStatus(a) {
        if (a.kind === 'main')
            return null;
        if (a.kind === 'workflow-agent') {
            const wf = this.workflowAgentEnd(a);
            if (wf)
                return wf;
        }
        if (a.end)
            return a.end.status;
        return a.finished ? 'complete' : null;
    }
    /** The agent's latest request may change status when the agent's end becomes known. */
    markAgentTail(agentId, ch) {
        const last = this.requests.get(this.agents.get(agentId)?.requestIds.at(-1) ?? '');
        if (last)
            this.markRequestAndTools(last, ch);
    }
    markRequestAndTools(req, ch) {
        this.markRequest(req, ch);
        for (const id of req.toolCallIds)
            ch.toolCalls.add(id);
    }
    turnState(t) {
        if (t.interruptedAt)
            return { status: 'interrupted', endedAt: t.interruptedAt };
        if (t.endMarkAt)
            return { status: 'complete', endedAt: t.endMarkAt };
        const isLatest = this.agents.get(t.agentId)?.turnIds.at(-1) === t.id;
        const reqs = t.requestIds.flatMap((id) => this.requests.get(id) ?? []);
        const last = reqs.at(-1);
        // No call on record. Only busy means one is coming (the prompt's first call is not yet
        // written): the turn runs. Claude Code's registry says "waiting" for a process blocked on
        // the person, idle at its prompt after a local command (/model) included, so under waiting,
        // idle or closed the turn ended with what it did, at its own time: no active time.
        if (!last)
            return isLatest && this.live === 'busy'
                ? { status: 'running', endedAt: null }
                : { status: 'complete', endedAt: t.startedAt };
        const view = this.requestView(last);
        const lastAt = view.endedAt ?? view.startedAt ?? t.startedAt;
        if (view.status === 'in-flight')
            return { status: 'running', endedAt: null };
        if (view.status === 'error')
            return { status: 'error', endedAt: lastAt };
        if (view.status === 'interrupted')
            return { status: 'interrupted', endedAt: lastAt };
        const tools = reqs.flatMap((r) => r.toolCallIds.flatMap((id) => this.tools.get(id) ?? []));
        if (tools.some((tool) => this.toolStatus(tool) === 'running'))
            return { status: 'running', endedAt: null };
        if (last.stopReason !== 'tool_use')
            return { status: 'complete', endedAt: lastAt };
        // The model asked for tools and they finished: the next request is due, unless the agent
        // has ended (killed, failed, finished) — then this turn ended with it.
        const agent = this.agents.get(t.agentId);
        const ended = agent ? this.agentEndStatus(agent) : null;
        if (ended && isLatest)
            return { status: ended, endedAt: lastAt };
        if (!isLatest) {
            const toolEnds = tools.flatMap((tool) => tool.result?.at ?? []);
            return { status: 'complete', endedAt: [lastAt, ...toolEnds].sort().at(-1) ?? lastAt };
        }
        return this.live === 'closed'
            ? { status: 'unknown', endedAt: null }
            : { status: 'running', endedAt: null };
    }
    toolStatus(t) {
        if (t.result)
            return t.result.isError ? 'error' : 'complete';
        const agent = this.agents.get(t.agentId);
        const superseded = agent?.requestIds.at(-1) !== t.requestId;
        const ended = agent !== undefined && this.agentEnded(agent);
        return superseded || ended || this.live === 'closed' ? 'unknown' : 'running';
    }
    // --- views -------------------------------------------------------------------------------
    sessionView() {
        const base = this.source.summary;
        const requests = [...this.requests.values()];
        const main = this.agentView(this.agents.get(MAIN_AGENT_ID));
        return {
            ...base,
            title: pickTitle({
                customTitle: this.customTitle,
                agentName: this.agentName,
                aiTitle: this.aiTitle,
                firstHuman: this.firstPrompt('human'),
                firstAny: this.firstPrompt(null),
                command: this.firstPrompt(null, true),
            }) ?? base.title,
            cwd: this.cwd ?? base.cwd,
            startedAt: this.startedAt ?? base.startedAt,
            updatedAt: this.updatedAt ?? base.updatedAt,
            live: this.live,
            version: this.version ?? base.version,
            model: main.model ?? base.model,
            ...(this.isProbe() ? { tags: [...new Set([...(base.tags ?? []), 'probe'])] } : {}),
            ...this.activityView(),
            ...this.lastReplyView(),
            usage: sumUsage(requests.map((r) => this.exposedUsage(r))),
            counts: {
                turns: this.turns.size,
                requests: this.requests.size,
                toolCalls: this.tools.size,
                agents: this.agents.size,
            },
        };
    }
    /**
     * Only an agent's latest request can be in flight, and only its tools running: the views of
     * each agent's last request are all `sessionActivity` needs, however long the session.
     */
    activityView() {
        const requests = [];
        const toolCalls = [];
        for (const agent of this.agents.values()) {
            // An ended sub-agent has nothing in flight or running.
            if (this.agentEnded(agent))
                continue;
            const last = this.requests.get(agent.requestIds.at(-1) ?? '');
            if (!last)
                continue;
            requests.push(this.requestView(last));
            for (const id of last.toolCallIds) {
                const tool = this.tools.get(id);
                if (tool)
                    toolCalls.push(this.toolView(tool));
            }
        }
        const lastTurn = this.turns.get(this.agents.get(MAIN_AGENT_ID)?.turnIds.at(-1) ?? '');
        return activityField({
            live: this.live,
            toolCalls,
            requests,
            lastTurn: lastTurn ? this.turnView(lastTurn) : null,
            updatedAt: this.updatedAt,
        });
    }
    /** The main agent's latest words: its latest turn's requests are viewed, newest first, as needed. */
    lastReplyView() {
        const lastTurn = this.turns.get(this.agents.get(MAIN_AGENT_ID)?.turnIds.at(-1) ?? '');
        return lastReplyField({
            live: this.live,
            lastTurn: lastTurn ? this.turnView(lastTurn) : null,
            request: (id) => {
                const r = this.requests.get(id);
                return r ? this.requestView(r) : undefined;
            },
        });
    }
    isProbe() {
        const base = this.source.summary;
        return (base.tags?.includes('probe') === true ||
            this.customTitle === PROBE_NAME ||
            this.agentName === PROBE_NAME ||
            isProbeCwd(this.cwd ?? base.cwd));
    }
    /**
     * The first main-agent prompt of that origin (any origin when null), cleaned for a title. A
     * person's slash command that the model never saw (/effort, /clear) is passed over unless
     * `localCommands` asks for it, as the last resort.
     */
    firstPrompt(origin, localCommands = false) {
        const main = this.agents.get(MAIN_AGENT_ID);
        for (const id of main.turnIds) {
            const t = this.turns.get(id);
            if (!t || (origin !== null && t.origin !== origin))
                continue;
            // Boilerplate Claude Code writes itself, never what a session is about.
            if (t.origin === 'auto-continuation')
                continue;
            if (!localCommands && t.command && t.requestIds.length === 0)
                continue;
            const title = cleanPrompt(t.prompt);
            if (title)
                return title;
        }
        return null;
    }
    exposedUsage(r) {
        return this.requestStatus(r) === 'in-flight' ? null : r.usage;
    }
    agentView(a) {
        const requests = a.requestIds.flatMap((id) => this.requests.get(id) ?? []);
        const last = requests.at(-1);
        const firstTurn = this.turns.get(a.turnIds[0] ?? '');
        const lastTurn = this.turns.get(a.turnIds.at(-1) ?? '');
        const lastTurnState = lastTurn ? this.turnState(lastTurn) : null;
        let status;
        let endedAt;
        if (a.kind === 'main') {
            status =
                lastTurnState === null
                    ? 'unknown'
                    : lastTurnState.status === 'running' || lastTurnState.status === 'unknown'
                        ? lastTurnState.status
                        : 'complete';
            endedAt = status === 'running' ? null : (lastTurnState?.endedAt ?? null);
        }
        else if (a.kind === 'workflow-agent' && this.workflowAgentEnd(a)) {
            status = this.workflowAgentEnd(a);
            endedAt = a.lastTs;
        }
        else if (a.end) {
            status = a.end.status;
            endedAt = a.end.at ?? a.lastTs;
        }
        else if (a.finished) {
            status = 'complete';
            endedAt = a.lastTs;
        }
        else {
            status = this.live === 'closed' ? 'unknown' : 'running';
            endedAt = null;
        }
        const run = a.workflowRunId ? this.runs.get(a.workflowRunId) : undefined;
        const journal = run?.journal.get(a.id);
        const spawnedBy = run ? run.toolCallId : a.spawnedByToolCallId;
        const spawner = spawnedBy ? this.tools.get(spawnedBy) : undefined;
        const spawnerInput = (spawner?.input ?? {});
        return {
            id: a.id,
            kind: a.kind,
            parentId: a.kind === 'main'
                ? null
                : spawner && spawner.agentId !== a.id
                    ? spawner.agentId
                    : a.parentId,
            spawnedByToolCallId: spawner ? spawner.id : null,
            agentType: a.agentType,
            label: journal?.label ??
                a.metaLabel ??
                (typeof spawnerInput.description === 'string' ? spawnerInput.description : null) ??
                a.agentType ??
                a.label,
            workflowRunId: a.workflowRunId,
            phase: journal?.phase ?? a.phase,
            model: last ? (last.model ?? last.apiModel) : null,
            status,
            startedAt: firstTurn?.startedAt ?? (last ? requestStart(last) : null),
            endedAt,
            usage: sumUsage(requests.map((r) => this.exposedUsage(r))),
            counts: {
                turns: a.turnIds.length,
                requests: a.requestIds.length,
                toolCalls: a.toolCallIds.length,
            },
        };
    }
    /** How a workflow agent ended, from the journal or the run's end; null while open. */
    workflowAgentEnd(a) {
        const run = a.workflowRunId ? this.runs.get(a.workflowRunId) : undefined;
        if (!run)
            return null;
        const outcome = run.journal.get(a.id)?.outcome;
        if (outcome === 'result')
            return 'complete';
        if (outcome === 'failed' || isRetried(run, a.id))
            return 'error';
        return run.final?.status ?? run.notified?.status ?? null;
    }
    workflowView(r) {
        const tool = r.toolCallId ? this.tools.get(r.toolCallId) : undefined;
        const status = r.final?.status ?? r.notified?.status ?? (this.live === 'closed' ? 'unknown' : 'running');
        return {
            id: r.id,
            name: r.name,
            taskId: r.taskId,
            toolCallId: tool ? tool.id : null,
            parentAgentId: tool?.agentId ?? MAIN_AGENT_ID,
            status,
            phases: r.final?.phases ?? r.journalPhases.map((title) => ({ title, detail: null })),
            agentIds: r.agentIds.filter((id) => this.agents.has(id)),
            startedAt: r.final?.startedAt ?? tool?.startedAt ?? null,
            endedAt: status === 'running' || status === 'unknown'
                ? null
                : (r.final?.endedAt ?? r.notified?.at ?? null),
        };
    }
    turnView(t) {
        return {
            id: t.id,
            agentId: t.agentId,
            index: t.index,
            origin: t.origin,
            prompt: t.prompt,
            sender: t.sender,
            startedAt: t.startedAt,
            ...this.turnState(t),
            requestIds: [...t.requestIds],
        };
    }
    requestView(r) {
        const blocks = orderedBlocks(r).map((b) => b.block);
        const times = blocks.map((b) => b.at).sort();
        return {
            id: r.id,
            agentId: r.agentId,
            turnId: r.turnId,
            index: r.index,
            model: r.apiModel ?? r.model,
            effort: r.effort ?? r.apiEffort,
            startedAt: requestStart(r),
            firstBlockAt: times[0] ?? null,
            endedAt: times.at(-1) ?? null,
            status: this.requestStatus(r),
            stopReason: r.stopReason,
            usage: this.exposedUsage(r),
            blocks,
            toolCallIds: [...r.toolCallIds],
            hasDetail: r.hasApi,
            error: r.error,
            ...(r.compactedBefore ? { compactedBefore: true } : {}),
        };
    }
    toolView(t) {
        const endedAt = t.result?.at ?? null;
        // Where an edit landed, as its result recorded it.
        const lineChanges = t.result && !t.result.isError ? lineChangesOf(t.result.toolUseResult) : null;
        return {
            id: t.id,
            agentId: t.agentId,
            requestId: t.requestId,
            name: t.name,
            input: t.input,
            status: this.toolStatus(t),
            startedAt: t.startedAt,
            endedAt,
            durationMs: durationBetween(t.startedAt, endedAt),
            resultPreview: t.result ? preview(t.result.content) : null,
            hasFullResult: t.result !== null,
            spawned: this.spawnOf.get(t.id) ?? null,
            ...(lineChanges ? { lineChanges } : {}),
        };
    }
    diagnosticsView() {
        return {
            unknownRecordTypes: { ...this.diag.unknownRecordTypes },
            parseErrors: this.diag.parseErrors,
            unavailable: this.requests.size > 0 && !this.sawApiRequest ? ['request-detail', 'in-flight'] : [],
        };
    }
}
const PREVIEW_CHARS = 500;
/** Milliseconds between two ISO times, or null when either is missing or unparsable. */
function durationBetween(from, to) {
    if (!from || !to)
        return null;
    const ms = Date.parse(to) - Date.parse(from);
    return Number.isFinite(ms) ? Math.max(0, ms) : null;
}
/** Diagnostics counter for requests dropped by `dropRequest`. */
const SUPERSEDED = 'superseded-request';
/** No reply, no error, no interrupt: the request was abandoned before the model answered. */
const silentlyAbandoned = (r) => r.blocks.size === 0 && r.stopReason === null && r.error === null && r.interruptedAt === null;
/** `<status>` of a task notification → how the background agent ended. */
const NOTIFIED_STATUS = {
    completed: 'complete',
    failed: 'error',
    killed: 'interrupted',
    stopped: 'interrupted',
};
/** First characters of a tool result as text; non-text blocks become "[type]". */
function preview(content) {
    let text;
    if (typeof content === 'string')
        text = content;
    else if (Array.isArray(content))
        text = content
            .map((part) => {
            const p = (part ?? {});
            if (p.type === 'text' && typeof p.text === 'string')
                return p.text;
            // String() of an array joins it recursively: a nested one would overflow the stack.
            return `[${typeof p.type === 'object' && p.type !== null ? 'object' : String(p.type)}]`;
        })
            .join('\n');
    else
        text = content === undefined ? '' : jsonText(content);
    return text.slice(0, PREVIEW_CHARS);
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
//# sourceMappingURL=parser.js.map
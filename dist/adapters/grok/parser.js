/**
 * Pure Grok session parser. The server reads files and feeds them here; this class does no I/O.
 *
 * Grok splits one session across logs that arrive independently and not in time order:
 * `events.jsonl` names model loops, `updates.jsonl` carries text and tool payloads, `usage.json`
 * closes a user turn. Request status and token totals are derived when a snapshot is taken so
 * a later file can still fill in an earlier one.
 *
 * Usage exists only for the whole user turn. It is reported on that turn's last model call so
 * session and agent totals still add up, and `per-request-usage` stays in `diagnostics.unavailable`.
 */
import { basename } from 'node:path';
import { activityField } from '../../core/activity.js';
import { emptyChanges } from '../../core/changes.js';
import { lastReplyField } from '../../core/last-reply.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import { sumUsage } from '../../core/usage.js';
import { parseChatLine, parseEventLine, parseSummary, parseToolDefinitions, parseUpdateLine, parseUsage, textOf, } from './records.js';
const UNAVAILABLE = ['per-request-usage', 'subagents'];
const PREVIEW_CHARS = 500;
class Changes {
    session = false;
    diagnostics = false;
    agents = new Set();
    turns = new Set();
    requests = new Set();
    toolCalls = new Set();
    toChangeSet() {
        // The main agent's counts, usage and status follow every turn, request and tool.
        if (this.session || this.turns.size > 0 || this.requests.size > 0 || this.toolCalls.size > 0)
            this.agents.add(MAIN_AGENT_ID);
        return {
            ...emptyChanges(),
            session: this.session,
            diagnostics: this.diagnostics,
            agents: [...this.agents],
            turns: [...this.turns],
            requests: [...this.requests],
            toolCalls: [...this.toolCalls],
        };
    }
}
function rank(status) {
    if (status === 'interrupted')
        return 3;
    if (status === 'error')
        return 2;
    if (status === 'complete')
        return 1;
    return 0;
}
/** `cancelled` is the user stopping the turn; glassbox calls that interrupted. */
function toRun(outcome) {
    const value = (outcome ?? '').toLowerCase();
    if (value === 'cancelled' || value === 'canceled' || value === 'interrupted')
        return 'interrupted';
    if (value === 'error' || value === 'failed')
        return 'error';
    return 'complete';
}
/** The streamed text after one more chunk. Linear: only the new chunk is inspected. */
function appendChunk(sofar, text) {
    if (!text)
        return sofar;
    // A later chunk that repeats the whole text so far is a snapshot, not a delta.
    if (sofar && text.startsWith(sofar))
        return text;
    return sofar + text;
}
/**
 * Pairs chat-history loops with model calls. Tool-call ids anchor exact pairs. Between anchors,
 * and before the first or after the last, loops pair up in order only when both sides have the
 * same count and agree on known turns. Anything else stays unpaired: compaction drops the head
 * of the history, and no fallback is better than text next to the wrong call.
 */
function pairChatLoops(loops, requests) {
    const out = new Map();
    const requestOfTool = new Map();
    requests.forEach((req, i) => {
        for (const id of req.toolCallIds)
            requestOfTool.set(id, i);
    });
    const anchors = [];
    loops.forEach((loop, li) => {
        const ri = loop.toolIds.map((id) => requestOfTool.get(id)).find((i) => i !== undefined);
        if (ri === undefined)
            return;
        const last = anchors.at(-1);
        // Pairs must move forward on both sides; an out-of-order match is not trusted.
        if (last && (li <= last[0] || ri <= last[1]))
            return;
        anchors.push([li, ri]);
    });
    const fill = (fromLoop, toLoop, fromReq, toReq) => {
        const ls = loops.slice(fromLoop, toLoop);
        const rs = requests.slice(fromReq, toReq);
        if (ls.length === 0 || ls.length !== rs.length)
            return;
        if (ls.some((loop, i) => loop.turn !== null && loop.turn !== rs[i]?.turnNumber))
            return;
        ls.forEach((loop, i) => {
            const req = rs[i];
            if (req)
                out.set(req.id, loop);
        });
    };
    let nextLoop = 0;
    let nextReq = 0;
    for (const [li, ri] of anchors) {
        fill(nextLoop, li, nextReq, ri);
        const req = requests[ri];
        const loop = loops[li];
        if (req && loop)
            out.set(req.id, loop);
        nextLoop = li + 1;
        nextReq = ri + 1;
    }
    fill(nextLoop, loops.length, nextReq, requests.length);
    return out;
}
export class GrokSessionParser {
    source;
    live;
    turns = new Map();
    requests = new Map();
    tools = new Map();
    promptToTurn = new Map();
    streamToRequest = new Map();
    loopTaken = new Set();
    fileUsage = new Map();
    pendingTools = new Map();
    chatLoops = [];
    /** Reasoning rows waiting for the assistant row that closes their loop. */
    pendingReasoning = null;
    /** `prompt_index` of the latest human row in the chat history. */
    chatTurn = null;
    detailMessages = [];
    compactionMs = [];
    diag = { unknownRecordTypes: {}, parseErrors: 0 };
    currentTurn = null;
    title = null;
    cwd = null;
    model = null;
    effort = null;
    startedAt = null;
    updatedAt = null;
    systemText = null;
    toolDefs = null;
    constructor(source) {
        this.source = source;
        this.live = source.summary.live;
        this.title = source.summary.title;
        this.cwd = source.summary.cwd;
        this.model = source.summary.model;
        this.startedAt = source.summary.startedAt;
        this.updatedAt = source.summary.updatedAt;
    }
    ingestLines(file, lines) {
        const ch = new Changes();
        for (const line of lines) {
            if (line.trim() === '')
                continue;
            if (file.role === 'events')
                this.applyEvent(line, ch);
            else if (file.role === 'updates')
                this.applyUpdate(line, ch);
            else if (file.role === 'chat-history')
                this.applyChat(line, ch);
            else if (file.role === 'subagent' || file.role === 'subagent-meta')
                this.noteUnknown('subagent', ch);
        }
        return ch.toChangeSet();
    }
    ingestJson(file, value) {
        const ch = new Changes();
        const isDocument = typeof value === 'object' && value !== null && !Array.isArray(value);
        if ((file.role === 'summary' || file.role === 'usage') && !isDocument) {
            this.diag.parseErrors += 1;
            ch.diagnostics = true;
            return ch.toChangeSet();
        }
        if (file.role === 'summary')
            this.applySummary(value, ch);
        else if (file.role === 'usage')
            this.applyUsage(value, ch);
        else if (file.role === 'tool-definitions')
            this.applyTools(value, ch);
        else if (file.role === 'subagent-meta')
            this.noteUnknown('subagent', ch);
        return ch.toChangeSet();
    }
    setLive(live) {
        const ch = new Changes();
        if (live === this.live)
            return ch.toChangeSet();
        this.live = live;
        ch.session = true;
        ch.agents.add(MAIN_AGENT_ID);
        for (const turn of this.turns.values())
            if (!turn.ended)
                ch.turns.add(this.turnId(turn));
        for (const req of this.requests.values()) {
            if (this.requestStatus(req) !== 'complete')
                ch.requests.add(req.id);
        }
        for (const tool of this.tools.values()) {
            if (!tool.done)
                ch.toolCalls.add(tool.id);
        }
        return ch.toChangeSet();
    }
    snapshot() {
        const requests = this.sortedRequests();
        const tools = this.sortedTools();
        const pairs = this.chatPairs(requests);
        return {
            session: this.sessionView(requests, tools, pairs),
            agents: [this.agentView(requests, tools)],
            turns: this.sortedTurns().map((turn) => this.turnView(turn, requests)),
            requests: requests.map((req) => this.requestView(req, requests, pairs)),
            toolCalls: tools.map((tool) => this.toolView(tool)),
            workflows: [],
            diagnostics: this.diagnosticsView(),
        };
    }
    patch(changes) {
        const requests = this.sortedRequests();
        const tools = this.sortedTools();
        const pairs = this.chatPairs(requests);
        const pick = (ids, items) => {
            const want = new Set(ids);
            return items.filter((item) => want.has(item.id));
        };
        return {
            session: this.sessionView(requests, tools, pairs),
            agents: changes.agents.includes(MAIN_AGENT_ID) ? [this.agentView(requests, tools)] : [],
            turns: pick(changes.turns, this.sortedTurns().map((turn) => this.turnView(turn, requests))),
            requests: pick(changes.requests, requests.map((req) => this.requestView(req, requests, pairs))),
            toolCalls: pick(changes.toolCalls, tools.map((tool) => this.toolView(tool))),
            workflows: [],
            diagnostics: changes.diagnostics ? this.diagnosticsView() : null,
        };
    }
    requestDetail(requestId) {
        const requests = this.sortedRequests();
        const req = this.requests.get(requestId);
        if (!req)
            return null;
        const latest = requests.at(-1);
        const notes = ['Grok reports token usage once per user turn, not per model call.'];
        const params = this.paramsOf(req);
        if (!latest || latest.id !== req.id || !this.hasBody()) {
            notes.push('Grok does not store the request body for this model call.');
            return {
                requestId,
                completeness: 'unavailable',
                notes,
                params,
                system: null,
                tools: null,
                messages: null,
            };
        }
        notes.push('System prompt and tool definitions are the latest copy for the session, not a frozen snapshot of this call.');
        return {
            requestId,
            completeness: 'partial',
            notes,
            params,
            system: this.systemText,
            tools: this.toolDefs,
            messages: this.detailMessages.length > 0 ? this.detailMessages : null,
        };
    }
    toolResult(toolCallId) {
        const tool = this.tools.get(toolCallId);
        return tool?.hasResult ? tool.result : undefined;
    }
    // --- ingestion -----------------------------------------------------------------------
    applyEvent(line, ch) {
        const rec = parseEventLine(line);
        if (rec.kind === 'invalid') {
            this.diag.parseErrors += 1;
            ch.diagnostics = true;
            return;
        }
        if (rec.kind === 'other') {
            if (!rec.known)
                this.noteUnknown(rec.type, ch);
            return;
        }
        this.touch(rec.ts, ch);
        if (rec.type === 'turn_started' && rec.turnNumber !== null) {
            const turn = this.ensureTurn(rec.turnNumber, ch);
            if (rec.modelId)
                turn.model = rec.modelId;
            if (rec.ts && !turn.startedAt)
                turn.startedAt = rec.ts;
            this.currentTurn = turn.number;
            return;
        }
        if (rec.type === 'turn_ended') {
            this.endCurrent(rec.outcome, rec.ts, null, ch);
            return;
        }
        if (rec.type === 'loop_started' && rec.loopIndex !== null) {
            const turnNumber = this.currentTurn ?? this.latestTurnNumber() ?? 0;
            const turn = this.ensureTurn(turnNumber, ch);
            this.ensureRequest(turn.number, rec.loopIndex, rec.ts, ch);
            return;
        }
        if (rec.type === 'first_token') {
            this.noteFirstToken(rec.ts, ch);
            return;
        }
        if (rec.type === 'tool_completed' && rec.toolCallId) {
            this.noteToolEvent(rec, ch);
        }
    }
    applyUpdate(line, ch) {
        const rec = parseUpdateLine(line);
        if (rec.kind === 'invalid') {
            this.diag.parseErrors += 1;
            ch.diagnostics = true;
            return;
        }
        if (rec.kind === 'other') {
            if (!rec.known)
                this.noteUnknown(rec.type, ch);
            return;
        }
        this.touch(rec.ts, ch);
        switch (rec.kind) {
            case 'user-message':
                this.onUser(rec, ch);
                break;
            case 'thought':
            case 'message': {
                const req = this.locate(rec.promptId, rec.streamStartMs, rec.ts, ch);
                if (rec.kind === 'thought') {
                    req.thought = appendChunk(req.thought, rec.text);
                    if (rec.ts && !req.thoughtAt)
                        req.thoughtAt = rec.ts;
                }
                else {
                    req.message = appendChunk(req.message, rec.text);
                    if (rec.ts && !req.textAt)
                        req.textAt = rec.ts;
                }
                ch.requests.add(req.id);
                break;
            }
            case 'tool-call':
                this.onToolCall(rec, ch);
                break;
            case 'tool-update':
                this.onToolUpdate(rec, ch);
                break;
            case 'turn-completed':
                this.onTurnCompleted(rec, ch);
                break;
            case 'compaction':
                this.onCompaction(rec);
                // Which request follows a compaction depends on every request's start.
                this.markAllRequests(ch);
                break;
            default:
                break;
        }
    }
    applyChat(line, ch) {
        const rec = parseChatLine(line);
        if (rec.kind === 'invalid') {
            this.diag.parseErrors += 1;
            ch.diagnostics = true;
            return;
        }
        if (rec.kind === 'other') {
            if (!rec.known)
                this.noteUnknown(rec.type, ch);
            return;
        }
        // Chat rows feed the fallback text and the request detail of other requests.
        this.markAllRequests(ch);
        if (rec.kind === 'system') {
            this.systemText = rec.text;
            ch.diagnostics = true;
            return;
        }
        if (rec.kind === 'user') {
            this.onChatUser(rec, ch);
            return;
        }
        if (rec.kind === 'reasoning') {
            this.onChatReasoning(rec);
            return;
        }
        if (rec.kind === 'assistant') {
            this.onChatAssistant(rec);
            return;
        }
        const tool = this.tools.get(rec.toolCallId);
        if (tool && !tool.hasResult) {
            tool.result = rec.content;
            tool.hasResult = true;
            ch.toolCalls.add(tool.id);
        }
        this.detailMessages.push({ role: 'tool', toolCallId: rec.toolCallId });
    }
    onUser(rec, ch) {
        const number = rec.promptIndex ?? this.currentTurn ?? this.latestTurnNumber() ?? 0;
        const turn = this.ensureTurn(number, ch);
        this.currentTurn = turn.number;
        if (rec.modelId && !turn.model)
            turn.model = rec.modelId;
        if (rec.ts && !turn.startedAt)
            turn.startedAt = rec.ts;
        if (!turn.prompt)
            turn.prompt = rec.text;
        else if (rec.text && !turn.prompt.includes(rec.text))
            turn.prompt += rec.text;
        turn.origin = 'human';
    }
    onToolCall(rec, ch) {
        const req = this.locate(rec.promptId, rec.streamStartMs, rec.ts, ch);
        const tool = this.ensureTool(rec.toolCallId, req, ch);
        tool.name = rec.name;
        tool.input = rec.input;
        if (rec.ts && !tool.startedAt)
            tool.startedAt = rec.ts;
        this.attachTool(req, tool, ch);
        this.finishTool(tool, rec.status, undefined, rec.ts);
        this.applyPending(tool);
    }
    onToolUpdate(rec, ch) {
        const existing = this.tools.get(rec.toolCallId);
        const req = existing
            ? this.requests.get(existing.requestId)
            : this.locate(rec.promptId, rec.streamStartMs, rec.ts, ch);
        if (!req)
            return;
        const tool = existing ?? this.ensureTool(rec.toolCallId, req, ch);
        this.attachTool(req, tool, ch);
        const output = rec.rawOutput !== undefined ? rec.rawOutput : rec.content;
        this.finishTool(tool, rec.status, output, rec.ts);
        this.applyPending(tool);
        ch.toolCalls.add(tool.id);
    }
    onTurnCompleted(rec, ch) {
        const bound = rec.promptId ? this.promptToTurn.get(rec.promptId) : undefined;
        const number = bound ?? this.currentTurn ?? this.latestTurnNumber() ?? 0;
        const turn = this.ensureTurn(number, ch);
        if (rec.promptId)
            this.promptToTurn.set(rec.promptId, turn.number);
        if (rec.usage)
            turn.usage = rec.usage;
        this.markEnded(turn, rec.stopReason, rec.ts, rec.stopReason);
        if (rec.usage)
            this.ensureUsageCarrier(turn.number, ch);
        this.markTurn(turn.number, ch);
    }
    onCompaction(rec) {
        if (rec.phase === 'started' || !rec.ts)
            return;
        const ms = Date.parse(rec.ts);
        if (!Number.isNaN(ms))
            this.compactionMs.push(ms);
    }
    onChatUser(rec, ch) {
        if (rec.synthetic)
            return;
        this.detailMessages.push({ role: 'user', content: rec.text });
        if (rec.promptIndex === null)
            return;
        this.chatTurn = rec.promptIndex;
        const turn = this.turns.get(rec.promptIndex);
        if (turn && !turn.prompt) {
            turn.prompt = rec.text;
            ch.turns.add(this.turnId(turn));
        }
    }
    onChatReasoning(rec) {
        // Empty summaries keep their place: every loop has exactly one reasoning row.
        this.pendingReasoning = [...(this.pendingReasoning ?? []), rec.text];
    }
    onChatAssistant(rec) {
        this.chatLoops.push({
            turn: this.chatTurn,
            reasoning: (this.pendingReasoning ?? []).join('\n'),
            text: rec.text,
            toolIds: rec.toolCalls.map((call) => call.id),
        });
        this.pendingReasoning = null;
        if (rec.text || rec.toolCalls.length > 0) {
            this.detailMessages.push({
                role: 'assistant',
                content: rec.text,
                toolCalls: rec.toolCalls.map((call) => ({ id: call.id, name: call.name })),
            });
        }
    }
    applySummary(value, ch) {
        const summary = parseSummary(value);
        if (summary.title)
            this.title = summary.title;
        if (summary.cwd)
            this.cwd = summary.cwd;
        if (summary.model)
            this.model = summary.model;
        if (summary.effort)
            this.effort = summary.effort;
        if (summary.createdAt)
            this.startedAt = summary.createdAt;
        this.touch(summary.updatedAt ?? summary.createdAt, ch);
        ch.session = true;
        ch.agents.add(MAIN_AGENT_ID);
        // Model, effort and the session start are fallbacks in request and turn views.
        this.markAllRequests(ch);
        for (const turn of this.turns.values())
            ch.turns.add(this.turnId(turn));
    }
    applyUsage(value, ch) {
        // The file is rewritten whole: turns it no longer lists lose their usage too.
        for (const number of this.fileUsage.keys())
            this.markTurn(number, ch);
        this.fileUsage.clear();
        for (const row of parseUsage(value).turns) {
            const number = row.turnNumber - 1;
            if (number < 0)
                continue;
            const turn = this.ensureTurn(number, ch);
            this.fileUsage.set(number, row.usage);
            this.markEnded(turn, 'completed', row.endedAt, null);
            this.ensureUsageCarrier(number, ch);
            this.markTurn(number, ch);
        }
        ch.session = true;
        ch.agents.add(MAIN_AGENT_ID);
    }
    applyTools(value, ch) {
        const tools = parseToolDefinitions(value);
        if (!tools)
            return;
        this.toolDefs = tools;
        ch.diagnostics = true;
        for (const req of this.requests.values())
            ch.requests.add(req.id);
    }
    noteToolEvent(rec, ch) {
        const id = rec.toolCallId;
        if (!id)
            return;
        const tool = this.tools.get(id);
        if (!tool) {
            this.pendingTools.set(id, {
                durationMs: rec.durationMs,
                outcome: rec.outcome,
                ts: rec.ts,
                name: rec.toolName,
            });
            return;
        }
        this.applyToolEvent(tool, rec.durationMs, rec.outcome, rec.ts);
        ch.toolCalls.add(tool.id);
    }
    applyPending(tool) {
        const pending = this.pendingTools.get(tool.id);
        if (!pending)
            return;
        this.pendingTools.delete(tool.id);
        if (pending.name && tool.name === 'tool')
            tool.name = pending.name;
        this.applyToolEvent(tool, pending.durationMs, pending.outcome, pending.ts);
    }
    applyToolEvent(tool, durationMs, outcome, ts) {
        if (durationMs !== null)
            tool.durationMs = durationMs;
        if (ts && !tool.endedAt)
            tool.endedAt = ts;
        const value = (outcome ?? '').toLowerCase();
        if (value === 'success')
            tool.done = true;
        else if (value)
            tool.failed = true;
    }
    finishTool(tool, status, output, ts) {
        const value = (status ?? '').toLowerCase();
        if (output !== undefined) {
            tool.result = output;
            tool.hasResult = true;
        }
        if (value === 'completed' || value === 'complete' || value === 'success') {
            tool.done = true;
            if (ts)
                tool.endedAt = ts;
        }
        else if (value === 'error' || value === 'failed') {
            tool.failed = true;
            if (ts)
                tool.endedAt = ts;
        }
    }
    noteFirstToken(ts, ch) {
        if (!ts)
            return;
        const at = Date.parse(ts);
        let best = null;
        let bestStart = Number.NEGATIVE_INFINITY;
        for (const req of this.requests.values()) {
            if (req.firstBlockAt || !req.startedAt)
                continue;
            const start = Date.parse(req.startedAt);
            if (Number.isNaN(start) || start > at || start < bestStart)
                continue;
            best = req;
            bestStart = start;
        }
        if (!best)
            return;
        best.firstBlockAt = ts;
        ch.requests.add(best.id);
    }
    endCurrent(outcome, ts, stopReason, ch) {
        const number = this.currentTurn ?? this.latestTurnNumber();
        if (number === null)
            return;
        const turn = this.turns.get(number);
        if (!turn)
            return;
        this.markEnded(turn, outcome, ts, stopReason);
        this.markTurn(turn.number, ch);
    }
    locate(promptId, streamStartMs, ts, ch) {
        const key = streamStartMs !== null ? `${promptId ?? ''}:${streamStartMs}` : null;
        if (key) {
            const known = this.streamToRequest.get(key);
            const existing = known ? this.requests.get(known) : undefined;
            if (existing)
                return existing;
        }
        const bound = promptId ? this.promptToTurn.get(promptId) : undefined;
        let matched = streamStartMs !== null ? this.matchLoop(streamStartMs) : null;
        if (matched && bound !== undefined && matched.turnNumber !== bound)
            matched = null;
        const turnNumber = bound ?? matched?.turnNumber ?? this.currentTurn ?? this.latestTurnNumber() ?? 0;
        if (promptId && !this.promptToTurn.has(promptId))
            this.promptToTurn.set(promptId, turnNumber);
        this.ensureTurn(turnNumber, ch);
        let req = matched && matched.turnNumber === turnNumber ? matched : null;
        if (!req)
            req = this.ensureRequest(turnNumber, this.nextLoop(turnNumber), ts, ch);
        if (key) {
            this.streamToRequest.set(key, req.id);
            this.loopTaken.add(req.id);
        }
        return req;
    }
    /** Latest loop that had already started by `streamStartMs` and is not yet tied to a stream. */
    matchLoop(streamStartMs) {
        let best = null;
        let bestStart = Number.NEGATIVE_INFINITY;
        for (const req of this.requests.values()) {
            if (!req.startedAt || this.loopTaken.has(req.id))
                continue;
            const start = Date.parse(req.startedAt);
            if (Number.isNaN(start) || start > streamStartMs || start < bestStart)
                continue;
            best = req;
            bestStart = start;
        }
        return best;
    }
    ensureTurn(number, ch) {
        let turn = this.turns.get(number);
        if (!turn) {
            turn = {
                number,
                promptId: null,
                prompt: '',
                origin: 'human',
                startedAt: null,
                endedAt: null,
                ended: false,
                outcome: null,
                stopReason: null,
                model: null,
                usage: null,
            };
            this.turns.set(number, turn);
        }
        ch.turns.add(this.turnId(turn));
        ch.agents.add(MAIN_AGENT_ID);
        return turn;
    }
    ensureRequest(turnNumber, loopIndex, startedAt, ch) {
        const id = `t${turnNumber}:${loopIndex}`;
        let req = this.requests.get(id);
        // A new or re-timed loop changes others: the turn's statuses, end times and usage
        // placement, which request is the latest (request detail), and chat-history pairing,
        // whose gaps can span turns.
        this.markAllRequests(ch);
        if (!req) {
            req = {
                id,
                turnNumber,
                loopIndex,
                startedAt,
                firstBlockAt: null,
                thought: '',
                message: '',
                thoughtAt: null,
                textAt: null,
                toolCallIds: [],
            };
            this.requests.set(id, req);
        }
        else if (startedAt && !req.startedAt) {
            req.startedAt = startedAt;
        }
        ch.requests.add(req.id);
        ch.turns.add(this.turnId(this.ensureTurn(turnNumber, ch)));
        this.markTurn(turnNumber, ch);
        return req;
    }
    ensureTool(id, req, ch) {
        let tool = this.tools.get(id);
        if (!tool) {
            tool = {
                id,
                requestId: req.id,
                name: 'tool',
                input: {},
                done: false,
                failed: false,
                startedAt: null,
                endedAt: null,
                durationMs: null,
                result: undefined,
                hasResult: false,
            };
            this.tools.set(id, tool);
        }
        ch.toolCalls.add(tool.id);
        ch.requests.add(req.id);
        return tool;
    }
    markEnded(turn, outcome, ts, stopReason) {
        const next = toRun(outcome);
        if (!turn.ended || rank(next) >= rank(turn.outcome))
            turn.outcome = next;
        turn.ended = true;
        if (ts && (!turn.endedAt || ts > turn.endedAt))
            turn.endedAt = ts;
        if (stopReason)
            turn.stopReason = stopReason;
    }
    noteUnknown(type, ch) {
        this.diag.unknownRecordTypes[type] = (this.diag.unknownRecordTypes[type] ?? 0) + 1;
        ch.diagnostics = true;
    }
    touch(ts, ch) {
        if (!ts)
            return;
        if (!this.updatedAt || ts > this.updatedAt)
            this.updatedAt = ts;
        if (!this.startedAt || ts < this.startedAt) {
            this.startedAt = ts;
            // The session start is the fallback time of turns and blocks without their own.
            for (const turn of this.turns.values())
                ch.turns.add(this.turnId(turn));
            this.markAllRequests(ch);
        }
        ch.session = true;
    }
    /** A turn, its requests and their tools: what a change to the turn's state can affect. */
    markTurn(turnNumber, ch) {
        const turn = this.turns.get(turnNumber);
        if (turn)
            ch.turns.add(this.turnId(turn));
        for (const req of this.requests.values())
            if (req.turnNumber === turnNumber)
                this.markRequest(req, ch);
    }
    markRequest(req, ch) {
        ch.requests.add(req.id);
        for (const id of req.toolCallIds)
            ch.toolCalls.add(id);
    }
    /**
     * Usage lives on a turn's last model call. A turn with usage but no loop on record (no
     * `events.jsonl`, or a log cut short) gets loop 0 as a placeholder so its tokens still count;
     * if the loop shows up later it is the same entity, so nothing is counted twice.
     */
    ensureUsageCarrier(turnNumber, ch) {
        for (const req of this.requests.values())
            if (req.turnNumber === turnNumber)
                return;
        this.ensureRequest(turnNumber, 0, null, ch);
    }
    /** Tool-call ids anchor chat-history pairing, so a new one can re-pair any request. */
    attachTool(req, tool, ch) {
        if (req.toolCallIds.includes(tool.id))
            return;
        req.toolCallIds.push(tool.id);
        this.markAllRequests(ch);
    }
    markAllRequests(ch) {
        for (const req of this.requests.values())
            this.markRequest(req, ch);
    }
    // --- views ---------------------------------------------------------------------------
    sortedTurns() {
        return [...this.turns.values()].sort((a, b) => a.number - b.number);
    }
    sortedRequests() {
        return [...this.requests.values()].sort((a, b) => a.turnNumber - b.turnNumber || a.loopIndex - b.loopIndex);
    }
    sortedTools() {
        return [...this.tools.values()].sort((a, b) => {
            const at = a.startedAt ?? '';
            const bt = b.startedAt ?? '';
            return at < bt ? -1 : at > bt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
    }
    requestsOf(turnNumber) {
        return this.sortedRequests().filter((req) => req.turnNumber === turnNumber);
    }
    latestTurnNumber() {
        let latest = null;
        for (const turn of this.turns.values())
            if (latest === null || turn.number > latest)
                latest = turn.number;
        return latest;
    }
    nextLoop(turnNumber) {
        let max = -1;
        for (const req of this.requests.values())
            if (req.turnNumber === turnNumber)
                max = Math.max(max, req.loopIndex);
        return max + 1;
    }
    laterRequest(req) {
        let later = null;
        for (const other of this.requests.values()) {
            if (other.turnNumber !== req.turnNumber || other.loopIndex <= req.loopIndex)
                continue;
            if (!later || other.loopIndex < later.loopIndex)
                later = other;
        }
        return later;
    }
    requestStatus(req) {
        if (this.laterRequest(req))
            return 'complete';
        const turn = this.turns.get(req.turnNumber);
        if (!turn?.ended)
            return this.live === 'closed' ? 'interrupted' : 'in-flight';
        if (turn.outcome === 'interrupted')
            return 'interrupted';
        if (turn.outcome === 'error')
            return 'error';
        return 'complete';
    }
    usageFor(turn) {
        return this.fileUsage.get(turn.number) ?? turn.usage;
    }
    exposedUsage(req) {
        if (this.requestStatus(req) === 'in-flight')
            return null;
        const turn = this.turns.get(req.turnNumber);
        if (!turn)
            return null;
        const usage = this.usageFor(turn);
        if (!usage)
            return null;
        const reqs = this.requestsOf(turn.number);
        return reqs.at(-1)?.id === req.id ? usage : null;
    }
    turnId(turn) {
        return `turn:${turn.number + 1}`;
    }
    hasBody() {
        return this.systemText !== null || this.toolDefs !== null || this.detailMessages.length > 0;
    }
    paramsOf(req) {
        const turn = this.turns.get(req.turnNumber);
        const model = turn?.model ?? this.model;
        const effort = this.effort;
        if (!model && !effort)
            return null;
        return { model, reasoningEffort: effort };
    }
    /** Chat loops, plus the one still streaming (reasoning written, assistant row not yet). */
    chatPairs(requests) {
        const loops = this.pendingReasoning
            ? [
                ...this.chatLoops,
                {
                    turn: this.chatTurn,
                    reasoning: this.pendingReasoning.join('\n'),
                    text: '',
                    toolIds: [],
                },
            ]
            : this.chatLoops;
        return pairChatLoops(loops, requests);
    }
    compactedBefore(req, requests) {
        if (!req.startedAt || this.compactionMs.length === 0)
            return false;
        const start = Date.parse(req.startedAt);
        if (Number.isNaN(start))
            return false;
        const index = requests.findIndex((item) => item.id === req.id);
        const prev = index > 0 ? requests[index - 1] : undefined;
        const prevStart = prev?.startedAt ? Date.parse(prev.startedAt) : Number.NEGATIVE_INFINITY;
        return this.compactionMs.some((ms) => ms > prevStart && ms <= start);
    }
    blockAt(req, preferred) {
        return (preferred ??
            req.startedAt ??
            this.turns.get(req.turnNumber)?.startedAt ??
            this.startedAt ??
            this.source.summary.updatedAt ??
            new Date(0).toISOString());
    }
    requestView(req, requests, pairs) {
        const turn = this.turns.get(req.turnNumber);
        const status = this.requestStatus(req);
        const later = this.laterRequest(req);
        const thinking = req.thought || pairs.get(req.id)?.reasoning || '';
        const text = req.message || pairs.get(req.id)?.text || '';
        const blocks = [];
        if (thinking) {
            blocks.push({
                kind: 'thinking',
                text: thinking,
                durationMs: null,
                at: this.blockAt(req, req.thoughtAt),
            });
        }
        if (text)
            blocks.push({ kind: 'text', text, at: this.blockAt(req, req.textAt) });
        for (const id of req.toolCallIds) {
            const tool = this.tools.get(id);
            blocks.push({
                kind: 'tool-use',
                toolCallId: id,
                at: this.blockAt(req, tool?.startedAt ?? null),
            });
        }
        const last = this.requestsOf(req.turnNumber).at(-1)?.id === req.id;
        const compacted = this.compactedBefore(req, requests);
        return {
            id: req.id,
            agentId: MAIN_AGENT_ID,
            turnId: turn ? this.turnId(turn) : null,
            index: req.loopIndex + 1,
            model: turn?.model ?? this.model,
            effort: this.effort,
            startedAt: req.startedAt,
            firstBlockAt: req.firstBlockAt,
            endedAt: later?.startedAt ?? (turn?.ended ? turn.endedAt : null),
            status,
            stopReason: last && turn?.ended ? turn.stopReason : null,
            usage: this.exposedUsage(req),
            blocks,
            toolCallIds: [...req.toolCallIds],
            hasDetail: this.hasBody() && requests.at(-1)?.id === req.id,
            error: null,
            ...(compacted ? { compactedBefore: true } : {}),
        };
    }
    turnView(turn, requests) {
        const reqs = requests.filter((req) => req.turnNumber === turn.number);
        const open = !turn.ended && this.live !== 'closed';
        let status = 'unknown';
        if (open)
            status = 'running';
        else if (turn.outcome === 'interrupted')
            status = 'interrupted';
        else if (turn.outcome === 'error')
            status = 'error';
        else if (turn.ended)
            status = 'complete';
        else if (this.live === 'closed')
            status = 'interrupted';
        return {
            id: this.turnId(turn),
            agentId: MAIN_AGENT_ID,
            index: turn.number + 1,
            origin: turn.origin,
            prompt: turn.prompt,
            startedAt: turn.startedAt ?? this.startedAt ?? this.source.summary.updatedAt,
            endedAt: turn.ended ? turn.endedAt : null,
            status,
            requestIds: reqs.map((req) => req.id),
        };
    }
    toolView(tool) {
        let status = 'unknown';
        if (tool.failed)
            status = 'error';
        else if (tool.done)
            status = 'complete';
        else {
            const req = this.requests.get(tool.requestId);
            status =
                req && this.requestStatus(req) === 'in-flight' && this.live !== 'closed'
                    ? 'running'
                    : 'unknown';
        }
        const endedAt = tool.endedAt;
        const duration = tool.durationMs ??
            (tool.startedAt && endedAt
                ? Math.max(0, Date.parse(endedAt) - Date.parse(tool.startedAt))
                : null);
        return {
            id: tool.id,
            agentId: MAIN_AGENT_ID,
            requestId: tool.requestId,
            name: tool.name,
            input: tool.input,
            status,
            startedAt: tool.startedAt,
            endedAt: status === 'running' ? null : endedAt,
            durationMs: duration,
            resultPreview: tool.hasResult ? preview(tool.result) : null,
            hasFullResult: tool.hasResult,
            spawned: null,
        };
    }
    agentView(requests, tools) {
        const turns = this.sortedTurns();
        const usage = sumUsage(requests.map((req) => this.exposedUsage(req)));
        const anyRunning = turns.some((turn) => !turn.ended && this.live !== 'closed') ||
            requests.some((req) => this.requestStatus(req) === 'in-flight');
        const last = turns.at(-1);
        let status = 'unknown';
        if (anyRunning)
            status = 'running';
        else if (last?.outcome === 'error')
            status = 'error';
        else if (last?.outcome === 'interrupted')
            status = 'interrupted';
        else if (turns.length > 0)
            status = 'complete';
        return {
            id: MAIN_AGENT_ID,
            kind: 'main',
            parentId: null,
            spawnedByToolCallId: null,
            agentType: null,
            label: 'Main',
            workflowRunId: null,
            phase: null,
            model: this.model ?? last?.model ?? null,
            status,
            startedAt: turns[0]?.startedAt ?? this.startedAt,
            endedAt: anyRunning ? null : (last?.endedAt ?? null),
            usage,
            counts: { turns: turns.length, requests: requests.length, toolCalls: tools.length },
        };
    }
    sessionView(requests, tools, pairs) {
        const usage = sumUsage(requests.map((req) => this.exposedUsage(req)));
        const cwd = this.cwd ?? this.source.summary.cwd;
        const turns = this.turns.size;
        return {
            ...this.source.summary,
            id: this.source.summary.id || `grok:${this.source.nativeId}`,
            agent: 'grok',
            title: this.title,
            cwd,
            project: cwd ? basename(cwd) || cwd : this.source.summary.project,
            startedAt: this.startedAt,
            updatedAt: this.updatedAt ?? this.source.summary.updatedAt,
            live: this.live,
            model: this.model ?? this.sortedTurns().at(-1)?.model ?? null,
            // Only the latest request can be in flight, and only unfinished tools running.
            ...activityField({
                live: this.live,
                toolCalls: tools.filter((tool) => !tool.done).map((tool) => this.toolView(tool)),
                requests: requests.slice(-1).map((req) => this.requestView(req, requests, pairs)),
                lastTurn: this.lastTurnView(requests),
                updatedAt: this.updatedAt ?? this.source.summary.updatedAt,
            }),
            // The latest turn's requests are viewed newest first, as far as its last words are.
            ...lastReplyField({
                live: this.live,
                lastTurn: this.lastTurnView(requests),
                request: (id) => {
                    const req = requests.find((r) => r.id === id);
                    return req ? this.requestView(req, requests, pairs) : undefined;
                },
            }),
            usage,
            counts: {
                turns,
                requests: requests.length,
                toolCalls: this.tools.size,
                agents: 1,
            },
        };
    }
    lastTurnView(requests) {
        const turn = this.sortedTurns().at(-1);
        return turn ? this.turnView(turn, requests) : null;
    }
    diagnosticsView() {
        return {
            unknownRecordTypes: { ...this.diag.unknownRecordTypes },
            parseErrors: this.diag.parseErrors,
            unavailable: [...UNAVAILABLE],
        };
    }
}
function preview(value) {
    const text = textOf(value);
    const shown = text !== '' ? text : jsonText(value);
    return shown.slice(0, PREVIEW_CHARS);
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
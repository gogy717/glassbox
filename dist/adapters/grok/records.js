const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v) => (isObj(v) ? v : {});
/**
 * Unix seconds, unix milliseconds, or an ISO string → ISO; null when it is not a representable
 * time. Grok 1.0.67 writes the `updates.jsonl` envelope `timestamp` in seconds, `events.jsonl`
 * `ts` as ISO, and `usage.json` / `summary.json` times as ISO.
 */
export function toIso(v) {
    let ms = null;
    if (typeof v === 'string')
        ms = Date.parse(v);
    else if (typeof v === 'number' && Number.isFinite(v))
        ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
    if (ms === null || !Number.isFinite(ms))
        return null;
    const d = new Date(ms);
    // Beyond ±8.64e15 ms a Date is invalid and toISOString() would throw.
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/**
 * Grok's `inputTokens` already includes cache read and cache creation: on disk
 * `totalTokens = inputTokens + outputTokens` and `inputTokens >= cachedReadTokens + cacheCreationTokens`.
 * glassbox `input` is only the uncached slice. If a future build breaks that identity, keep the
 * raw number instead of reporting a negative.
 */
export function mapGrokUsage(raw) {
    if (!isObj(raw))
        return null;
    const inputTokens = num(raw.inputTokens) ?? 0;
    const cached = num(raw.cachedReadTokens) ?? 0;
    const created = num(raw.cacheCreationTokens) ?? 0;
    const uncached = inputTokens - cached - created;
    return {
        input: uncached >= 0 ? uncached : inputTokens,
        cacheRead: cached,
        cacheWrite: created,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: num(raw.outputTokens) ?? 0,
        thinking: num(raw.reasoningTokens) ?? 0,
        webSearch: 0,
        webFetch: 0,
    };
}
/** Text sits a few levels down at most; past this a value is not text this adapter shows. */
const TEXT_DEPTH = 64;
/** Visible text. Accepts a string, `{text}`, `{content}`, or a list of those. Drops encrypted blobs. */
export function textOf(value, depth = 0) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (depth > TEXT_DEPTH)
        return '';
    if (Array.isArray(value))
        return value
            .map((part) => textOf(part, depth + 1))
            .filter((part) => part !== '')
            .join('');
    if (!isObj(value))
        return '';
    if (typeof value.text === 'string')
        return value.text;
    if (typeof value.content === 'string')
        return value.content;
    if (value.content != null && value.content !== value)
        return textOf(value.content, depth + 1);
    return '';
}
function parseArgs(value) {
    if (typeof value !== 'string')
        return value ?? {};
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
const KNOWN_UPDATES = new Set([
    // ACP plan updates (a task list); not modelled yet.
    'plan',
    'hook_execution',
    'background_tasks',
    'task_backgrounded',
    'task_completed',
    'session_recap',
]);
const KNOWN_EVENTS = new Set([
    'phase_changed',
    'tool_started',
    'permission_requested',
    'permission_resolved',
    'mcp_server_starting',
    'mcp_server_failed',
    'mcp_server_connected',
    'mcp_config_resolved',
    'mcp_init_completed',
    'mcp_tool_call_started',
    'mcp_tool_call_completed',
]);
const USEFUL_EVENTS = new Set([
    'turn_started',
    'turn_ended',
    'loop_started',
    'first_token',
    'tool_completed',
]);
function jsonLine(line) {
    if (line.trim() === '')
        return null;
    try {
        const value = JSON.parse(line);
        return isObj(value) ? value : null;
    }
    catch {
        return null;
    }
}
function other(type, known) {
    return { kind: 'other', type, known };
}
export function parseUpdateLine(line) {
    const row = jsonLine(line);
    if (!row)
        return { kind: 'invalid' };
    const params = obj(row.params);
    const update = obj(params.update);
    const sessionUpdate = str(update.sessionUpdate);
    if (!sessionUpdate)
        return other('update', false);
    const ts = toIso(row.timestamp);
    const meta = obj(params._meta);
    const promptId = str(meta.promptId);
    const streamStartMs = num(meta.streamStartMs);
    if (sessionUpdate === 'user_message_chunk') {
        const chunkMeta = obj(update._meta);
        return {
            kind: 'user-message',
            ts,
            text: textOf(update.content),
            promptIndex: num(chunkMeta.promptIndex),
            modelId: str(chunkMeta.modelId),
        };
    }
    if (sessionUpdate === 'agent_thought_chunk' || sessionUpdate === 'agent_message_chunk') {
        const rec = {
            ts,
            text: textOf(update.content),
            promptId,
            streamStartMs,
        };
        return sessionUpdate === 'agent_thought_chunk'
            ? { kind: 'thought', ...rec }
            : { kind: 'message', ...rec };
    }
    if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
        const toolMeta = obj(obj(update._meta)['x.ai/tool']);
        const id = str(update.toolCallId) ?? str(obj(meta.updateParams).toolCallId);
        if (!id)
            return other(sessionUpdate, true);
        const status = str(update.status) ?? str(obj(meta.updateParams).status);
        if (sessionUpdate === 'tool_call') {
            return {
                kind: 'tool-call',
                ts,
                toolCallId: id,
                name: str(toolMeta.name) ?? str(update.title) ?? 'tool',
                input: update.rawInput ?? {},
                status,
                promptId,
                streamStartMs,
            };
        }
        return {
            kind: 'tool-update',
            ts,
            toolCallId: id,
            status,
            rawOutput: update.rawOutput,
            content: update.content,
            promptId,
            streamStartMs,
        };
    }
    if (sessionUpdate === 'turn_completed') {
        const usageRaw = obj(update.usage);
        return {
            kind: 'turn-completed',
            ts,
            promptId: str(update.prompt_id) ?? promptId,
            stopReason: str(update.stop_reason),
            modelCalls: num(usageRaw.modelCalls),
            usage: mapGrokUsage(update.usage),
        };
    }
    if (sessionUpdate === 'auto_compact_started')
        return { kind: 'compaction', ts, phase: 'started' };
    if (sessionUpdate === 'compaction_checkpoint')
        return { kind: 'compaction', ts, phase: 'checkpoint' };
    if (sessionUpdate === 'auto_compact_completed')
        return { kind: 'compaction', ts, phase: 'completed' };
    return other(sessionUpdate, KNOWN_UPDATES.has(sessionUpdate));
}
export function parseEventLine(line) {
    const row = jsonLine(line);
    if (!row)
        return { kind: 'invalid' };
    const type = str(row.type) ?? 'event';
    if (!USEFUL_EVENTS.has(type))
        return other(type, KNOWN_EVENTS.has(type) || type.startsWith('mcp_'));
    return {
        kind: 'event',
        type,
        known: true,
        ts: toIso(row.ts),
        turnNumber: num(row.turn_number),
        modelId: str(row.model_id),
        outcome: str(row.outcome),
        loopIndex: num(row.loop_index),
        phase: str(row.phase),
        toolName: str(row.tool_name),
        toolCallId: str(row.tool_call_id),
        durationMs: num(row.duration_ms),
    };
}
function chatToolCalls(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        const call = obj(item);
        const id = str(call.id);
        if (!id)
            continue;
        out.push({ id, name: str(call.name) ?? 'tool', input: parseArgs(call.arguments) });
    }
    return out;
}
export function parseChatLine(line) {
    const row = jsonLine(line);
    if (!row)
        return { kind: 'invalid' };
    const type = str(row.type) ?? str(row.role) ?? 'chat';
    if (type === 'system')
        return { kind: 'system', text: textOf(row.content) };
    if (type === 'user') {
        return {
            kind: 'user',
            text: textOf(row.content),
            synthetic: str(row.synthetic_reason),
            promptIndex: num(row.prompt_index),
        };
    }
    if (type === 'assistant') {
        return {
            kind: 'assistant',
            text: textOf(row.content),
            modelId: str(row.model_id),
            effort: str(row.reasoning_effort),
            toolCalls: chatToolCalls(row.tool_calls),
        };
    }
    if (type === 'reasoning') {
        return {
            kind: 'reasoning',
            text: textOf(row.summary),
            modelId: str(row.model_id),
            effort: str(row.reasoning_effort),
        };
    }
    if (type === 'tool_result') {
        const id = str(row.tool_call_id);
        if (!id)
            return other(type, true);
        return { kind: 'tool-result', toolCallId: id, content: row.content };
    }
    return other(type, false);
}
export function parseSummary(value) {
    const row = obj(value);
    const info = obj(row.info);
    const generated = str(row.generated_title);
    const summary = str(row.session_summary);
    return {
        id: str(info.id),
        cwd: str(info.cwd),
        title: generated ?? summary,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at) ?? toIso(row.last_active_at),
        model: str(row.current_model_id),
        effort: str(row.reasoning_effort),
        parentSessionId: str(row.parent_session_id),
    };
}
export function parseUsage(value) {
    const turns = obj(value).turns;
    if (!Array.isArray(turns))
        return { turns: [] };
    const out = [];
    for (const item of turns) {
        const row = obj(item);
        const turnNumber = num(row.turnNumber);
        const usage = mapGrokUsage(row);
        if (turnNumber === null || usage === null)
            continue;
        out.push({
            turnNumber,
            endedAt: toIso(row.endedAt),
            modelCalls: num(row.modelCalls),
            model: str(row.primaryModelId),
            usage,
        });
    }
    return { turns: out };
}
export function parseToolDefinitions(value) {
    return Array.isArray(value) ? value : null;
}
//# sourceMappingURL=records.js.map
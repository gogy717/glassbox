const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v) => (isObj(v) ? v : {});
/** The document's three row lists, or null when `value` is not one (rows are checked later). */
export function asDocument(value) {
    if (!isObj(value))
        return null;
    const { sessions, messages, parts } = value;
    if (!Array.isArray(sessions) || !Array.isArray(messages) || !Array.isArray(parts))
        return null;
    return { sessions, messages, parts };
}
export function isMessageRow(row) {
    return (isObj(row) &&
        typeof row.id === 'string' &&
        typeof row.session_id === 'string' &&
        typeof row.data === 'string');
}
export function isPartRow(row) {
    return isMessageRow(row) && typeof row.message_id === 'string';
}
/** Epoch milliseconds (OpenCode's only time format) → ISO; null when not a representable time. */
export function toIso(v) {
    const ms = num(v);
    if (ms === null)
        return null;
    const d = new Date(ms);
    // Beyond ±8.64e15 ms a Date is invalid and toISOString() would throw.
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/**
 * OpenCode splits usage the way glassbox does except for output: its `input` is already the
 * uncached slice (cache read and write are subtracted when it records a step), but its `output`
 * leaves reasoning out, which glassbox counts as part of output.
 */
export function mapTokens(raw) {
    if (!isObj(raw))
        return null;
    const cache = obj(raw.cache);
    const reasoning = num(raw.reasoning) ?? 0;
    return {
        input: num(raw.input) ?? 0,
        cacheRead: num(cache.read) ?? 0,
        cacheWrite: num(cache.write) ?? 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: (num(raw.output) ?? 0) + reasoning,
        thinking: reasoning,
        webSearch: 0,
        webFetch: 0,
    };
}
/** What OpenCode names a session before a title is generated: no title yet. */
const PLACEHOLDER_TITLE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The `task` tool titles a sub-agent's session "<description> (@<agent> subagent)". */
const SUBAGENT_SUFFIX = /\s*\(@[^()]+ subagent\)$/;
export function parseSessionRow(row) {
    const r = obj(row);
    const id = str(r.id);
    if (!id)
        return null;
    const rawTitle = str(r.title);
    const title = rawTitle && !PLACEHOLDER_TITLE.test(rawTitle) ? rawTitle : null;
    let model = {};
    if (typeof r.model === 'string') {
        try {
            model = obj(JSON.parse(r.model));
        }
        catch {
            // A torn model column costs the fallback model name, nothing else.
        }
    }
    return {
        id,
        parentId: str(r.parent_id),
        title,
        label: title ? str(title.replace(SUBAGENT_SUFFIX, '')) : null,
        directory: str(r.directory),
        version: str(r.version),
        agent: str(r.agent),
        model: str(model.id),
        createdAt: toIso(r.time_created),
        updatedMs: num(r.time_updated),
    };
}
function jsonData(data) {
    if (typeof data !== 'string')
        return null;
    try {
        const value = JSON.parse(data);
        return isObj(value) ? value : null;
    }
    catch {
        return null;
    }
}
function messageError(raw) {
    if (!isObj(raw))
        return null;
    const name = str(raw.name) ?? 'Error';
    const data = obj(raw.data);
    return {
        name,
        message: str(data.message) ?? name,
        status: num(data.statusCode),
        aborted: name === 'MessageAbortedError',
    };
}
export function parseMessageRow(row) {
    const data = jsonData(row.data);
    if (!data)
        return { kind: 'invalid' };
    const time = obj(data.time);
    const createdMs = num(time.created) ?? num(row.time_created);
    if (data.role === 'user') {
        return { kind: 'user', id: row.id, sessionId: row.session_id, createdMs };
    }
    if (data.role === 'assistant') {
        const variant = str(data.variant);
        return {
            kind: 'assistant',
            id: row.id,
            sessionId: row.session_id,
            parentId: str(data.parentID),
            createdMs,
            completedMs: num(time.completed),
            model: str(data.modelID),
            provider: str(data.providerID),
            agent: str(data.agent) ?? str(data.mode),
            variant: variant === 'default' ? null : variant,
            finish: str(data.finish),
            summary: data.summary === true,
            tokens: mapTokens(data.tokens),
            error: messageError(data.error),
        };
    }
    return { kind: 'other', type: `message:${str(data.role) ?? 'unknown'}`, known: false };
}
/** A pending call's input is still `{}`: its arguments so far are only the raw text. */
function toolInput(state) {
    const input = state.input;
    const empty = input === undefined || (isObj(input) && Object.keys(input).length === 0);
    if (empty && typeof state.raw === 'string' && state.raw !== '')
        return state.raw;
    return input ?? {};
}
/** Parts glassbox has no view for: attachments, snapshots, patches, retries, @agent mentions. */
const KNOWN_PARTS = new Set(['file', 'agent', 'snapshot', 'patch', 'retry']);
export function parsePartRow(row) {
    const base = {
        id: row.id,
        messageId: row.message_id,
        sessionId: row.session_id,
        createdMs: num(row.time_created),
    };
    const data = jsonData(row.data);
    if (!data)
        return { ...base, kind: 'invalid' };
    const type = str(data.type) ?? 'unknown';
    const time = obj(data.time);
    if (type === 'text') {
        return {
            ...base,
            kind: 'text',
            text: typeof data.text === 'string' ? data.text : '',
            synthetic: data.synthetic === true,
            startMs: num(time.start),
            endMs: num(time.end),
        };
    }
    if (type === 'reasoning') {
        return {
            ...base,
            kind: 'reasoning',
            text: typeof data.text === 'string' ? data.text : '',
            startMs: num(time.start),
            endMs: num(time.end),
        };
    }
    if (type === 'tool') {
        const state = obj(data.state);
        const stateTime = obj(state.time);
        const status = str(state.status);
        return {
            ...base,
            kind: 'tool',
            callId: str(data.callID),
            tool: str(data.tool) ?? 'tool',
            status,
            input: toolInput(state),
            output: typeof state.output === 'string' ? state.output : null,
            error: typeof state.error === 'string' ? state.error : null,
            startMs: num(stateTime.start),
            endMs: num(stateTime.end),
            childSessionId: str(obj(state.metadata).sessionId),
        };
    }
    if (type === 'step-start')
        return { ...base, kind: 'step-start' };
    if (type === 'step-finish') {
        return {
            ...base,
            kind: 'step-finish',
            reason: str(data.reason),
            tokens: mapTokens(data.tokens),
        };
    }
    if (type === 'subtask') {
        return { ...base, kind: 'subtask', prompt: str(data.prompt) ?? str(data.description) ?? '' };
    }
    if (type === 'compaction')
        return { ...base, kind: 'compaction' };
    return { ...base, kind: 'other', type: `part:${type}`, known: KNOWN_PARTS.has(type) };
}
//# sourceMappingURL=records.js.map
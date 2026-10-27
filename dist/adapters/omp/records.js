const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v) => (isObj(v) ? v : {});
/**
 * Unix milliseconds or an ISO string → ISO; null when it is not a representable time. omp writes
 * entry `timestamp`s as ISO and message `timestamp` / `completedAt` as milliseconds.
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
 * pi-ai `Usage`: `input` is already the uncached slice (`totalTokens = input + output +
 * cacheRead + cacheWrite`), `reasoningTokens` is the thinking subset of `output`, and Anthropic
 * splits cache writes by TTL in `cttl`. `cost` and `premiumRequests` have no place in the model;
 * `orchestration` tokens (billed, outside the conversation) are left out.
 */
export function mapOmpUsage(raw) {
    if (!isObj(raw))
        return null;
    const ttl = obj(raw.cttl);
    const server = obj(raw.server);
    const write5m = num(ttl.ephemeral5m) ?? 0;
    const write1h = num(ttl.ephemeral1h) ?? 0;
    return {
        input: num(raw.input) ?? 0,
        cacheRead: num(raw.cacheRead) ?? 0,
        cacheWrite: num(raw.cacheWrite) ?? write5m + write1h,
        cacheWrite5m: write5m,
        cacheWrite1h: write1h,
        output: num(raw.output) ?? 0,
        thinking: num(raw.reasoningTokens) ?? 0,
        webSearch: num(server.webSearch) ?? 0,
        webFetch: num(server.webFetch) ?? 0,
    };
}
/** JSON nesting kept when a value is too deep for JSON.stringify (5,000–8,000 levels). */
const JSON_DEPTH = 256;
/** JSON text of `value`, or of a copy cut off at JSON_DEPTH when it is too deep to serialise. */
export function jsonOf(value) {
    try {
        return JSON.stringify(value) ?? 'null';
    }
    catch {
        return JSON.stringify(cutOff(value, 0));
    }
}
function cutOff(value, depth) {
    if (typeof value !== 'object' || value === null)
        return value;
    if (depth >= JSON_DEPTH)
        return '[nested too deep]';
    if (Array.isArray(value))
        return value.map((v) => cutOff(v, depth + 1));
    const out = {};
    for (const [key, v] of Object.entries(value))
        out[key] = cutOff(v, depth + 1);
    return out;
}
/** Text sits a few levels down at most; past this a value is not text this adapter shows. */
const TEXT_DEPTH = 64;
/** Visible text: a string, `{text}`, or a list of those. Images and other blocks are skipped. */
export function textOf(value, depth = 0) {
    if (typeof value === 'string')
        return value;
    if (depth > TEXT_DEPTH)
        return '';
    if (Array.isArray(value))
        return value
            .map((part) => textOf(part, depth + 1))
            .filter((part) => part !== '')
            .join('\n');
    if (!isObj(value))
        return '';
    if (value.type !== undefined && value.type !== 'text')
        return '';
    return typeof value.text === 'string' ? value.text : '';
}
/** Card-form titles, `<icon> <CODE>: <title>` (`🧪 FLAKY: Fix flaky park tests`). */
const CARD_TITLE = /^(\S+) ([A-Z0-9]{1,6}: \S.*)$/su;
/**
 * The title without its card icon. omp prefixes generated titles with an emoji or a Nerd Fonts
 * glyph for its terminal panes; a browser without that font shows the glyph as a box, and the
 * icon carries nothing the code after it does not.
 */
export function cleanTitle(value) {
    const title = str(value)?.trim() ?? null;
    if (!title)
        return null;
    const card = CARD_TITLE.exec(title);
    const icon = card?.[1];
    // omp only reads an all-non-ASCII word as an icon; `A1 FIX: …` is a plain title.
    if (!icon || !card[2] || [...icon].some((c) => c.charCodeAt(0) < 0x80))
        return title;
    return card[2];
}
/** Entry types read for nothing: never shown, never counted as unknown. */
const SKIP_ENTRIES = new Set([
    // A hash of the serving account. Identity, so never surfaced.
    'credential_pin',
    'label',
    'ttsr_injection',
    'mode_change',
    'service_tier_change',
    'branch_summary',
    'reset_boundary',
]);
/** `custom` entries (extension state) read for nothing. */
const SKIP_CUSTOM = new Set(['system-prompt-digest', 'session_exit']);
/** Message roles that are context for the model, not input or output of a call. */
const CONTEXT_ROLES = new Set([
    'developer',
    'bashExecution',
    'pythonExecution',
    'branchSummary',
    'compactionSummary',
    'fileMention',
]);
function blocksOf(content) {
    if (!Array.isArray(content))
        return [];
    const out = [];
    for (const item of content) {
        const block = obj(item);
        if (block.type === 'thinking') {
            out.push({ kind: 'thinking', text: str(block.thinking) });
        }
        else if (block.type === 'redactedThinking') {
            out.push({ kind: 'thinking', text: null });
        }
        else if (block.type === 'text') {
            const text = str(block.text);
            if (text)
                out.push({ kind: 'text', text });
        }
        else if (block.type === 'toolCall') {
            const id = str(block.id);
            if (id)
                out.push({
                    kind: 'tool-call',
                    id,
                    name: str(block.name) ?? 'tool',
                    input: block.arguments ?? {},
                });
        }
    }
    return out;
}
function assistant(message) {
    const errorText = str(message.errorMessage);
    const retry = obj(message.retryRecovery);
    return {
        kind: 'assistant',
        provider: str(message.provider),
        model: str(message.model),
        api: str(message.api),
        usage: mapOmpUsage(message.usage),
        stopReason: str(message.stopReason),
        error: errorText || message.stopReason === 'error'
            ? {
                message: errorText ?? 'error',
                status: num(message.errorStatus),
                retryAttempt: num(retry.attempt),
            }
            : null,
        startedAt: toIso(message.timestamp),
        endedAt: toIso(message.completedAt),
        ttftMs: num(message.ttft),
        blocks: blocksOf(message.content),
    };
}
/** Ids a `task` call names: single (`details.results`) and async (`details.progress`) runs. */
function spawnedBy(details) {
    const out = new Map();
    const progress = Array.isArray(details.progress) ? details.progress : [];
    for (const item of progress) {
        const id = str(obj(item).id);
        if (id && !out.has(id))
            out.set(id, { id, outcome: null });
    }
    const results = Array.isArray(details.results) ? details.results : [];
    for (const item of results) {
        const row = obj(item);
        const id = str(row.id);
        if (!id)
            continue;
        const exit = num(row.exitCode);
        const outcome = row.aborted === true
            ? 'interrupted'
            : str(row.error) || (exit !== null && exit !== 0)
                ? 'error'
                : 'complete';
        out.set(id, { id, outcome });
    }
    return [...out.values()];
}
/** `details.meta` names the artifact holding the whole output of a truncated result. */
function artifactOf(details) {
    const meta = obj(details.meta);
    const id = str(obj(meta.truncation).artifactId) ?? str(obj(obj(meta.limits).columnTruncated).artifactId);
    return id && /^\d+$/.test(id) ? id : null;
}
function toolResult(message) {
    const toolCallId = str(message.toolCallId);
    if (!toolCallId)
        return null;
    const details = obj(message.details);
    return {
        kind: 'tool-result',
        toolCallId,
        toolName: str(message.toolName),
        text: textOf(message.content),
        isError: message.isError === true,
        at: toIso(message.timestamp),
        artifactId: artifactOf(details),
        spawned: message.toolName === 'task' ? spawnedBy(details) : [],
    };
}
function messageBody(raw, entryAt) {
    const message = obj(raw);
    const role = str(message.role) ?? 'unknown';
    if (role === 'user') {
        return {
            kind: 'user',
            text: textOf(message.content),
            attribution: str(message.attribution),
            synthetic: message.synthetic === true,
            at: toIso(message.timestamp) ?? entryAt,
        };
    }
    if (role === 'assistant')
        return assistant(message);
    if (role === 'toolResult')
        return toolResult(message) ?? { kind: 'unknown', type: 'message:toolResult' };
    if (role === 'custom' || role === 'hookMessage') {
        return {
            kind: 'injected',
            customType: str(message.customType),
            text: textOf(message.content),
            attribution: str(message.attribution),
            at: toIso(message.timestamp) ?? entryAt,
        };
    }
    if (CONTEXT_ROLES.has(role))
        return { kind: 'skip' };
    return { kind: 'unknown', type: `message:${role}` };
}
function stringList(value) {
    if (typeof value === 'string')
        return [value];
    if (!Array.isArray(value))
        return null;
    return value.filter((v) => typeof v === 'string');
}
function entryBody(type, row, at) {
    if (type === 'message')
        return messageBody(row.message, at);
    if (type === 'custom_message') {
        return {
            kind: 'injected',
            customType: str(row.customType),
            text: textOf(row.content),
            attribution: str(row.attribution),
            at,
        };
    }
    if (type === 'model_change')
        return { kind: 'model-change', model: str(row.model) };
    if (type === 'thinking_level_change')
        return { kind: 'thinking-change', level: str(row.thinkingLevel) };
    if (type === 'model_usage') {
        return {
            kind: 'model-usage',
            purpose: str(row.purpose),
            provider: str(row.provider),
            model: str(row.model),
            api: str(row.api),
            usage: mapOmpUsage(row.usage),
            stopReason: str(row.stopReason),
            errorMessage: str(row.errorMessage),
        };
    }
    if (type === 'compaction')
        return { kind: 'compaction' };
    if (type === 'title_change')
        return { kind: 'title-change', title: cleanTitle(row.title) };
    if (type === 'session_init') {
        return {
            kind: 'session-init',
            agent: str(row.agent),
            task: typeof row.task === 'string' ? row.task : '',
            systemPrompt: stringList(row.systemPrompt),
            tools: stringList(row.tools),
        };
    }
    if (type === 'custom') {
        const customType = str(row.customType) ?? 'custom';
        if (customType === 'tool_execution_start') {
            const data = obj(row.data);
            const toolCallId = str(data.toolCallId);
            if (toolCallId)
                return { kind: 'tool-start', toolCallId, at: toIso(data.startedAt) ?? at };
        }
        if (SKIP_CUSTOM.has(customType))
            return { kind: 'skip' };
        return { kind: 'unknown', type: `custom:${customType}` };
    }
    if (SKIP_ENTRIES.has(type))
        return { kind: 'skip' };
    return { kind: 'unknown', type };
}
/** Never throws. A blank or non-JSON line is `invalid`. */
export function parseOmpLine(line) {
    if (line.trim() === '')
        return { kind: 'invalid' };
    let raw;
    try {
        raw = JSON.parse(line);
    }
    catch {
        return { kind: 'invalid' };
    }
    if (!isObj(raw))
        return { kind: 'invalid' };
    const type = str(raw.type);
    if (!type)
        return { kind: 'invalid' };
    if (type === 'title') {
        return { kind: 'title-slot', title: cleanTitle(raw.title), updatedAt: toIso(raw.updatedAt) };
    }
    if (type === 'session') {
        const id = str(raw.id);
        if (!id)
            return { kind: 'unknown', type };
        return {
            kind: 'header',
            id,
            cwd: str(raw.cwd),
            startedAt: toIso(raw.timestamp),
            title: cleanTitle(raw.title),
            parentSession: str(raw.parentSession),
        };
    }
    const id = str(raw.id);
    // Without an id an entry has no place in the tree.
    if (!id)
        return { kind: 'unknown', type };
    const timestamp = toIso(raw.timestamp);
    const node = {
        id,
        parentId: str(raw.parentId),
        timestamp,
        version: str(obj(raw.runtime).version),
    };
    if (raw.activeLeafId === null || typeof raw.activeLeafId === 'string')
        node.activeLeafId = raw.activeLeafId;
    return { kind: 'entry', node, body: entryBody(type, raw, timestamp) };
}
//# sourceMappingURL=records.js.map
const GUIDELINES = [
    'Read the code you change before changing it.',
    'Keep each change small, and say what it does.',
    'Run the tests that cover a change before calling it done.',
    'Prefer the project’s own helpers to new ones.',
    'Ask before anything that cannot be undone.',
    'Write comments that say why, not what.',
];
/** About 1,500 tokens: smaller than a real one, the same order of size against a request. */
const SYSTEM = [
    'You are a coding agent working in a demo repository (demo).',
    '',
    ...Array.from({ length: 48 }, (_, i) => `- ${GUIDELINES[i % GUIDELINES.length]} (rule ${i + 1})`),
].join('\n');
/** The demo's tools, each described at a length a real definition has. */
const TOOL_DOCS = {
    Bash: [
        'Runs a shell command and returns its output.',
        { command: 'string', description: 'string' },
    ],
    Read: [
        'Reads a file, numbered by line.',
        { file_path: 'string', offset: 'number', limit: 'number' },
    ],
    Edit: [
        'Replaces one string in a file.',
        { file_path: 'string', old_string: 'string', new_string: 'string' },
    ],
    MultiEdit: ['Makes several replacements in one file.', { file_path: 'string', edits: 'array' }],
    Write: ['Writes a file, replacing it if it exists.', { file_path: 'string', content: 'string' }],
    NotebookEdit: [
        'Replaces, adds or deletes one notebook cell.',
        { notebook_path: 'string', new_source: 'string' },
    ],
    Grep: ['Searches files for a pattern.', { pattern: 'string', path: 'string' }],
    WebFetch: [
        'Fetches a page and answers a question about it.',
        { url: 'string', prompt: 'string' },
    ],
    Agent: ['Starts a sub-agent on a task of its own.', { description: 'string', prompt: 'string' }],
    Workflow: ['Runs a script of agents in phases.', { script: 'string' }],
};
const TOOLS = Object.entries(TOOL_DOCS).map(([name, [summary, props]]) => ({
    name,
    description: [
        `${summary} (demo)`,
        '',
        'Usage notes:',
        ...Array.from({ length: 14 }, (_, i) => `- Note ${i + 1} on using ${name} well (demo).`),
    ].join('\n'),
    input_schema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])),
        required: [Object.keys(props)[0]],
    },
}));
/** Lines a whole file of the demo has, by name; others have `LINES`. */
const FILE_LINES = { 'store.ts': 220, 'model.ts': 160 };
const LINES = 120;
/** A read's result: its preview, then numbered filler up to the lines it read. */
function readResult(call) {
    const input = (call.input ?? {});
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    const name = path.slice(path.lastIndexOf('/') + 1);
    const from = typeof input.offset === 'number' ? input.offset : 1;
    const count = typeof input.limit === 'number' ? input.limit : (FILE_LINES[name] ?? LINES);
    const lines = Array.from({ length: count }, (_, i) => `${from + i}\t// ${name}, line ${from + i} (demo filler)`);
    return [call.resultPreview ?? '', ...lines].join('\n');
}
function resultBlock(call) {
    return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: call.name === 'Read' ? readResult(call) : (call.resultPreview ?? ''),
        ...(call.status === 'error' ? { is_error: true } : {}),
    };
}
/** A reply as sent back: thinking as a signature its size, text, tool calls. */
function assistantMessage(req, calls) {
    const thinking = req.usage?.thinking ?? 0;
    const content = [];
    if (thinking > 0)
        content.push({
            type: 'thinking',
            thinking: '',
            signature: 'A'.repeat(Math.round((thinking * 16) / 3)),
        });
    for (const b of req.blocks)
        if (b.kind === 'text')
            content.push({ type: 'text', text: b.text });
    for (const id of req.toolCallIds) {
        const call = calls.get(id);
        if (call)
            content.push({ type: 'tool_use', id, name: call.name, input: call.input });
    }
    return { role: 'assistant', content };
}
const byStart = (a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.index - b.index;
/** What `requestId` sent, or null when the snapshot has no such request. */
export function demoRequestDetail(snapshot, requestId) {
    const request = snapshot.requests.find((r) => r.id === requestId);
    if (!request)
        return null;
    const agentId = request.agentId;
    const calls = new Map(snapshot.toolCalls.map((t) => [t.id, t]));
    const requests = snapshot.requests.filter((r) => r.agentId === agentId).sort(byStart);
    const turns = snapshot.turns
        .filter((t) => t.agentId === agentId)
        .sort((a, b) => a.index - b.index);
    const messages = [];
    outer: for (const turn of turns) {
        messages.push({ role: 'user', content: turn.prompt });
        for (const req of requests.filter((r) => r.turnId === turn.id)) {
            if (req.id === requestId)
                break outer;
            messages.push(assistantMessage(req, calls));
            const done = req.toolCallIds
                .map((id) => calls.get(id))
                .filter((c) => !!c && c.status !== 'running');
            if (done.length > 0)
                messages.push({ role: 'user', content: done.map(resultBlock) });
        }
    }
    return {
        requestId,
        completeness: 'full',
        notes: [],
        params: { model: request.model, max_tokens: 64000, output_config: { effort: request.effort } },
        system: [{ type: 'text', text: SYSTEM }],
        tools: TOOLS,
        messages,
    };
}
//# sourceMappingURL=demo-detail.js.map
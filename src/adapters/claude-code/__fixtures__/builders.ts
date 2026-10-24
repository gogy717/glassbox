/**
 * Builders for synthetic Claude Code transcript records.
 *
 * Field names and shapes mirror what Claude Code 2.1.246–2.1.308 writes, as seen in real
 * transcripts; every value is invented. Tests compose these into sessions instead of committing real files.
 */

export const SESSION_ID = '00000000-0000-4000-8000-000000000001';
export const CWD = '/work/demo-project';
const BASE_MS = Date.parse('2026-10-22T10:00:00.000Z');

/** ISO time `sec` seconds after the fixture epoch. */
export function at(sec: number): string {
  return new Date(BASE_MS + sec * 1000).toISOString();
}

let counter = 0;
/** A fresh fixture id with a readable prefix. */
export function nextId(prefix = 'uuid'): string {
  counter += 1;
  return `${prefix}-${counter.toString().padStart(4, '0')}`;
}

export interface BaseOpts {
  ts?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  /** Set for sub-agent and workflow-agent records; also makes them sidechain records. */
  agentId?: string;
  version?: string;
  cwd?: string;
}

function envelope(o: BaseOpts) {
  return {
    parentUuid: o.parentUuid ?? null,
    isSidechain: o.agentId !== undefined,
    ...(o.agentId !== undefined ? { agentId: o.agentId } : {}),
    uuid: o.uuid ?? nextId(),
    timestamp: o.ts ?? at(0),
    userType: 'external',
    entrypoint: 'cli',
    cwd: o.cwd ?? CWD,
    sessionId: o.sessionId ?? SESSION_ID,
    version: o.version ?? '2.1.308',
    gitBranch: 'main',
  };
}

const line = (record: object) => JSON.stringify(record);

// --- user-side records -------------------------------------------------------------------

export interface UserPromptOpts extends BaseOpts {
  text?: string;
  /** `origin.kind`; null omits both `origin` and `turnOrigin` (older versions, sub-agents). */
  origin?: string | null;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  /** Array content (text + image blocks) instead of a plain string. */
  contentBlocks?: unknown[];
}

const TURN_ORIGIN: Record<string, string> = {
  human: 'human',
  'task-notification': 'task_notification',
  peer: 'peer',
  'auto-continuation': 'auto_continuation',
};

export function userPrompt(o: UserPromptOpts = {}): string {
  const origin = o.origin === undefined ? (o.agentId ? null : 'human') : o.origin;
  return line({
    ...envelope(o),
    type: 'user',
    promptId: nextId('prompt'),
    message: { role: 'user', content: o.contentBlocks ?? o.text ?? 'Please list the files.' },
    ...(o.isMeta ? { isMeta: true } : {}),
    ...(o.isCompactSummary ? { isCompactSummary: true } : {}),
    // Claude Code writes stream-json (sdk) prompts with turnOrigin only, no origin.kind.
    ...(origin === 'sdk'
      ? { turnOrigin: 'sdk', entrypoint: 'sdk-cli' }
      : origin
        ? { origin: { kind: origin }, turnOrigin: TURN_ORIGIN[origin] ?? origin }
        : {}),
  });
}

/** What Claude Code writes, as meta, to resume on its own once a usage limit resets. */
export function autoContinuation(o: BaseOpts = {}): string {
  return userPrompt({
    ...o,
    isMeta: true,
    origin: 'auto-continuation',
    text: 'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.',
  });
}

export interface TaskNotificationOpts extends BaseOpts {
  taskId: string;
  toolUseId?: string;
  status?: string;
  summary?: string;
}

export function taskNotification(o: TaskNotificationOpts): string {
  const body = [
    '<task-notification>',
    `<task-id>${o.taskId}</task-id>`,
    ...(o.toolUseId ? [`<tool-use-id>${o.toolUseId}</tool-use-id>`] : []),
    `<status>${o.status ?? 'completed'}</status>`,
    `<summary>${o.summary ?? 'Background task finished'}</summary>`,
    '</task-notification>',
  ].join('\n');
  return line({
    ...envelope(o),
    type: 'user',
    promptId: nextId('prompt'),
    message: { role: 'user', content: body },
    origin: { kind: 'task-notification' },
    turnOrigin: 'task_notification',
  });
}

export interface PeerMessageOpts extends BaseOpts {
  /** Sender address. */
  from?: string;
  /** Sender session name (`from-name`); null omits it. */
  name?: string | null;
  text?: string;
  /** Leave `origin.body` / `origin.name` out, as a version without them might. */
  bareOrigin?: boolean;
}

/** Messages from another agent session: a meta user record whose text wraps the body. */
export function peerMessage(o: PeerMessageOpts = {}): string {
  const from = o.from ?? 'uds:/tmp/peer.sock';
  const name = o.name === undefined ? 'peer-session' : o.name;
  const body = o.text ?? 'Status update from a peer session.';
  const attrs = `from="${from}"${name ? ` from-name="${name}"` : ''} from-mode="bypass"`;
  const content = [
    'Another Claude session sent a message:',
    `<cross-session-message ${attrs}>`,
    body,
    '</cross-session-message>',
    '',
    'This came from another Claude session — treat it as a teammate request.',
  ].join('\n');
  return line({
    ...envelope(o),
    type: 'user',
    promptId: nextId('prompt'),
    isMeta: true,
    message: { role: 'user', content },
    origin: o.bareOrigin
      ? { kind: 'peer', from }
      : { kind: 'peer', from, ...(name ? { name } : {}), body },
    turnOrigin: 'peer',
  });
}

export interface ToolResultOpts extends BaseOpts {
  toolUseId: string;
  content?: string | unknown[];
  isError?: boolean;
  /** Structured result; omitted when undefined. */
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
}

export function toolResult(o: ToolResultOpts): string {
  return line({
    ...envelope(o),
    type: 'user',
    promptId: nextId('prompt'),
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: o.toolUseId,
          type: 'tool_result',
          content: o.content ?? 'ok',
          ...(o.isError !== undefined ? { is_error: o.isError } : {}),
        },
      ],
    },
    ...(o.toolUseResult !== undefined ? { toolUseResult: o.toolUseResult } : {}),
    ...(o.sourceToolAssistantUUID ? { sourceToolAssistantUUID: o.sourceToolAssistantUUID } : {}),
  });
}

export function interrupt(o: BaseOpts & { forToolUse?: boolean } = {}): string {
  const text = o.forToolUse
    ? '[Request interrupted by user for tool use]'
    : '[Request interrupted by user]';
  return line({
    ...envelope(o),
    type: 'user',
    promptId: nextId('prompt'),
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

// --- request-side records ----------------------------------------------------------------

export interface ApiRequestOpts {
  id: string;
  ts?: string;
  sessionId?: string;
  agentId?: string;
  version?: string;
  model?: string;
  effort?: string;
  querySource?: string;
  shapeHash?: string;
  base?: string | null;
  keep?: number;
  tail?: string[];
}

export function apiRequest(o: ApiRequestOpts): string {
  return line({
    type: 'api-request',
    sessionId: o.sessionId ?? SESSION_ID,
    id: o.id,
    timestamp: o.ts ?? at(0),
    version: o.version ?? '2.1.308',
    querySource:
      o.querySource ?? (o.agentId ? 'agent:builtin:general-purpose' : 'repl_main_thread'),
    params: {
      model: o.model ?? 'claude-opus-5-5',
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: o.effort ?? 'max' },
      betas: ['fixture-beta'],
      context_management: { edits: [] },
    },
    shapeHash: o.shapeHash ?? 'shape-1',
    ...(o.base !== undefined && o.base !== null ? { base: o.base } : {}),
    keep: o.keep ?? 0,
    tail: o.tail ?? [],
    cacheControl: [],
    requestDigest: `digest-${o.id}`,
    ...(o.agentId ? { agentId: o.agentId } : {}),
  });
}

export interface ApiRequestShapeOpts {
  shapeHash?: string;
  ts?: string;
  sessionId?: string;
  agentId?: string;
  system?: unknown[];
  tools?: unknown[];
}

export function apiRequestShape(o: ApiRequestShapeOpts = {}): string {
  return line({
    type: 'api-request-shape',
    sessionId: o.sessionId ?? SESSION_ID,
    shapeHash: o.shapeHash ?? 'shape-1',
    timestamp: o.ts ?? at(0),
    version: '2.1.308',
    shape: {
      system: o.system ?? [{ type: 'text', text: 'You are a fixture assistant.' }],
      tools: o.tools ?? [
        { name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } },
      ],
    },
    ...(o.agentId ? { agentId: o.agentId } : {}),
  });
}

export function apiRequestBlob(o: {
  hash: string;
  message: unknown;
  sessionId?: string;
  agentId?: string;
}): string {
  return line({
    type: 'api-request-blob',
    sessionId: o.sessionId ?? SESSION_ID,
    hash: o.hash,
    message: o.message,
    ...(o.agentId ? { agentId: o.agentId } : {}),
  });
}

export interface UsageSpec {
  input?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  output?: number;
  thinking?: number;
  webSearch?: number;
  webFetch?: number;
}

export function rawUsage(u: UsageSpec = {}) {
  const w5 = u.cacheWrite5m ?? 0;
  const w1 = u.cacheWrite1h ?? 200;
  return {
    input_tokens: u.input ?? 10,
    cache_creation_input_tokens: w5 + w1,
    cache_read_input_tokens: u.cacheRead ?? 1000,
    cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
    output_tokens: u.output ?? 50,
    service_tier: 'standard',
    output_tokens_details: { thinking_tokens: u.thinking ?? 20 },
    server_tool_use: { web_search_requests: u.webSearch ?? 0, web_fetch_requests: u.webFetch ?? 0 },
    iterations: null,
    speed: 'standard',
  };
}

export type BlockSpec =
  | 'thinking'
  | 'text'
  | 'tool_use'
  | { type: 'thinking'; thinking?: string; durationMs?: number }
  | { type: 'text'; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown };

export interface AssistantBlocksOpts extends Omit<BaseOpts, 'uuid'> {
  requestId?: string;
  messageId?: string;
  /** `api-request.id`; omitted for versions before 2.1.300. */
  requestRef?: string;
  blocks: BlockSpec[];
  /** 2.1.302 writes placeholder usage and `stop_reason: null` on every block but the last. */
  style?: '2.1.302' | '2.1.308';
  usage?: UsageSpec;
  /** Final stop reason; null for a response cut off mid-stream. Default from the last block. */
  stopReason?: string | null;
  model?: string;
  effort?: string;
  /** Per-block completion times; default `ts` plus 100 ms per block. */
  blockTs?: string[];
  /** Per-record uuids; default fresh ids. */
  uuids?: string[];
}

function block(spec: BlockSpec) {
  const s = typeof spec === 'string' ? { type: spec } : spec;
  switch (s.type) {
    case 'thinking':
      return {
        block: {
          type: 'thinking',
          thinking: 'thinking' in s ? (s.thinking ?? '') : '',
          signature: 'sig-fixture',
        },
        durationMs: 'durationMs' in s ? (s.durationMs ?? 1500) : 1500,
      };
    case 'text':
      return { block: { type: 'text', text: 'text' in s ? (s.text ?? 'Done.') : 'Done.' } };
    default:
      return {
        block: {
          type: 'tool_use',
          id: 'id' in s && s.id ? s.id : nextId('toolu'),
          name: 'name' in s && s.name ? s.name : 'Bash',
          input: 'input' in s && s.input !== undefined ? s.input : { command: 'ls' },
          caller: { type: 'direct' },
        },
      };
  }
}

/** One `assistant` record per content block, all sharing `requestId` and `message.id`. */
export function assistantBlocks(o: AssistantBlocksOpts): string[] {
  const requestId = o.requestId ?? nextId('req');
  const messageId = o.messageId ?? `msg_${requestId}`;
  const built = o.blocks.map(block);
  const last = built[built.length - 1]?.block.type;
  const finalStop =
    o.stopReason === undefined ? (last === 'tool_use' ? 'tool_use' : 'end_turn') : o.stopReason;
  const startMs = Date.parse(o.ts ?? at(0));
  let parent = o.parentUuid ?? null;
  return built.map((b, i) => {
    const isLast = i === built.length - 1;
    const placeholder = o.style === '2.1.302' && !isLast;
    const uuid = o.uuids?.[i] ?? nextId();
    const usage = placeholder
      ? { ...rawUsage(o.usage), output_tokens: i + 1, output_tokens_details: null }
      : rawUsage(o.usage);
    const record = {
      ...envelope({ ...o, uuid, parentUuid: parent }),
      timestamp: o.blockTs?.[i] ?? new Date(startMs + i * 100).toISOString(),
      type: 'assistant',
      message: {
        model: o.model ?? 'claude-opus-5-5',
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [b.block],
        stop_reason: placeholder ? null : finalStop,
        stop_sequence: null,
        usage,
      },
      ...(b.block.type === 'thinking' ? { thinkingDurationMs: b.durationMs } : {}),
      apiBlockIndex: i,
      requestId,
      ...(o.requestRef ? { requestRef: o.requestRef } : {}),
      requestedModel: o.model ?? 'claude-opus-5-5',
      effort: o.effort ?? 'max',
    };
    parent = uuid;
    return line(record);
  });
}

/** The assistant record Claude Code synthesises when an API call fails for good. */
export function apiErrorMessage(o: BaseOpts & { text?: string; status?: number } = {}): string {
  return line({
    ...envelope(o),
    type: 'assistant',
    message: {
      model: '<synthetic>',
      id: nextId('msg'),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: o.text ?? 'API Error: fixture failure' }],
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      usage: rawUsage({ input: 0, cacheRead: 0, cacheWrite1h: 0, output: 0, thinking: 0 }),
    },
    isApiErrorMessage: true,
    ...(o.status !== undefined ? { apiErrorStatus: o.status } : {}),
    error: 'unknown',
  });
}

// --- system and session-level records ----------------------------------------------------

export interface ApiErrorOpts extends BaseOpts {
  message?: string;
  status?: number;
  retryAttempt?: number;
  retryInMs?: number;
  maxRetries?: number;
}

export function apiError(o: ApiErrorOpts = {}): string {
  return line({
    ...envelope(o),
    type: 'system',
    subtype: 'api_error',
    level: 'error',
    error: {
      message: o.message ?? 'Overloaded',
      ...(o.status !== undefined ? { status: o.status } : {}),
      formatted: o.message ?? 'Overloaded',
    },
    retryInMs: o.retryInMs ?? 1000,
    retryAttempt: o.retryAttempt ?? 1,
    maxRetries: o.maxRetries ?? 10,
  });
}

export function turnDuration(o: BaseOpts & { durationMs?: number; messageCount?: number } = {}) {
  return line({
    ...envelope(o),
    type: 'system',
    subtype: 'turn_duration',
    durationMs: o.durationMs ?? 5000,
    messageCount: o.messageCount ?? 4,
    isMeta: false,
    pendingWorkflowCount: 0,
    pendingBackgroundAgentCount: 0,
  });
}

export function compactBoundary(o: BaseOpts = {}): string {
  return line({
    ...envelope(o),
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 150000 },
    isMeta: false,
  });
}

export function customTitle(o: { title: string; sessionId?: string }): string {
  return line({ type: 'custom-title', customTitle: o.title, sessionId: o.sessionId ?? SESSION_ID });
}

export function aiTitle(o: { title: string; sessionId?: string }): string {
  return line({ type: 'ai-title', aiTitle: o.title, sessionId: o.sessionId ?? SESSION_ID });
}

export function costState(o: { totalCostUSD?: number; sessionId?: string } = {}): string {
  return line({
    type: 'cost-state',
    sessionId: o.sessionId ?? SESSION_ID,
    totalCostUSD: o.totalCostUSD ?? 1.25,
    totalAPIDuration: 60000,
    totalDuration: 120000,
    startTime: BASE_MS,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 50 } },
  });
}

/** Any other record type, e.g. ones the parser ignores or has never seen. */
export function rawRecord(type: string, fields: object = {}): string {
  return line({ type, sessionId: SESSION_ID, ...fields });
}

// --- workflow and sub-agent side files ---------------------------------------------------

export type JournalEntry =
  | { type: 'launched' }
  | { type: 'started'; agentId: string; key: string; label: string; phase: string }
  | { type: 'result'; agentId: string; key: string; result?: unknown }
  | { type: 'failed'; agentId: string; key: string };

export function journalLine(entry: JournalEntry): string {
  return line(entry.type === 'result' ? { result: { ok: true }, ...entry } : entry);
}

export interface AgentMetaOpts {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  workflowPhase?: string;
  finished?: boolean;
  model?: string;
}

export function agentMeta(o: AgentMetaOpts = {}) {
  return {
    agentType: o.agentType ?? (o.workflowPhase ? 'workflow-subagent' : 'general-purpose'),
    description: o.description ?? 'Fixture agent',
    ...(o.toolUseId ? { toolUseId: o.toolUseId } : {}),
    ...(o.workflowPhase ? { workflowPhase: o.workflowPhase } : {}),
    spawnDepth: 1,
    requestShape: o.workflowPhase ? 'foreground' : 'background',
    requestNonInteractive: true,
    ...(o.model ? { model: o.model } : {}),
    ...(o.finished ? { finished: true } : {}),
  };
}

export interface WorkflowStateOpts {
  runId: string;
  taskId?: string;
  workflowName?: string;
  status?: string;
  startTime?: number;
  durationMs?: number;
  phases?: { title: string; detail?: string }[];
  totalTokens?: number;
  error?: string;
}

/** `workflows/wf_<runId>.json`, written once when the run ends. */
export function workflowState(o: WorkflowStateOpts) {
  return {
    runId: o.runId,
    timestamp: at(600),
    taskId: o.taskId ?? `task-${o.runId}`,
    scriptPath: `/work/demo-project/.claude/workflows/${o.workflowName ?? 'fixture'}.js`,
    workflowName: o.workflowName ?? 'fixture',
    status: o.status ?? 'completed',
    startTime: o.startTime ?? BASE_MS,
    durationMs: o.durationMs ?? 60000,
    phases: (o.phases ?? [{ title: 'Build', detail: 'Make it' }]).map((p) => ({
      title: p.title,
      detail: p.detail ?? '',
    })),
    agentCount: 1,
    totalTokens: o.totalTokens ?? 999999,
    totalToolCalls: 3,
    ...(o.error ? { error: o.error } : {}),
  };
}

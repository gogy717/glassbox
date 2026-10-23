/**
 * Agent-neutral data model.
 *
 * Adapters translate each agent's native session records into these entities; the server
 * and the web UI only ever see these types. Every entity is keyed by a string id so live
 * updates can be applied as upserts.
 *
 * CONTRACT: every adapter, the server and the web UI depend on this file; change it on its
 * own, with all of them updated together.
 */

/** Which agent produced a session. Only 'claude-code' exists today; others come later. */
export type AgentKind = 'claude-code' | (string & {});

/** ISO-8601 timestamp, e.g. "2026-10-22T15:33:27.018Z". */
export type IsoTime = string;

/**
 * Whether the agent process that owns a session is running right now. 'waiting' = the process
 * is blocked on the user (e.g. a permission prompt); treat it like 'busy' when sorting.
 */
export type LiveState = 'busy' | 'waiting' | 'idle' | 'closed' | 'unknown';

export interface TokenUsage {
  /** Uncached input tokens. */
  input: number;
  cacheRead: number;
  /** All cache-creation tokens. Equals cacheWrite5m + cacheWrite1h when the split is known. */
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** All output tokens, thinking included. */
  output: number;
  /** Thinking tokens; a subset of `output`. */
  thinking: number;
  webSearch: number;
  webFetch: number;
}

export interface SessionCounts {
  turns: number;
  requests: number;
  toolCalls: number;
  agents: number;
}

export interface SessionSummary {
  /** Globally unique: `${agent}:${nativeId}`. */
  id: string;
  agent: AgentKind;
  /** The agent's own session id. */
  nativeId: string;
  title: string | null;
  cwd: string | null;
  /** Short display name used to group sessions, e.g. the last path segment of `cwd`. */
  project: string;
  startedAt: IsoTime | null;
  updatedAt: IsoTime;
  live: LiveState;
  /** Agent version that last wrote the session, e.g. "2.1.308". */
  version: string | null;
  model: string | null;
  /** Session-wide usage including all sub-agents. Null until the session has been fully parsed. */
  usage: TokenUsage | null;
  counts: SessionCounts | null;
  /**
   * Free-form markers set by the adapter. Known: 'probe' — a tool's background probe session
   * (e.g. ClaudeBar's "ClaudeBar Probe"), hidden by default in the UI.
   */
  tags?: string[];
  /**
   * What a live session is doing right now, from the parser of an open session. The server
   * opens running sessions in the background, so they usually carry it. Absent when nothing is
   * known: a closed session, one not opened, or an older server. The UI then shows `live`.
   */
  activity?: SessionActivity;
}

/**
 * - 'tool': a tool call is running.
 * - 'thinking': the model has the floor. A call is in flight with no reply text yet, or the
 *   agent is busy mid-turn with no tool running and no call on record yet.
 * - 'writing': a call in flight has started its reply text.
 * - 'waiting': the agent is blocked on the person (`live === 'waiting'`), e.g. a permission
 *   prompt for `tool`.
 * - 'idle': the process is up, between turns.
 */
export type ActivityKind = 'tool' | 'thinking' | 'writing' | 'waiting' | 'idle';

/**
 * Structured so the UI words and localises it ("Reading tokens.css", "Thinking · 1:12"). The
 * server sends no sentences.
 */
export interface SessionActivity {
  kind: ActivityKind;
  /** The tool as the agent names it ("Read", "shell", "read"), for 'tool' and 'waiting'. */
  tool: string | null;
  /** What the tool works on, short: a file name, a command, a pattern, a host. Null if unknown. */
  target: string | null;
  /** Who is doing it: `MAIN_AGENT_ID`, or the sub-agent whose work started last. */
  agentId: string;
  /** When it started: the tool call, the model call, the turn's last step, or the idle spell. */
  since: IsoTime | null;
}

/** Whose plan the numbers belong to: the model vendor, not the agent tool. */
export type QuotaProvider =
  | 'anthropic'
  | 'openai'
  | 'xai'
  | 'github-copilot'
  | 'deepseek'
  | (string & {});

/** One rate-limit window of the user's plan, as last reported. */
export interface QuotaWindow {
  /** Stable key within its snapshot, e.g. "five_hour", "weekly:Opus", "copilot:chat". */
  id: string;
  kind: 'session' | 'weekly' | 'weekly-model' | 'monthly' | 'other';
  /** The provider's own name for the window ("SuperGrok Weekly Credits"); null: name it by `kind`. */
  label: string | null;
  /** Model display name for 'weekly-model' windows. */
  model: string | null;
  /** 0..100. */
  usedPercent: number;
  resetsAt: IsoTime | null;
}

/** Plan quota of one provider account. */
export interface QuotaSnapshot {
  provider: QuotaProvider;
  /**
   * The agent whose cache, session log or sign-in the numbers came from; null when glassbox asked
   * the provider with a key of its own (e.g. DEEPSEEK_API_KEY).
   */
  agent: AgentKind | null;
  /** Plan name when the source states it, e.g. "Max", "SuperGrok", "Copilot Individual". */
  plan: string | null;
  /** When the numbers were fetched from the provider (not when glassbox read them). */
  fetchedAt: IsoTime;
  /** True when `fetchedAt` is more than an hour old. */
  stale: boolean;
  windows: QuotaWindow[];
  /** Pay-as-you-go usage beyond the plan, when enabled. Amounts in major units. */
  extraUsage: { used: number; limit: number | null; currency: string | null } | null;
  /** Prepaid credit left on a pay-as-you-go account (DeepSeek). Major units. */
  balance: { amount: number; currency: string } | null;
  /** Where the numbers came from: a source id below, or a new one the UI shows as is. */
  source: string;
}

/** Lifecycle of turns, agents and workflow runs. */
export type RunStatus = 'running' | 'complete' | 'error' | 'interrupted' | 'unknown';

export type AgentNodeKind = 'main' | 'subagent' | 'workflow-agent';

/** Id of the root agent of every session. */
export const MAIN_AGENT_ID = 'main';

export interface AgentNode {
  /** `MAIN_AGENT_ID` for the root agent, otherwise the agent's native id. */
  id: string;
  kind: AgentNodeKind;
  /** Null only for the main agent. */
  parentId: string | null;
  /** The tool call in the parent agent that spawned this agent, when known. */
  spawnedByToolCallId: string | null;
  /** e.g. "general-purpose", "Explore", "workflow-subagent". */
  agentType: string | null;
  /** Human label: sub-agent description or workflow agent label. "Main" for the root. */
  label: string;
  workflowRunId: string | null;
  /** Workflow phase title, for workflow agents. */
  phase: string | null;
  model: string | null;
  status: RunStatus;
  startedAt: IsoTime | null;
  endedAt: IsoTime | null;
  /** This agent's own usage, excluding its descendants. */
  usage: TokenUsage;
  counts: { turns: number; requests: number; toolCalls: number };
}

/**
 * Where a turn's input came from: a person, a background-task notification, a sub-agent's
 * initial prompt, a message from another agent session, the agent resuming on its own once a
 * usage limit reset ('auto-continuation', never a title), or anything else.
 */
export type TurnOrigin =
  | 'human'
  | 'task-notification'
  | 'agent-prompt'
  | 'peer'
  | 'auto-continuation'
  | 'other';

/** One input to an agent (a human prompt, a task notification, a sub-agent's initial prompt). */
export interface Turn {
  id: string;
  agentId: string;
  /** 1-based, per agent, in chronological order. */
  index: number;
  origin: TurnOrigin;
  /** The input text with transport wrappers removed (e.g. the body of a peer message). */
  prompt: string;
  /** Who sent it when not the human: a peer session name, a task id, … */
  sender?: string | null;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  status: RunStatus;
  requestIds: string[];
}

export type RequestStatus = 'in-flight' | 'complete' | 'error' | 'interrupted';

export type ResponseBlock =
  | { kind: 'thinking'; text: string | null; durationMs: number | null; at: IsoTime }
  | { kind: 'text'; text: string; at: IsoTime }
  | { kind: 'tool-use'; toolCallId: string; at: IsoTime };

/** One model API call. */
export interface ModelRequest {
  /**
   * Stable for the whole life of the request, so the in-flight and the completed request are
   * the same entity. Claude Code: the `api-request` record id when one exists (≥ 2.1.300),
   * otherwise `requestId`, otherwise `message.id`.
   */
  id: string;
  agentId: string;
  turnId: string | null;
  /** 1-based within its turn. */
  index: number;
  model: string | null;
  /** e.g. "low" | "medium" | "high" | "xhigh" | "max". */
  effort: string | null;
  startedAt: IsoTime | null;
  /** When the first response block completed. */
  firstBlockAt: IsoTime | null;
  endedAt: IsoTime | null;
  status: RequestStatus;
  stopReason: string | null;
  /** Final usage for the request, counted once. Null while in flight. */
  usage: TokenUsage | null;
  blocks: ResponseBlock[];
  toolCallIds: string[];
  /** True when `RequestDetail` can be fetched for this request. */
  hasDetail: boolean;
  error: { message: string; status: number | null; retryAttempt: number | null } | null;
  /** True on the first request after the agent's context was compacted. */
  compactedBefore?: boolean;
}

export type ToolStatus = 'running' | 'complete' | 'error' | 'unknown';

export type SpawnRef = { kind: 'agent'; agentId: string } | { kind: 'workflow'; runId: string };

export interface ToolCall {
  /** The agent's tool-use id. */
  id: string;
  agentId: string;
  requestId: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  startedAt: IsoTime | null;
  endedAt: IsoTime | null;
  durationMs: number | null;
  /** First ≤ 500 characters of the result as text. */
  resultPreview: string | null;
  /** True when the full result can be fetched separately. */
  hasFullResult: boolean;
  /** Set when this call launched a sub-agent or a workflow run. */
  spawned: SpawnRef | null;
}

/** A multi-agent orchestration run (Claude Code: the Workflow tool, "ultracode"). */
export interface WorkflowRun {
  id: string;
  name: string | null;
  taskId: string | null;
  toolCallId: string | null;
  parentAgentId: string;
  status: RunStatus;
  phases: { title: string; detail: string | null }[];
  agentIds: string[];
  startedAt: IsoTime | null;
  endedAt: IsoTime | null;
}

export interface Diagnostics {
  /** Record types the adapter did not recognise, with counts. */
  unknownRecordTypes: Record<string, number>;
  /** Lines that were not valid JSON. */
  parseErrors: number;
  /** Features this session's data cannot support, e.g. "request-detail", "in-flight". */
  unavailable: string[];
}

export interface SessionSnapshot {
  /** `usage` and `counts` are always filled in a snapshot. */
  session: SessionSummary;
  agents: AgentNode[];
  turns: Turn[];
  requests: ModelRequest[];
  toolCalls: ToolCall[];
  workflows: WorkflowRun[];
  diagnostics: Diagnostics;
}

/** The normalised entity collections of a session, as named in snapshots and patches. */
export type EntityKind = 'agents' | 'turns' | 'requests' | 'toolCalls' | 'workflows';

/** Ids of entities that no longer exist, per collection. */
export type RemovedIds = Partial<Record<EntityKind, string[]>>;

/** Entities that changed since the last patch. Consumers upsert by id, then apply `removed`. */
export interface SessionPatch {
  session: SessionSummary;
  agents: AgentNode[];
  turns: Turn[];
  requests: ModelRequest[];
  toolCalls: ToolCall[];
  workflows: WorkflowRun[];
  diagnostics: Diagnostics | null;
  /**
   * Entities to delete (e.g. a request Claude Code silently re-issued). Consumers apply these
   * after the upserts above; an id never appears both here and in an upsert list of one patch.
   */
  removed?: RemovedIds;
}

/** What one request actually sent to the model. Fetched on demand. */
export interface RequestDetail {
  requestId: string;
  completeness: 'full' | 'partial' | 'unavailable';
  /** Human-readable reasons when completeness is not 'full'. */
  notes: string[];
  params: unknown | null;
  system: unknown | null;
  tools: unknown[] | null;
  messages: unknown[] | null;
}

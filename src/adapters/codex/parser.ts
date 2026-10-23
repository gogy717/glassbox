/**
 * Pure Codex session parser. The server reads rollout files and feeds lines here.
 *
 * One Codex user turn (`task_started` … `task_complete`) holds many model responses. Each
 * `token_usage_record.response_id` is one `ModelRequest`; the `response_item`s since the
 * previous record are that response. Older rollouts have only `token_count` — one
 * `last_token_usage` per model call, and an identical repeat is the same call. Cumulative
 * totals are ignored.
 *
 * There is no pid registry. Live state is whatever discovery guessed from file mtime, so
 * every snapshot lists `live-state-heuristic`.
 */
import { basename } from 'node:path';
import { activityField, latestTurn } from '../../core/activity.js';
import type { ChangeSet, SessionParser, SessionSource, SourceFile } from '../../core/adapter.js';
import { emptyChanges } from '../../core/changes.js';
import type {
  AgentNode,
  Diagnostics,
  LiveState,
  ModelRequest,
  RequestDetail,
  RequestStatus,
  ResponseBlock,
  RunStatus,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
  TokenUsage,
  ToolCall,
  ToolStatus,
  Turn,
  TurnOrigin,
} from '../../core/model.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import { sumUsage } from '../../core/usage.js';
import { jsonOf, parseRolloutLine, type RolloutRecord, textOf } from './records.js';

const PREVIEW_CHARS = 500;
const TOOL_ITEM_TYPES = new Set([
  'CommandExecution',
  'McpToolCall',
  'Extension',
  'FileChange',
  'CollabAgentToolCall',
  'FunctionCallOutput',
  'DynamicToolCall',
  'ImageView',
  'WebSearch',
]);

interface AgentState {
  id: string;
  kind: 'main' | 'subagent';
  parentId: string | null;
  spawnedByToolCallId: string | null;
  agentType: string | null;
  label: string;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

interface TurnState {
  id: string;
  agentId: string;
  order: number;
  trigger: string | null;
  userItem: string[];
  userRole: string[];
  startedAt: string | null;
  endedAt: string | null;
  ended: boolean;
  aborted: boolean;
  errorMessage: string | null;
  model: string | null;
  effort: string | null;
}

interface ThinkingBlock {
  kind: 'thinking';
  text: string | null;
  durationMs: number | null;
  at: string;
  ordinal: number;
}
interface TextBlock {
  kind: 'text';
  text: string;
  at: string;
  ordinal: number;
}
interface ToolUseBlock {
  kind: 'tool-use';
  toolCallId: string;
  at: string;
  ordinal: number;
}
type Block = ThinkingBlock | TextBlock | ToolUseBlock;

interface RequestState {
  id: string;
  agentId: string;
  turnId: string;
  ordinal: number;
  startedAt: string | null;
  endedAt: string | null;
  usage: TokenUsage | null;
  blocks: Block[];
  toolCallIds: string[];
  provisional: boolean;
  compactedBefore: boolean;
}

interface OpenCall {
  agentId: string;
  turnId: string;
  ordinal: number;
  startedAt: string | null;
  blocks: Block[];
  toolCallIds: string[];
  hasModel: boolean;
  publishedId: string | null;
  /** The first call after a compaction: known as soon as it starts. */
  compactedBefore: boolean;
}

interface ToolState {
  id: string;
  agentId: string;
  requestId: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  result: unknown;
  hasResult: boolean;
  ordinal: number;
  spawnedAgentId: string | null;
}

const VIEW_KINDS = ['agents', 'turns', 'requests', 'toolCalls'] as const;
type ViewKind = (typeof VIEW_KINDS)[number];

function openKey(agentId: string, turnId: string): string {
  return `${agentId}\0${turnId}`;
}

function preview(value: unknown): string | null {
  const text = textOf(value).trim();
  if (text === '') return null;
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
}

function originOf(
  kind: AgentState['kind'],
  trigger: string | null,
  hasUserItem: boolean,
): TurnOrigin {
  if (trigger === 'automation_heartbeat_scheduled') return 'other';
  if (kind === 'subagent') return trigger === 'composer' ? 'human' : 'agent-prompt';
  if (trigger === 'guardian_review') return 'agent-prompt';
  if (trigger === 'composer' || hasUserItem) return 'human';
  return 'other';
}

export class CodexSessionParser implements SessionParser {
  private live: LiveState;
  private title: string | null;
  private cwd: string | null;
  private project: string;
  private version: string | null;
  private startedAt: string | null;
  private updatedAt: string;
  private systemText: string | null = null;
  private toolDefs: unknown[] | null = null;
  private archives = false;
  private readonly agents = new Map<string, AgentState>();
  private readonly turns = new Map<string, TurnState>();
  private readonly requests = new Map<string, RequestState>();
  private readonly tools = new Map<string, ToolState>();
  private readonly open = new Map<string, OpenCall>();
  private readonly currentTurn = new Map<string, string>();
  private readonly turnOrder = new Map<string, number>();
  private readonly seenUsage = new Set<string>();
  private readonly lastUsageKey = new Map<string, string>();
  private readonly compactNext = new Set<string>();
  private readonly fileAgent = new Map<string, string>();
  /** Per sub-agent file: ordinals below this are the parent's copied history. */
  private readonly fileCut = new Map<string, number>();
  private readonly diag = { unknownRecordTypes: {} as Record<string, number>, parseErrors: 0 };
  /**
   * What clients were last given, as JSON per entity. Change sets are the difference between
   * this and freshly materialised views: Codex state is derived from many cross-referencing
   * records (open calls, provisional token_count requests, reassignment), so diffing is the
   * only way a live client stays exactly equal to a snapshot.
   */
  private emittedViews: Record<ViewKind, Map<string, string>> = {
    agents: new Map(),
    turns: new Map(),
    requests: new Map(),
    toolCalls: new Map(),
  };
  private emittedSession = '';
  private emittedDiagnostics = '';
  /** Views as of the last diff, reused by `patch()`; null once the state has moved on. */
  private views: SessionSnapshot | null = null;
  /** The state moved since the last diff or snapshot (a new parser has never been given out). */
  private dirty = true;
  /** Change sets handed out and not read yet. */
  private unread: { result: ChangeSet | null }[] = [];

  constructor(private readonly source: SessionSource) {
    this.live = source.summary.live;
    this.title = source.summary.title;
    this.cwd = source.summary.cwd;
    this.project = source.summary.project;
    this.version = source.summary.version;
    this.startedAt = source.summary.startedAt;
    this.updatedAt = source.summary.updatedAt;
    this.agents.set(MAIN_AGENT_ID, {
      id: MAIN_AGENT_ID,
      kind: 'main',
      parentId: null,
      spawnedByToolCallId: null,
      agentType: null,
      label: 'Main',
      model: source.summary.model,
      startedAt: source.summary.startedAt,
      endedAt: null,
    });
  }

  /** An archive could not be decompressed, so this session may be missing history. */
  markArchivesUnavailable(): void {
    this.archives = true;
    this.views = null;
    this.dirty = true;
  }

  ingestLines(file: SourceFile, lines: string[]): ChangeSet {
    if (file.role === 'archived-unavailable') {
      this.archives = true;
      return this.changed();
    }
    let agentId =
      this.fileAgent.get(file.path) ?? (file.role === 'subagent' ? null : MAIN_AGENT_ID);
    const queued: RolloutRecord[] = [];
    for (const line of lines) {
      const rec = parseRolloutLine(line);
      if (rec.kind === 'invalid') {
        if (line.trim() !== '') {
          this.diag.parseErrors += 1;
        }
        continue;
      }
      if (agentId === null) {
        if (rec.kind === 'session-meta' && rec.id !== '') {
          agentId = rec.id;
          this.fileAgent.set(file.path, agentId);
          if (rec.historyStart !== null) this.fileCut.set(file.path, rec.historyStart);
          this.apply(rec, agentId);
          for (const earlier of queued)
            if (!this.copied(file, earlier)) this.apply(earlier, agentId);
          queued.length = 0;
        } else queued.push(rec);
        continue;
      }
      if (this.copied(file, rec)) continue;
      if (rec.kind === 'session-meta' && file.role !== 'subagent') {
        this.fileAgent.set(file.path, MAIN_AGENT_ID);
      }
      this.apply(rec, agentId);
    }
    return this.changed();
  }

  /**
   * A record in a sub-agent's file that copies the parent's history: the parent's own file has
   * it, so applying it again would duplicate requests and usage and misattribute them.
   */
  private copied(file: SourceFile, rec: RolloutRecord): boolean {
    const cut = this.fileCut.get(file.path);
    if (cut === undefined || !('ordinal' in rec) || rec.ordinal === undefined) return false;
    return rec.ordinal < cut;
  }

  ingestJson(): ChangeSet {
    return emptyChanges();
  }

  setLive(live: LiveState): ChangeSet {
    if (live === this.live) return emptyChanges();
    this.live = live;
    return this.changed();
  }

  snapshot(): SessionSnapshot {
    // Unread change sets must still name what changed before now, for clients following
    // patches rather than this snapshot.
    if (this.unread.length > 0) this.settle(null);
    const snap = this.build();
    // A client that receives this snapshot is in step with it.
    if (this.dirty) this.remember(snap);
    this.dirty = false;
    return snap;
  }

  /**
   * The change set for a state change, worked out when it is first read. A load whose change
   * sets nobody reads (the server's full parse) then costs no diff per batch. One diff covers
   * every change set still unread: the one being read carries it and the rest are empty, so
   * merged in any order they say the same. A late one may name more than its own ingest
   * touched, which `patch()` serves from the current views anyway.
   */
  private changed(): ChangeSet {
    this.dirty = true;
    this.views = null;
    const slot: { result: ChangeSet | null } = { result: null };
    this.unread.push(slot);
    return lazyChanges(() => {
      if (!slot.result) this.settle(slot);
      return slot.result as ChangeSet;
    });
  }

  /** One diff for every unread change set; `reader` (or else the oldest) carries it. */
  private settle(reader: { result: ChangeSet | null } | null): void {
    const changes = this.dirty ? this.diff() : emptyChanges();
    const owner = reader ?? this.unread[0];
    for (const slot of this.unread) slot.result = slot === owner ? changes : emptyChanges();
    this.unread = [];
  }

  /** The current views compared with what clients were last given. */
  private diff(): ChangeSet {
    const snap = this.build();
    const out = emptyChanges();
    const removed: Partial<Record<ViewKind, string[]>> = {};
    for (const kind of VIEW_KINDS) {
      const before = this.emittedViews[kind];
      const now = new Set<string>();
      for (const entity of snap[kind]) {
        now.add(entity.id);
        if (before.get(entity.id) !== jsonOf(entity)) out[kind].push(entity.id);
      }
      const gone = [...before.keys()].filter((id) => !now.has(id));
      if (gone.length > 0) removed[kind] = gone;
    }
    out.session = jsonOf(snap.session) !== this.emittedSession;
    out.diagnostics = jsonOf(snap.diagnostics) !== this.emittedDiagnostics;
    if (Object.keys(removed).length > 0) out.removed = removed;
    this.remember(snap);
    this.views = snap;
    this.dirty = false;
    return out;
  }

  private remember(snap: SessionSnapshot): void {
    for (const kind of VIEW_KINDS)
      this.emittedViews[kind] = new Map(snap[kind].map((e) => [e.id, jsonOf(e)]));
    this.emittedSession = jsonOf(snap.session);
    this.emittedDiagnostics = jsonOf(snap.diagnostics);
  }

  private build(): SessionSnapshot {
    this.materializeOpen();
    const requests = this.requestViews();
    const tools = this.toolViews();
    const turns = this.turnViews(requests);
    const agents = this.agentViews(requests, tools, turns);
    return {
      session: this.sessionView(requests, turns, tools),
      agents,
      turns,
      requests,
      toolCalls: tools,
      workflows: [],
      diagnostics: this.diagnosticsView(),
    };
  }

  patch(changes: ChangeSet): SessionPatch {
    // Reading the change set first settles it, which leaves the views it was worked out from.
    const removedRequests = new Set(changes.removed?.requests ?? []);
    const snap = this.views ?? this.build();
    const pick = <T extends { id: string }>(
      ids: string[],
      items: T[],
      hidden?: Set<string>,
    ): T[] => {
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

  requestDetail(requestId: string): RequestDetail | null {
    if (!this.requests.has(requestId)) return null;
    const req = this.requests.get(requestId) as RequestState;
    const turn = this.turns.get(req.turnId);
    const notes = [
      'Codex does not store the request body. The system prompt is the session base_instructions text, and the tool list is the latest world_state, not a frozen copy of this call.',
    ];
    const hasBody = this.systemText !== null || this.toolDefs !== null;
    return {
      requestId,
      completeness: hasBody ? 'partial' : 'unavailable',
      notes,
      params: { model: turn?.model ?? null, effort: turn?.effort ?? null },
      system: this.systemText,
      tools: this.toolDefs,
      messages: null,
    };
  }

  toolResult(toolCallId: string): unknown {
    const tool = this.tools.get(toolCallId);
    return tool?.hasResult ? tool.result : undefined;
  }

  private apply(rec: RolloutRecord, agentId: string): void {
    if (rec.kind === 'unknown') {
      this.noteUnknown(rec.type);
      return;
    }
    if (rec.kind === 'skip' || rec.kind === 'invalid' || rec.kind === 'developer-text') return;
    if ('timestamp' in rec && rec.timestamp) this.touch(rec.timestamp);
    if (rec.kind === 'session-meta') this.onSession(rec, agentId);
    else if (rec.kind === 'task-started') this.onTaskStarted(rec, agentId);
    else if (rec.kind === 'task-complete') this.onTaskComplete(rec, agentId);
    else if (rec.kind === 'turn-aborted') this.onAborted(rec, agentId);
    else if (rec.kind === 'turn-context') this.onContext(rec, agentId);
    else if (rec.kind === 'usage') this.onUsage(rec, agentId);
    else if (rec.kind === 'token-count') this.onTokenCount(rec, agentId);
    else if (rec.kind === 'reasoning') this.onReasoning(rec, agentId);
    else if (rec.kind === 'assistant-text') this.onAssistant(rec, agentId);
    else if (rec.kind === 'agent-message') this.onAgentMessage(rec, agentId);
    else if (rec.kind === 'user-text') this.onUser(rec, agentId);
    else if (rec.kind === 'tool-call') this.onToolCall(rec, agentId);
    else if (rec.kind === 'tool-output') this.onToolOutput(rec);
    else if (rec.kind === 'item') this.onItem(rec, agentId);
    else if (rec.kind === 'tools') {
      this.toolDefs = rec.tools;
    } else if (rec.kind === 'compacted') this.compactNext.add(agentId);
  }

  private onSession(rec: Extract<RolloutRecord, { kind: 'session-meta' }>, agentId: string): void {
    if (agentId === MAIN_AGENT_ID) {
      if (rec.cwd) {
        this.cwd = rec.cwd;
        const base = basename(rec.cwd);
        if (base) this.project = base;
      }
      if (rec.version) this.version = rec.version;
      if (rec.startedAt) this.startedAt = rec.startedAt;
      if (rec.system) this.systemText = rec.system;
      const main = this.agents.get(MAIN_AGENT_ID) as AgentState;
      if (rec.startedAt) main.startedAt = rec.startedAt;
      return;
    }
    const parentId =
      rec.parentThreadId === null || rec.parentThreadId === this.source.nativeId
        ? MAIN_AGENT_ID
        : rec.parentThreadId;
    if (parentId !== MAIN_AGENT_ID && !this.agents.has(parentId)) {
      this.ensureAgent(parentId, MAIN_AGENT_ID, null, null);
    }
    const agent = this.ensureAgent(agentId, parentId, rec.agentType, rec.label);
    if (rec.label) agent.label = rec.label;
    if (rec.agentType) agent.agentType = rec.agentType;
    if (rec.startedAt) agent.startedAt = rec.startedAt;
    if (rec.version && !this.version) this.version = rec.version;
  }

  private onTaskStarted(
    rec: Extract<RolloutRecord, { kind: 'task-started' }>,
    agentId: string,
  ): void {
    const turn = this.ensureTurn(agentId, rec.turnId);
    turn.trigger = rec.trigger ?? turn.trigger;
    if (rec.startedAt && !turn.startedAt) turn.startedAt = rec.startedAt;
    this.currentTurn.set(agentId, turn.id);
    this.touch(rec.startedAt);
  }

  private onTaskComplete(
    rec: Extract<RolloutRecord, { kind: 'task-complete' }>,
    agentId: string,
  ): void {
    const turn = this.ensureTurn(agentId, rec.turnId);
    turn.ended = true;
    turn.errorMessage = rec.errorMessage;
    if (rec.endedAt) turn.endedAt = rec.endedAt;
    this.touch(rec.endedAt);
  }

  private onAborted(rec: Extract<RolloutRecord, { kind: 'turn-aborted' }>, agentId: string): void {
    const turnId = rec.turnId ?? this.currentTurn.get(agentId);
    if (!turnId) return;
    const turn = this.ensureTurn(agentId, turnId);
    turn.aborted = true;
    turn.ended = true;
    if (rec.timestamp) turn.endedAt = rec.timestamp;
  }

  private onContext(rec: Extract<RolloutRecord, { kind: 'turn-context' }>, agentId: string): void {
    const turnId = rec.turnId ?? this.currentTurn.get(agentId);
    if (!turnId) return;
    const turn = this.ensureTurn(agentId, turnId);
    if (rec.model) {
      turn.model = rec.model;
      const agent = this.agents.get(agentId);
      if (agent) agent.model = rec.model;
    }
    if (rec.effort) turn.effort = rec.effort;
  }

  private onUsage(rec: Extract<RolloutRecord, { kind: 'usage' }>, agentId: string): void {
    this.seenUsage.add(agentId);
    if (this.requests.has(rec.responseId)) return;
    const turnId = rec.turnId ?? this.currentTurn.get(agentId) ?? `turn:${agentId}`;
    const turn = this.ensureTurn(agentId, turnId);
    const provisional = this.latestProvisional(turn.id);
    if (
      provisional &&
      rec.ordinal - provisional.ordinal <= 8 &&
      rec.ordinal >= provisional.ordinal
    ) {
      this.reassign(provisional, rec.responseId, rec.usage, rec.timestamp);
      return;
    }
    this.closeOpen(agentId, turn.id, rec.responseId, rec.usage, false, rec.timestamp, rec.ordinal);
  }

  private onTokenCount(
    rec: Extract<RolloutRecord, { kind: 'token-count' }>,
    agentId: string,
  ): void {
    // A file that already has response ids must not also sum token_count.
    if (this.seenUsage.has(agentId)) return;
    const turnId = this.currentTurn.get(agentId);
    if (!turnId) return;
    const open = this.open.get(openKey(agentId, turnId));
    const same = rec.usageKey !== null && rec.usageKey === this.lastUsageKey.get(agentId);
    // Same cumulative total: nothing was spent. Same last usage alone: a repeat, unless a new
    // response has started since.
    if (same && (rec.cumulative || !open?.hasModel)) return;
    if (!open?.hasModel && rec.usage === null) return;
    if (rec.usageKey) this.lastUsageKey.set(agentId, rec.usageKey);
    this.closeOpen(
      agentId,
      turnId,
      `tc:${agentId}:${rec.ordinal}`,
      rec.usage,
      true,
      rec.timestamp,
      rec.ordinal,
    );
  }

  private onReasoning(rec: Extract<RolloutRecord, { kind: 'reasoning' }>, agentId: string): void {
    const turn = this.turnFor(agentId, rec.turnId, rec.timestamp);
    const open = this.ensureOpen(agentId, turn.id, rec.ordinal, rec.timestamp);
    open.hasModel = true;
    open.blocks.push({
      kind: 'thinking',
      text: rec.text,
      durationMs: null,
      at: rec.timestamp ?? turn.startedAt ?? this.updatedAt,
      ordinal: rec.ordinal,
    });
    this.syncPublished(open);
  }

  private onAssistant(
    rec: Extract<RolloutRecord, { kind: 'assistant-text' }>,
    agentId: string,
  ): void {
    if (rec.text.trim() === '') return;
    const turn = this.turnFor(agentId, rec.turnId, rec.timestamp);
    const open = this.ensureOpen(agentId, turn.id, rec.ordinal, rec.timestamp);
    open.hasModel = true;
    open.blocks.push({
      kind: 'text',
      text: rec.text,
      at: rec.timestamp ?? turn.startedAt ?? this.updatedAt,
      ordinal: rec.ordinal,
    });
    this.syncPublished(open);
  }

  private onAgentMessage(
    rec: Extract<RolloutRecord, { kind: 'agent-message' }>,
    agentId: string,
  ): void {
    if (rec.text.trim() === '') return;
    this.onAssistant(
      {
        kind: 'assistant-text',
        turnId: rec.turnId,
        text: rec.text,
        timestamp: rec.timestamp,
        ordinal: rec.ordinal,
      },
      agentId,
    );
  }

  private onUser(rec: Extract<RolloutRecord, { kind: 'user-text' }>, agentId: string): void {
    const turn = this.turnFor(agentId, rec.turnId, rec.timestamp);
    if (rec.text.trim() !== '') turn.userRole.push(rec.text);
  }

  private onToolCall(rec: Extract<RolloutRecord, { kind: 'tool-call' }>, agentId: string): void {
    const turn = this.turnFor(agentId, rec.turnId, rec.timestamp);
    const open = this.ensureOpen(agentId, turn.id, rec.ordinal, rec.timestamp);
    open.hasModel = true;
    const tool = this.ensureTool(rec.callId, agentId, open);
    tool.name = rec.name;
    tool.input = rec.input;
    tool.ordinal = rec.ordinal;
    if (rec.status === 'failed') tool.status = 'error';
    else if (rec.status === 'completed' || rec.status === 'success') tool.status = 'complete';
    if (!open.toolCallIds.includes(tool.id)) open.toolCallIds.push(tool.id);
    open.blocks.push({
      kind: 'tool-use',
      toolCallId: tool.id,
      at: rec.timestamp ?? turn.startedAt ?? this.updatedAt,
      ordinal: rec.ordinal,
    });
    this.syncPublished(open);
  }

  private onToolOutput(rec: Extract<RolloutRecord, { kind: 'tool-output' }>): void {
    const tool = this.tools.get(rec.callId);
    if (!tool) return;
    tool.result = rec.output;
    tool.hasResult = true;
    if (tool.status !== 'error') tool.status = 'complete';
  }

  private onItem(rec: Extract<RolloutRecord, { kind: 'item' }>, agentId: string): void {
    if (!rec.known) {
      this.noteUnknown(`item:${rec.itemType}`);
      return;
    }
    if (rec.itemType === 'UserMessage') {
      const turnId = this.currentTurn.get(agentId);
      if (!turnId || !rec.text) return;
      const turn = this.ensureTurn(agentId, turnId);
      turn.userItem.push(rec.text);
      return;
    }
    if (rec.itemType === 'Reasoning') {
      const block = this.nearestThinking(agentId, rec.ordinal);
      if (block && rec.durationMs !== null) block.durationMs = rec.durationMs;
      return;
    }
    if (rec.itemType === 'SubAgentActivity') {
      this.onSubAgent(rec, agentId);
      return;
    }
    if (!TOOL_ITEM_TYPES.has(rec.itemType)) return;
    const tool =
      (rec.itemId ? this.tools.get(rec.itemId) : undefined) ??
      this.nearestTool(agentId, rec.ordinal);
    if (!tool) return;
    if (rec.startedAt) tool.startedAt = rec.startedAt;
    if (rec.endedAt) tool.endedAt = rec.endedAt;
    if (rec.durationMs !== null) tool.durationMs = rec.durationMs;
    if (rec.isError) tool.status = 'error';
    else if (rec.status === 'completed' || rec.status === 'success') tool.status = 'complete';
    if (!tool.hasResult && rec.outputText) {
      tool.result = rec.outputText;
      tool.hasResult = true;
      if (tool.status === 'unknown') tool.status = 'complete';
    }
  }

  private onSubAgent(rec: Extract<RolloutRecord, { kind: 'item' }>, agentId: string): void {
    if (!rec.agentThreadId) return;
    const parent = agentId === MAIN_AGENT_ID ? MAIN_AGENT_ID : agentId;
    const agent = this.ensureAgent(rec.agentThreadId, parent, rec.agentPath, rec.agentPath);
    const tool = rec.itemId ? this.tools.get(rec.itemId) : undefined;
    if (tool && (rec.activityKind === 'started' || tool.name === 'spawn_agent')) {
      tool.spawnedAgentId = agent.id;
      agent.spawnedByToolCallId = tool.id;
    }
  }

  private ensureAgent(
    id: string,
    parentId: string,
    agentType: string | null,
    label: string | null,
  ): AgentState {
    const existing = this.agents.get(id);
    if (existing) return existing;
    const agent: AgentState = {
      id,
      kind: 'subagent',
      parentId,
      spawnedByToolCallId: null,
      agentType,
      label: label ?? agentType ?? 'subagent',
      model: null,
      startedAt: null,
      endedAt: null,
    };
    this.agents.set(id, agent);
    return agent;
  }

  private ensureTurn(agentId: string, turnId: string): TurnState {
    const existing = this.turns.get(turnId);
    if (existing) return existing;
    const order = (this.turnOrder.get(agentId) ?? 0) + 1;
    this.turnOrder.set(agentId, order);
    const turn: TurnState = {
      id: turnId,
      agentId,
      order,
      trigger: null,
      userItem: [],
      userRole: [],
      startedAt: null,
      endedAt: null,
      ended: false,
      aborted: false,
      errorMessage: null,
      model: null,
      effort: null,
    };
    this.turns.set(turnId, turn);
    return turn;
  }

  private turnFor(agentId: string, turnId: string | null, timestamp: string | null): TurnState {
    const id = turnId ?? this.currentTurn.get(agentId) ?? `turn:${agentId}`;
    const turn = this.ensureTurn(agentId, id);
    if (!turn.startedAt && timestamp) turn.startedAt = timestamp;
    this.currentTurn.set(agentId, turn.id);
    return turn;
  }

  private ensureOpen(
    agentId: string,
    turnId: string,
    ordinal: number,
    at: string | null,
  ): OpenCall {
    const key = openKey(agentId, turnId);
    const existing = this.open.get(key);
    if (existing) return existing;
    const open: OpenCall = {
      agentId,
      turnId,
      ordinal,
      startedAt: at,
      blocks: [],
      toolCallIds: [],
      hasModel: false,
      publishedId: null,
      compactedBefore: this.takeCompaction(agentId),
    };
    this.open.set(key, open);
    return open;
  }

  private closeOpen(
    agentId: string,
    turnId: string,
    id: string,
    usage: TokenUsage | null,
    provisional: boolean,
    endedAt: string | null,
    ordinal: number,
  ): void {
    const key = openKey(agentId, turnId);
    const open = this.open.get(key);
    if (open?.publishedId && open.publishedId !== id) this.dropRequest(open.publishedId);
    const blocks = open?.blocks ?? [];
    const toolCallIds = open?.toolCallIds ?? [];
    if (!open?.hasModel && usage === null) return;
    const req: RequestState = {
      id,
      agentId,
      turnId,
      ordinal: open?.ordinal ?? ordinal,
      startedAt: open?.startedAt ?? null,
      endedAt,
      usage,
      blocks,
      toolCallIds: [...toolCallIds],
      provisional,
      compactedBefore: open ? open.compactedBefore : this.takeCompaction(agentId),
    };
    this.requests.set(id, req);
    for (const toolId of req.toolCallIds) {
      const tool = this.tools.get(toolId);
      if (tool) tool.requestId = id;
    }
    this.open.delete(key);
  }

  /** Whether a compaction happened since this agent's last call, consuming it. */
  private takeCompaction(agentId: string): boolean {
    return this.compactNext.delete(agentId);
  }

  private reassign(req: RequestState, id: string, usage: TokenUsage, endedAt: string | null): void {
    this.requests.delete(req.id);
    req.id = id;
    req.usage = usage;
    req.provisional = false;
    if (endedAt) req.endedAt = endedAt;
    this.requests.set(id, req);
    for (const toolId of req.toolCallIds) {
      const tool = this.tools.get(toolId);
      if (tool) tool.requestId = id;
    }
  }

  private dropRequest(id: string): void {
    this.requests.delete(id);
  }

  private latestProvisional(turnId: string): RequestState | null {
    let found: RequestState | null = null;
    for (const req of this.requests.values()) {
      if (req.turnId !== turnId || !req.provisional) continue;
      if (!found || req.ordinal >= found.ordinal) found = req;
    }
    return found;
  }

  private materializeOpen(): void {
    for (const open of this.open.values()) {
      if (!open.hasModel) continue;
      if (!open.publishedId) {
        open.publishedId = `pending:${open.agentId}:${open.turnId}:${open.ordinal}`;
        const req: RequestState = {
          id: open.publishedId,
          agentId: open.agentId,
          turnId: open.turnId,
          ordinal: open.ordinal,
          startedAt: open.startedAt,
          endedAt: null,
          usage: null,
          blocks: open.blocks,
          toolCallIds: [...open.toolCallIds],
          provisional: false,
          compactedBefore: open.compactedBefore,
        };
        this.requests.set(req.id, req);
      } else {
        const req = this.requests.get(open.publishedId);
        if (req) {
          req.blocks = open.blocks;
          req.toolCallIds = [...open.toolCallIds];
        }
      }
      for (const toolId of open.toolCallIds) {
        const tool = this.tools.get(toolId);
        if (tool && open.publishedId) tool.requestId = open.publishedId;
      }
    }
  }

  private syncPublished(open: OpenCall): void {
    if (!open.publishedId) return;
    const req = this.requests.get(open.publishedId);
    if (!req) return;
    req.blocks = open.blocks;
    req.toolCallIds = [...open.toolCallIds];
  }

  private ensureTool(id: string, agentId: string, open: OpenCall): ToolState {
    const existing = this.tools.get(id);
    if (existing) return existing;
    const tool: ToolState = {
      id,
      agentId,
      requestId: open.publishedId ?? '',
      name: 'tool',
      input: {},
      status: 'unknown',
      startedAt: null,
      endedAt: null,
      durationMs: null,
      result: undefined,
      hasResult: false,
      ordinal: open.ordinal,
      spawnedAgentId: null,
    };
    this.tools.set(id, tool);
    return tool;
  }

  private nearestTool(agentId: string, ordinal: number): ToolState | null {
    let best: ToolState | null = null;
    let bestDist = 5;
    for (const tool of this.tools.values()) {
      if (tool.agentId !== agentId) continue;
      const dist = Math.abs(tool.ordinal - ordinal);
      if (dist < bestDist) {
        best = tool;
        bestDist = dist;
      }
    }
    return best;
  }

  private nearestThinking(agentId: string, ordinal: number): ThinkingBlock | null {
    let best: ThinkingBlock | null = null;
    let bestDist = 5;
    const consider = (blocks: Block[]) => {
      for (const block of blocks) {
        if (block.kind !== 'thinking') continue;
        const dist = Math.abs(block.ordinal - ordinal);
        if (dist < bestDist) {
          best = block;
          bestDist = dist;
        }
      }
    };
    for (const open of this.open.values()) if (open.agentId === agentId) consider(open.blocks);
    for (const req of this.requests.values()) if (req.agentId === agentId) consider(req.blocks);
    return best;
  }

  private touch(value: string | null): void {
    if (value && value > this.updatedAt) this.updatedAt = value;
  }

  private noteUnknown(type: string): void {
    this.diag.unknownRecordTypes[type] = (this.diag.unknownRecordTypes[type] ?? 0) + 1;
  }

  private sessionView(requests: ModelRequest[], turns: Turn[], tools: ToolCall[]): SessionSummary {
    const mainTurns = [...this.turns.values()]
      .filter((turn) => turn.agentId === MAIN_AGENT_ID)
      .sort((a, b) => a.order - b.order);
    const model =
      [...mainTurns].reverse().find((turn) => turn.model)?.model ??
      this.agents.get(MAIN_AGENT_ID)?.model ??
      null;
    return {
      id: `codex:${this.source.nativeId}`,
      agent: 'codex',
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
        toolCalls: tools,
        requests,
        lastTurn: latestTurn(turns),
        updatedAt: this.updatedAt,
      }),
      usage: sumUsage(requests.map((req) => req.usage)),
      counts: {
        turns: turns.length,
        requests: requests.length,
        toolCalls: this.tools.size,
        agents: this.agents.size,
      },
    };
  }

  private turnViews(requests: ModelRequest[]): Turn[] {
    const byAgent = new Map<string, TurnState[]>();
    for (const turn of this.turns.values()) {
      const list = byAgent.get(turn.agentId) ?? [];
      list.push(turn);
      byAgent.set(turn.agentId, list);
    }
    const index = new Map<string, number>();
    for (const list of byAgent.values()) {
      list.sort((a, b) => a.order - b.order);
      for (let i = 0; i < list.length; i++) {
        const turn = list[i];
        if (turn) index.set(turn.id, i + 1);
      }
    }
    return [...this.turns.values()]
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.order - b.order)
      .map((turn) => {
        const agent = this.agents.get(turn.agentId);
        const prompt = turn.userItem.join('\n').trim() || turn.userRole.join('\n').trim();
        const reqs = requests.filter((req) => req.turnId === turn.id);
        return {
          id: turn.id,
          agentId: turn.agentId,
          index: index.get(turn.id) ?? turn.order,
          origin: originOf(agent?.kind ?? 'main', turn.trigger, turn.userItem.length > 0),
          prompt,
          startedAt: turn.startedAt ?? this.startedAt ?? this.updatedAt,
          endedAt: turn.ended ? turn.endedAt : null,
          status: this.turnStatus(turn),
          requestIds: reqs.map((req) => req.id),
        };
      });
  }

  private turnStatus(turn: TurnState): RunStatus {
    if (turn.aborted) return 'interrupted';
    if (turn.errorMessage) return 'error';
    if (turn.ended) return 'complete';
    if (this.live === 'closed') return 'interrupted';
    return 'running';
  }

  private requestViews(): ModelRequest[] {
    const grouped = new Map<string, RequestState[]>();
    for (const req of this.requests.values()) {
      const list = grouped.get(req.turnId) ?? [];
      list.push(req);
      grouped.set(req.turnId, list);
    }
    for (const list of grouped.values())
      list.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
    const views: ModelRequest[] = [];
    for (const list of grouped.values()) {
      for (let i = 0; i < list.length; i++) {
        const req = list[i];
        if (req) views.push(this.requestView(req, i + 1, i === list.length - 1));
      }
    }
    views.sort((a, b) => {
      const left = this.requests.get(a.id)?.ordinal ?? 0;
      const right = this.requests.get(b.id)?.ordinal ?? 0;
      return left - right || a.id.localeCompare(b.id);
    });
    return views;
  }

  private requestView(req: RequestState, index: number, isLast: boolean): ModelRequest {
    const turn = this.turns.get(req.turnId);
    const blocks: ResponseBlock[] = req.blocks.map((block) => {
      if (block.kind === 'thinking') {
        return { kind: 'thinking', text: block.text, durationMs: block.durationMs, at: block.at };
      }
      if (block.kind === 'text') return { kind: 'text', text: block.text, at: block.at };
      return { kind: 'tool-use', toolCallId: block.toolCallId, at: block.at };
    });
    const startedAt = req.startedAt ?? (index === 1 ? (turn?.startedAt ?? null) : null);
    const error =
      turn?.errorMessage && isLast
        ? { message: turn.errorMessage, status: null, retryAttempt: null }
        : null;
    return {
      id: req.id,
      agentId: req.agentId,
      turnId: req.turnId,
      index,
      model: turn?.model ?? null,
      effort: turn?.effort ?? null,
      startedAt,
      firstBlockAt: blocks[0]?.at ?? null,
      endedAt: req.endedAt,
      status: this.requestStatus(req, turn, isLast),
      stopReason: null,
      usage: req.usage,
      blocks,
      toolCallIds: [...req.toolCallIds],
      hasDetail: this.systemText !== null || this.toolDefs !== null,
      error,
      ...(req.compactedBefore ? { compactedBefore: true } : {}),
    };
  }

  private requestStatus(
    req: RequestState,
    turn: TurnState | undefined,
    isLast: boolean,
  ): RequestStatus {
    if (turn?.aborted && req.usage === null) return 'interrupted';
    if (turn?.errorMessage && isLast && (req.usage !== null || turn.ended)) return 'error';
    if (req.usage !== null) return 'complete';
    if (turn?.ended || turn?.aborted || this.live === 'closed') return 'interrupted';
    return 'in-flight';
  }

  private toolViews(): ToolCall[] {
    return [...this.tools.values()]
      .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
      .map((tool) => ({
        id: tool.id,
        agentId: tool.agentId,
        requestId: tool.requestId,
        name: tool.name,
        input: tool.input,
        status: tool.status,
        startedAt: tool.startedAt,
        endedAt: tool.endedAt,
        durationMs: tool.durationMs,
        resultPreview: tool.hasResult ? preview(tool.result) : null,
        hasFullResult: tool.hasResult,
        spawned:
          tool.spawnedAgentId && this.agents.has(tool.spawnedAgentId)
            ? { kind: 'agent', agentId: tool.spawnedAgentId }
            : null,
      }));
  }

  private agentViews(requests: ModelRequest[], tools: ToolCall[], turns: Turn[]): AgentNode[] {
    const nodes = [...this.agents.values()].sort((a, b) => {
      if (a.id === MAIN_AGENT_ID) return -1;
      if (b.id === MAIN_AGENT_ID) return 1;
      return (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.id.localeCompare(b.id);
    });
    return nodes.map((agent) => {
      const mineTurns = turns.filter((turn) => turn.agentId === agent.id);
      const mineReqs = requests.filter((req) => req.agentId === agent.id);
      const mineTools = tools.filter((tool) => tool.agentId === agent.id);
      const running = mineTurns.some((turn) => turn.status === 'running');
      return {
        id: agent.id,
        kind: agent.kind,
        parentId: agent.parentId,
        spawnedByToolCallId:
          agent.spawnedByToolCallId && this.tools.has(agent.spawnedByToolCallId)
            ? agent.spawnedByToolCallId
            : null,
        agentType: agent.agentType,
        label: agent.label,
        workflowRunId: null,
        phase: null,
        model: agent.model,
        status: this.agentStatus(mineTurns, running),
        startedAt: agent.startedAt,
        endedAt: running
          ? null
          : (mineTurns.map((turn) => turn.endedAt).findLast((value) => value) ?? null),
        usage: sumUsage(mineReqs.map((req) => req.usage)),
        counts: { turns: mineTurns.length, requests: mineReqs.length, toolCalls: mineTools.length },
      };
    });
  }

  private agentStatus(turns: Turn[], running: boolean): RunStatus {
    if (running) return 'running';
    if (turns.length === 0) return 'unknown';
    if (turns.some((turn) => turn.status === 'error')) return 'error';
    if (turns.some((turn) => turn.status === 'interrupted')) return 'interrupted';
    return 'complete';
  }

  private diagnosticsView(): Diagnostics {
    // Not listed, because Codex records them exactly: per-request usage (a token_usage_record per
    // response id, or a token_count per call) and compaction markers (its own `compacted`
    // records; checked against the context size drop on real rollouts).
    const unavailable = ['live-state-heuristic'];
    if (this.archives) unavailable.unshift('archived-sessions');
    return {
      unknownRecordTypes: { ...this.diag.unknownRecordTypes },
      parseErrors: this.diag.parseErrors,
      unavailable,
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
] as const;

/** A change set whose fields come from `read`, called when one is first used. */
function lazyChanges(read: () => ChangeSet): ChangeSet {
  const out = {} as ChangeSet;
  for (const key of CHANGE_KEYS)
    Object.defineProperty(out, key, { enumerable: true, get: () => read()[key] });
  return out;
}

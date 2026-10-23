/**
 * Pure Claude Code session parser: transcript records in, agent-neutral entities out.
 * No I/O — the server reads files and feeds lines/json here.
 */

import { activityField } from '../../core/activity.js';
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
  SessionActivity,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
  SpawnRef,
  ToolCall,
  Turn,
  TurnOrigin,
  WorkflowRun,
} from '../../core/model.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import { sumUsage } from '../../core/usage.js';
import {
  type AgentState,
  newAgent,
  newRequest,
  orderedBlocks,
  type RequestState,
  requestStart,
  type ToolState,
  type TurnState,
} from './agent-state.js';
import {
  type ApiRequestRecord,
  type AssistantRecord,
  type ClaudeRecord,
  cleanPrompt,
  cleanTurnPrompt,
  isProbeCwd,
  isSlashCommand,
  PROBE_NAME,
  parseRecord,
  pickTitle,
  promptOrigin,
  type SystemRecord,
  turnInput,
  type UserRecord,
} from './records.js';
import { RequestDetailStore } from './request-detail.js';
import {
  addAgent,
  applyJournal,
  applyState,
  isRetried,
  newRun,
  parseJournalLine,
  type RunState,
} from './workflows.js';

/** Blocks without `apiBlockIndex` sort after indexed ones, in arrival order. */
const UNINDEXED = 1_000_000;

class Changes {
  session = false;
  diagnostics = false;
  readonly agents = new Set<string>();
  readonly turns = new Set<string>();
  readonly requests = new Set<string>();
  readonly toolCalls = new Set<string>();
  readonly workflows = new Set<string>();
  readonly removedRequests = new Set<string>();

  toChangeSet(): ChangeSet {
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

export class ClaudeSessionParser implements SessionParser {
  private live: LiveState;
  private readonly agents = new Map<string, AgentState>();
  private readonly turns = new Map<string, TurnState>();
  private readonly requests = new Map<string, RequestState>();
  private readonly tools = new Map<string, ToolState>();
  /** `requestId` / `message.id` → request entity id. */
  private readonly byRequestId = new Map<string, string>();
  private readonly byMessageId = new Map<string, string>();
  private readonly seenUuids = new Set<string>();
  /** `requestId` → the file that first carried it; fork agents copy their parent's record. */
  private readonly requestOwner = new Map<string, string>();
  /** Requests dropped because Claude Code silently re-issued them. */
  private readonly superseded = new Set<string>();
  /** Tool call → the agent or workflow run it launched. */
  private readonly spawnOf = new Map<string, SpawnRef>();
  private readonly runs = new Map<string, RunState>();
  private readonly detail = new RequestDetailStore();
  /** Tool results whose tool_use has not been seen yet (file order is not strict). */
  private readonly orphanResults = new Map<
    string,
    NonNullable<ToolState['result']> & { agentId: string }
  >();
  private readonly diag = { unknownRecordTypes: {} as Record<string, number>, parseErrors: 0 };

  private cwd: string | null = null;
  private version: string | null = null;
  private startedAt: string | null = null;
  private updatedAt: string | null = null;
  private customTitle: string | null = null;
  private aiTitle: string | null = null;
  private agentName: string | null = null;
  /** Any `api-request` record seen; without them detail and in-flight are unavailable. */
  private sawApiRequest = false;
  /**
   * Newest record time when the session was last seen going idle. Main-agent requests that
   * started by then and never got a reply are over; later ones are a registry lag.
   */
  private idleMark: number | null = null;

  constructor(private readonly source: SessionSource) {
    this.live = source.summary.live;
    this.agents.set(MAIN_AGENT_ID, newAgent(MAIN_AGENT_ID, 'main', 'Main'));
  }

  ingestLines(file: SourceFile, lines: string[]): ChangeSet {
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

  ingestJson(file: SourceFile, value: unknown): ChangeSet {
    const ch = new Changes();
    const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    if (file.role === 'subagent-meta' && file.agentId) {
      const agent = this.ensureAgent(file.agentId, 'subagent', ch);
      if (typeof v.agentType === 'string') agent.agentType = v.agentType;
      if (typeof v.description === 'string' && v.description) agent.metaLabel = v.description;
      agent.finished = v.finished === true;
      if (typeof v.toolUseId === 'string') this.link(agent, v.toolUseId, ch);
      ch.agents.add(agent.id);
      this.markAgentTail(agent.id, ch);
    } else if (file.role === 'workflow-agent-meta' && file.agentId && file.workflowRunId) {
      const agent = this.ensureWorkflowAgent(file.agentId, file.workflowRunId, ch);
      if (typeof v.agentType === 'string') agent.agentType = v.agentType;
      if (typeof v.description === 'string' && v.description) agent.metaLabel = v.description;
      if (typeof v.workflowPhase === 'string') agent.phase = v.workflowPhase;
      ch.agents.add(agent.id);
    } else if (file.role === 'workflow-state' && file.workflowRunId) {
      const run = this.ensureRun(file.workflowRunId, ch);
      applyState(run, value);
      this.markRun(run, ch);
    }
    return ch.toChangeSet();
  }

  private ingestJournal(file: SourceFile, lines: string[], ch: Changes): void {
    const run = this.ensureRun(file.workflowRunId ?? 'unknown', ch);
    for (const line of lines) {
      const event = parseJournalLine(line);
      if (event === null) {
        this.diag.parseErrors += 1;
        ch.diagnostics = true;
        continue;
      }
      const agentId = applyJournal(run, event);
      if (agentId) this.ensureWorkflowAgent(agentId, run.id, ch);
    }
    this.markRun(run, ch);
  }

  setLive(live: LiveState): ChangeSet {
    const ch = new Changes();
    if (live === this.live) return ch.toChangeSet();
    this.live = live;
    this.idleMark =
      live === 'idle'
        ? this.updatedAt
          ? Date.parse(this.updatedAt)
          : Number.POSITIVE_INFINITY
        : null;
    ch.session = true;
    // Everything still open may change status.
    for (const r of this.requests.values()) if (r.stopReason === null) this.markRequest(r, ch);
    for (const t of this.tools.values()) if (!t.result) ch.toolCalls.add(t.id);
    for (const t of this.turns.values()) ch.turns.add(t.id);
    for (const a of this.agents.keys()) ch.agents.add(a);
    for (const r of this.runs.keys()) ch.workflows.add(r);
    return ch.toChangeSet();
  }

  snapshot(): SessionSnapshot {
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

  patch(changes: ChangeSet): SessionPatch {
    const removed = new Set(changes.removed?.requests ?? []);
    const pick = <S, V>(ids: string[], map: Map<string, S>, view: (s: S) => V): V[] =>
      ids.flatMap((id) => {
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

  requestDetail(requestId: string): RequestDetail | null {
    return this.requests.has(requestId) ? this.detail.detail(requestId) : null;
  }

  toolResult(toolCallId: string): unknown {
    const result = this.tools.get(toolCallId)?.result;
    return result ? { content: result.content, toolUseResult: result.toolUseResult } : undefined;
  }

  // --- ingestion ---------------------------------------------------------------------------

  private ingestRecord(file: SourceFile, rec: ClaudeRecord, ch: Changes): void {
    if ('uuid' in rec && rec.uuid) {
      if (this.seenUuids.has(rec.uuid)) return;
      this.seenUuids.add(rec.uuid);
    }
    const agent = this.agentFor(file, ch);
    agent.prevTs = agent.lastTs;
    if ('ts' in rec && rec.ts) {
      this.touch(rec.ts, ch);
      if (agent.lastTs === null || rec.ts > agent.lastTs) agent.lastTs = rec.ts;
    }
    if ('cwd' in rec && rec.cwd && this.cwd === null) this.cwd = rec.cwd;
    if ('version' in rec && rec.version) this.version = rec.version;

    switch (rec.kind) {
      case 'user':
        this.detail.addUser(file.path, rec.message);
        this.onUser(agent, rec, ch);
        break;
      case 'api-request': {
        // A copy of another agent's request (fork agents) is not this agent's.
        const owner = this.requests.get(rec.id)?.agentId;
        if (owner !== undefined && owner !== agent.id) break;
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
          this.detail.addAssistant(
            file.path,
            rec.requestId ?? rec.messageId,
            rec.apiBlockIndex,
            rec.content,
          );
        if (rec.requestId) {
          const owner = this.requestOwner.get(rec.requestId);
          if (owner === undefined) this.requestOwner.set(rec.requestId, file.path);
          else if (owner !== file.path) break;
        }
        if (rec.isApiErrorMessage) this.onApiErrorMessage(agent, rec, ch);
        else this.onAssistant(agent, rec, ch);
        break;
      case 'system':
        this.onSystem(agent, rec, ch);
        break;
      case 'custom-title':
        if (rec.title) this.customTitle = rec.title;
        ch.session = true;
        break;
      case 'ai-title':
        if (rec.title) this.aiTitle = rec.title;
        ch.session = true;
        break;
      case 'agent-name':
        if (rec.title) this.agentName = rec.title;
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

  private agentFor(file: SourceFile, ch: Changes): AgentState {
    if (file.role === 'main' || !file.agentId) return this.agents.get(MAIN_AGENT_ID) as AgentState;
    if (file.role === 'workflow-agent' && file.workflowRunId)
      return this.ensureWorkflowAgent(file.agentId, file.workflowRunId, ch);
    return this.ensureAgent(file.agentId, 'subagent', ch);
  }

  private ensureRun(id: string, ch: Changes): RunState {
    let run = this.runs.get(id);
    if (!run) {
      run = newRun(id);
      this.runs.set(id, run);
      ch.workflows.add(id);
      ch.session = true;
    }
    return run;
  }

  private ensureWorkflowAgent(agentId: string, runId: string, ch: Changes): AgentState {
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
  private markRun(run: RunState, ch: Changes): void {
    ch.workflows.add(run.id);
    for (const id of run.agentIds) {
      ch.agents.add(id);
      this.markAgentTail(id, ch);
    }
    if (run.toolCallId && this.tools.has(run.toolCallId)) ch.toolCalls.add(run.toolCallId);
  }

  private ensureAgent(id: string, kind: AgentState['kind'], ch: Changes): AgentState {
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
  private link(agent: AgentState, toolUseId: string, ch: Changes): void {
    if (agent.id === MAIN_AGENT_ID) return;
    agent.spawnedByToolCallId = toolUseId;
    this.spawnOf.set(toolUseId, { kind: 'agent', agentId: agent.id });
    ch.agents.add(agent.id);
    if (this.tools.has(toolUseId)) ch.toolCalls.add(toolUseId);
  }

  /** An explicit end for a sub-agent, from its parent's side. */
  private endAgent(agentId: string, status: RunStatus, at: string | null, ch: Changes): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.id === MAIN_AGENT_ID) return;
    agent.end = { status, at };
    ch.agents.add(agent.id);
    this.markAgentTail(agent.id, ch);
  }

  private touch(ts: string, ch: Changes): void {
    if (this.startedAt === null || ts < this.startedAt) this.startedAt = ts;
    if (this.updatedAt === null || ts > this.updatedAt) this.updatedAt = ts;
    ch.session = true;
  }

  private onUser(agent: AgentState, rec: UserRecord, ch: Changes): void {
    for (const part of rec.toolResults) {
      const result = {
        content: part.content,
        toolUseResult: rec.toolUseResult,
        isError: part.isError,
        at: rec.ts,
      };
      const tool = this.tools.get(part.toolUseId);
      // A fork's transcript starts with a copy of its parent's tool result: not this agent's.
      if (tool && tool.agentId !== agent.id) continue;
      this.onSpawnResult(part.toolUseId, rec.toolUseResult, rec.ts, ch);
      const spawned = this.spawnOf.get(part.toolUseId);
      if (part.isError && spawned?.kind === 'agent') {
        const text = typeof part.content === 'string' ? part.content : jsonText(part.content);
        this.endAgent(
          spawned.agentId,
          /interrupt/i.test(text ?? '') ? 'interrupted' : 'error',
          rec.ts,
          ch,
        );
      }
      if (tool) {
        tool.result = result;
        ch.toolCalls.add(tool.id);
        const req = this.requests.get(tool.requestId);
        if (req) this.markRequest(req, ch);
      } else this.orphanResults.set(part.toolUseId, { ...result, agentId: agent.id });
    }
    if (rec.interrupt)
      this.onInterrupt(agent, rec.ts ?? this.updatedAt ?? this.source.summary.updatedAt, ch);
    if (rec.isCompactSummary) agent.compactPending = true;
    let origin = promptOrigin(rec, agent.kind === 'main');
    // A fork's first record pairs the copied tool result with its directive.
    const forkDirective =
      origin === null &&
      agent.kind !== 'main' &&
      agent.turnIds.length === 0 &&
      rec.toolResults.length > 0 &&
      !rec.isMeta &&
      rec.text.trim() !== '';
    if (forkDirective) origin = 'agent-prompt';
    if (origin === null) return;
    if (origin === 'task-notification') this.onTaskNotification(rec.text, rec.ts, ch);
    const input = turnInput(rec, origin);
    if (agent.kind !== 'main' && agent.turnIds.length === 0) origin = 'agent-prompt';
    const turn: TurnState = {
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
    if (previousTurn) ch.turns.add(previousTurn);
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
  private claimEarlyRequest(
    agent: AgentState,
    turn: TurnState,
    previousTurnId: string | undefined,
    ch: Changes,
  ): void {
    const req = this.requests.get(agent.requestIds.at(-1) ?? '');
    const previous = previousTurnId ? this.turns.get(previousTurnId) : undefined;
    if (!req || !previous || req.turnId !== previous.id || !req.hasApi || req.blocks.size > 0)
      return;
    if (!req.apiTs || req.apiTs < turn.startedAt) return;
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
  private onSpawnResult(toolUseId: string, result: unknown, at: string | null, ch: Changes) {
    if (typeof result !== 'object' || result === null) return;
    const { agentId, status, runId, taskId, workflowName } = result as Record<string, unknown>;
    if (typeof runId === 'string') {
      const run = this.ensureRun(runId, ch);
      run.toolCallId = toolUseId;
      if (typeof taskId === 'string') run.taskId ??= taskId;
      if (typeof workflowName === 'string') run.name ??= workflowName;
      this.spawnOf.set(toolUseId, { kind: 'workflow', runId });
      this.markRun(run, ch);
      return;
    }
    if (typeof agentId !== 'string' || typeof status !== 'string') return;
    const agent = this.ensureAgent(agentId, 'subagent', ch);
    if (!agent.spawnedByToolCallId) this.link(agent, toolUseId, ch);
    if (status === 'completed') this.endAgent(agentId, 'complete', at, ch);
  }

  private onTaskNotification(text: string, at: string | null, ch: Changes): void {
    const tag = (name: string) =>
      new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1]?.trim() ?? null;
    const toolUseId = tag('tool-use-id');
    const taskId = tag('task-id');
    const spawned = toolUseId ? this.spawnOf.get(toolUseId) : undefined;
    const agentId =
      spawned?.kind === 'agent'
        ? spawned.agentId
        : taskId && this.agents.has(taskId)
          ? taskId
          : null;
    const status = NOTIFIED_STATUS[tag('status') ?? ''] ?? 'complete';
    if (agentId) this.endAgent(agentId, status, at, ch);
    const run =
      spawned?.kind === 'workflow'
        ? this.runs.get(spawned.runId)
        : [...this.runs.values()].find((r) => taskId !== null && r.taskId === taskId);
    if (run && !run.notified) {
      run.notified = { status, at };
      this.markRun(run, ch);
    }
  }

  private onInterrupt(agent: AgentState, at: string, ch: Changes): void {
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

  private onSystem(agent: AgentState, rec: SystemRecord, ch: Changes): void {
    if (rec.subtype === 'compact_boundary') agent.compactPending = true;
    else if (rec.subtype === 'turn_duration') {
      const turn = this.turns.get(agent.turnIds.at(-1) ?? '');
      if (turn && rec.ts) {
        turn.endMarkAt = rec.ts;
        ch.turns.add(turn.id);
        ch.agents.add(agent.id);
      }
    } else if (rec.subtype === 'api_error' && rec.error) {
      const req = this.unanswered(agent);
      if (req) {
        req.error = rec.error;
        this.markRequest(req, ch);
      }
    }
  }

  /** The agent's latest request when nothing of its response has arrived yet. */
  private unanswered(agent: AgentState): RequestState | undefined {
    const req = this.requests.get(agent.requestIds.at(-1) ?? '');
    return req && req.stopReason === null && req.blocks.size === 0 ? req : undefined;
  }

  /** Claude Code's synthetic "API Error" message: the request failed for good. */
  private onApiErrorMessage(agent: AgentState, rec: AssistantRecord, ch: Changes): void {
    const known = rec.requestId
      ? this.requests.get(this.byRequestId.get(rec.requestId) ?? '')
      : undefined;
    const req =
      known ??
      this.unanswered(agent) ??
      this.createRequest(
        agent,
        rec.messageId ?? rec.uuid ?? `request-${this.requests.size + 1}`,
        ch,
      );
    const text = rec.blocks.find((b) => b.type === 'text');
    req.error = {
      message: text?.type === 'text' && text.text ? text.text : 'API error',
      status: rec.apiErrorStatus,
      retryAttempt: req.error?.retryAttempt ?? null,
    };
    this.markRequest(req, ch);
  }

  private onApiRequest(agent: AgentState, rec: ApiRequestRecord, ch: Changes): void {
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

  private onAssistant(agent: AgentState, rec: AssistantRecord, ch: Changes): void {
    const req = this.resolveRequest(agent, rec, ch);
    req.error = null;
    if (rec.model && rec.model !== '<synthetic>') req.model = rec.model;
    if (rec.effort) req.effort = rec.effort;
    if (rec.stopReason !== null) req.stopReason = rec.stopReason;
    if (rec.usage && rec.outputTokens > req.bestOutput) {
      req.usage = rec.usage;
      req.bestOutput = rec.outputTokens;
    }
    const at = rec.ts ?? this.updatedAt ?? this.source.summary.updatedAt;
    const base = rec.apiBlockIndex ?? UNINDEXED + req.arrivals;
    req.arrivals += 1;
    rec.blocks.forEach((b, j) => {
      const key = base * 100 + j;
      let block: ResponseBlock;
      if (b.type === 'thinking')
        block = { kind: 'thinking', text: b.text || null, durationMs: rec.thinkingDurationMs, at };
      else if (b.type === 'text') block = { kind: 'text', text: b.text, at };
      else if (b.type === 'tool_use') {
        this.ensureTool(agent, req, b.id, b.name, b.input, rec.ts, ch);
        block = { kind: 'tool-use', toolCallId: b.id, at };
      } else return;
      req.blocks.set(key, {
        block,
        thinkingMs: b.type === 'thinking' ? rec.thinkingDurationMs : null,
      });
    });
    this.markRequest(req, ch);
  }

  /** Finds the entity an assistant record belongs to, creating it on first sight. */
  private resolveRequest(agent: AgentState, rec: AssistantRecord, ch: Changes): RequestState {
    let id: string | undefined;
    if (rec.requestRef && this.requests.has(rec.requestRef)) id = rec.requestRef;
    if (!id && rec.requestId) id = this.byRequestId.get(rec.requestId);
    if (!id && rec.messageId) id = this.byMessageId.get(rec.messageId);
    const req =
      (id && this.requests.get(id)) ||
      this.createRequest(
        agent,
        rec.requestRef ??
          rec.requestId ??
          rec.messageId ??
          rec.uuid ??
          `request-${this.requests.size + 1}`,
        ch,
      );
    if (rec.requestId) this.byRequestId.set(rec.requestId, req.id);
    if (rec.messageId) this.byMessageId.set(rec.messageId, req.id);
    return req;
  }

  private createRequest(agent: AgentState, id: string, ch: Changes): RequestState {
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
    if (this.requests.size === 0) ch.diagnostics = true;
    const last = this.requests.get(agent.requestIds.at(-1) ?? '');
    if (last) this.markRequestAndTools(last, ch);
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
  private dropRequest(agent: AgentState, req: RequestState, ch: Changes): void {
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

  private markRequest(req: RequestState, ch: Changes): void {
    ch.requests.add(req.id);
    ch.agents.add(req.agentId);
    if (req.turnId) ch.turns.add(req.turnId);
    ch.session = true;
  }

  private ensureTool(
    agent: AgentState,
    req: RequestState,
    id: string,
    name: string,
    input: unknown,
    ts: string | null,
    ch: Changes,
  ): void {
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
        (this.tools.get(id) as ToolState).result = result;
        this.orphanResults.delete(id);
      }
      agent.toolCallIds.push(id);
      // An agent launched by this call may have been seen first: its parent is now known.
      const spawned = this.spawnOf.get(id);
      if (spawned?.kind === 'agent') ch.agents.add(spawned.agentId);
      const run = spawned?.kind === 'workflow' ? this.runs.get(spawned.runId) : undefined;
      if (run) this.markRun(run, ch);
    }
    if (!req.toolCallIds.includes(id)) req.toolCallIds.push(id);
    ch.toolCalls.add(id);
  }

  // --- derived state -----------------------------------------------------------------------

  private requestStatus(r: RequestState): RequestStatus {
    if (r.stopReason !== null) return 'complete';
    if (r.error) return 'error';
    if (r.interruptedAt) return 'interrupted';
    // An idle session is not waiting on the model: a main request it left open is over.
    // Background sub-agents and workflow agents may still be running, so only the main agent.
    if (r.agentId === MAIN_AGENT_ID && this.idleMark !== null) {
      const start = requestStart(r);
      if (start === null || Date.parse(start) <= this.idleMark) return 'interrupted';
    }
    // Some versions never write stop_reason in sidechain transcripts, so a response that has
    // blocks is complete once anything shows it finished: a later request, a tool result,
    // or the end of its agent.
    const answered = r.blocks.size > 0;
    const agent = this.agents.get(r.agentId);
    const superseded = agent !== undefined && agent.requestIds.at(-1) !== r.id;
    if (superseded || (agent && this.agentEnded(agent)))
      return answered ? 'complete' : 'interrupted';
    if (answered && r.toolCallIds.some((id) => this.tools.get(id)?.result)) return 'complete';
    return this.live === 'closed' ? 'interrupted' : 'in-flight';
  }

  /** A sub-agent with an explicit end signal (never true for the main agent). */
  private agentEnded(a: AgentState): boolean {
    return this.agentEndStatus(a) !== null;
  }

  /** How a sub-agent ended, from any end signal; null while open (always for the main agent). */
  private agentEndStatus(a: AgentState): RunStatus | null {
    if (a.kind === 'main') return null;
    if (a.kind === 'workflow-agent') {
      const wf = this.workflowAgentEnd(a);
      if (wf) return wf;
    }
    if (a.end) return a.end.status;
    return a.finished ? 'complete' : null;
  }

  /** The agent's latest request may change status when the agent's end becomes known. */
  private markAgentTail(agentId: string, ch: Changes): void {
    const last = this.requests.get(this.agents.get(agentId)?.requestIds.at(-1) ?? '');
    if (last) this.markRequestAndTools(last, ch);
  }

  private markRequestAndTools(req: RequestState, ch: Changes): void {
    this.markRequest(req, ch);
    for (const id of req.toolCallIds) ch.toolCalls.add(id);
  }

  private turnState(t: TurnState): Pick<Turn, 'status' | 'endedAt'> {
    if (t.interruptedAt) return { status: 'interrupted', endedAt: t.interruptedAt };
    if (t.endMarkAt) return { status: 'complete', endedAt: t.endMarkAt };
    const isLatest = this.agents.get(t.agentId)?.turnIds.at(-1) === t.id;
    const active = this.live === 'busy' || this.live === 'waiting';
    const reqs = t.requestIds.flatMap((id) => this.requests.get(id) ?? []);
    const last = reqs.at(-1);
    if (!last)
      return isLatest && active
        ? { status: 'running', endedAt: null }
        : { status: 'complete', endedAt: t.startedAt };
    const view = this.requestView(last);
    const lastAt = view.endedAt ?? view.startedAt ?? t.startedAt;
    if (view.status === 'in-flight') return { status: 'running', endedAt: null };
    if (view.status === 'error') return { status: 'error', endedAt: lastAt };
    if (view.status === 'interrupted') return { status: 'interrupted', endedAt: lastAt };
    const tools = reqs.flatMap((r) => r.toolCallIds.flatMap((id) => this.tools.get(id) ?? []));
    if (tools.some((tool) => this.toolStatus(tool) === 'running'))
      return { status: 'running', endedAt: null };
    if (last.stopReason !== 'tool_use') return { status: 'complete', endedAt: lastAt };
    // The model asked for tools and they finished: the next request is due, unless the agent
    // has ended (killed, failed, finished) — then this turn ended with it.
    const agent = this.agents.get(t.agentId);
    const ended = agent ? this.agentEndStatus(agent) : null;
    if (ended && isLatest) return { status: ended, endedAt: lastAt };
    if (!isLatest) {
      const toolEnds = tools.flatMap((tool) => tool.result?.at ?? []);
      return { status: 'complete', endedAt: [lastAt, ...toolEnds].sort().at(-1) ?? lastAt };
    }
    return this.live === 'closed'
      ? { status: 'unknown', endedAt: null }
      : { status: 'running', endedAt: null };
  }

  private toolStatus(t: ToolState): ToolCall['status'] {
    if (t.result) return t.result.isError ? 'error' : 'complete';
    const agent = this.agents.get(t.agentId);
    const superseded = agent?.requestIds.at(-1) !== t.requestId;
    const ended = agent !== undefined && this.agentEnded(agent);
    return superseded || ended || this.live === 'closed' ? 'unknown' : 'running';
  }

  // --- views -------------------------------------------------------------------------------

  private sessionView(): SessionSummary {
    const base = this.source.summary;
    const requests = [...this.requests.values()];
    const main = this.agentView(this.agents.get(MAIN_AGENT_ID) as AgentState);
    return {
      ...base,
      title:
        pickTitle({
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
  private activityView(): { activity?: SessionActivity } {
    const requests: ModelRequest[] = [];
    const toolCalls: ToolCall[] = [];
    for (const agent of this.agents.values()) {
      const last = this.requests.get(agent.requestIds.at(-1) ?? '');
      if (!last) continue;
      requests.push(this.requestView(last));
      for (const id of last.toolCallIds) {
        const tool = this.tools.get(id);
        if (tool) toolCalls.push(this.toolView(tool));
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

  private isProbe(): boolean {
    const base = this.source.summary;
    return (
      base.tags?.includes('probe') === true ||
      this.customTitle === PROBE_NAME ||
      this.agentName === PROBE_NAME ||
      isProbeCwd(this.cwd ?? base.cwd)
    );
  }

  /**
   * The first main-agent prompt of that origin (any origin when null), cleaned for a title. A
   * person's slash command that the model never saw (/effort, /clear) is passed over unless
   * `localCommands` asks for it, as the last resort.
   */
  private firstPrompt(origin: TurnOrigin | null, localCommands = false): string | null {
    const main = this.agents.get(MAIN_AGENT_ID) as AgentState;
    for (const id of main.turnIds) {
      const t = this.turns.get(id);
      if (!t || (origin !== null && t.origin !== origin)) continue;
      // Boilerplate Claude Code writes itself, never what a session is about.
      if (t.origin === 'auto-continuation') continue;
      if (!localCommands && t.command && t.requestIds.length === 0) continue;
      const title = cleanPrompt(t.prompt);
      if (title) return title;
    }
    return null;
  }

  private exposedUsage(r: RequestState) {
    return this.requestStatus(r) === 'in-flight' ? null : r.usage;
  }

  private agentView(a: AgentState): AgentNode {
    const requests = a.requestIds.flatMap((id) => this.requests.get(id) ?? []);
    const last = requests.at(-1);
    const firstTurn = this.turns.get(a.turnIds[0] ?? '');
    const lastTurn = this.turns.get(a.turnIds.at(-1) ?? '');
    const lastTurnState = lastTurn ? this.turnState(lastTurn) : null;
    let status: AgentNode['status'];
    let endedAt: string | null;
    if (a.kind === 'main') {
      status =
        lastTurnState === null
          ? 'unknown'
          : lastTurnState.status === 'running' || lastTurnState.status === 'unknown'
            ? lastTurnState.status
            : 'complete';
      endedAt = status === 'running' ? null : (lastTurnState?.endedAt ?? null);
    } else if (a.kind === 'workflow-agent' && this.workflowAgentEnd(a)) {
      status = this.workflowAgentEnd(a) as RunStatus;
      endedAt = a.lastTs;
    } else if (a.end) {
      status = a.end.status;
      endedAt = a.end.at ?? a.lastTs;
    } else if (a.finished) {
      status = 'complete';
      endedAt = a.lastTs;
    } else {
      status = this.live === 'closed' ? 'unknown' : 'running';
      endedAt = null;
    }
    const run = a.workflowRunId ? this.runs.get(a.workflowRunId) : undefined;
    const journal = run?.journal.get(a.id);
    const spawnedBy = run ? run.toolCallId : a.spawnedByToolCallId;
    const spawner = spawnedBy ? this.tools.get(spawnedBy) : undefined;
    const spawnerInput = (spawner?.input ?? {}) as { description?: unknown };
    return {
      id: a.id,
      kind: a.kind,
      parentId:
        a.kind === 'main'
          ? null
          : spawner && spawner.agentId !== a.id
            ? spawner.agentId
            : a.parentId,
      spawnedByToolCallId: spawner ? spawner.id : null,
      agentType: a.agentType,
      label:
        journal?.label ??
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
  private workflowAgentEnd(a: AgentState): RunStatus | null {
    const run = a.workflowRunId ? this.runs.get(a.workflowRunId) : undefined;
    if (!run) return null;
    const outcome = run.journal.get(a.id)?.outcome;
    if (outcome === 'result') return 'complete';
    if (outcome === 'failed' || isRetried(run, a.id)) return 'error';
    return run.final?.status ?? run.notified?.status ?? null;
  }

  private workflowView(r: RunState): WorkflowRun {
    const tool = r.toolCallId ? this.tools.get(r.toolCallId) : undefined;
    const status: RunStatus =
      r.final?.status ?? r.notified?.status ?? (this.live === 'closed' ? 'unknown' : 'running');
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
      endedAt:
        status === 'running' || status === 'unknown'
          ? null
          : (r.final?.endedAt ?? r.notified?.at ?? null),
    };
  }

  private turnView(t: TurnState): Turn {
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

  private requestView(r: RequestState): ModelRequest {
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

  private toolView(t: ToolState): ToolCall {
    const endedAt = t.result?.at ?? null;
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
    };
  }

  private diagnosticsView(): Diagnostics {
    return {
      unknownRecordTypes: { ...this.diag.unknownRecordTypes },
      parseErrors: this.diag.parseErrors,
      unavailable:
        this.requests.size > 0 && !this.sawApiRequest ? ['request-detail', 'in-flight'] : [],
    };
  }
}

const PREVIEW_CHARS = 500;
/** Milliseconds between two ISO times, or null when either is missing or unparsable. */
function durationBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/** Diagnostics counter for requests dropped by `dropRequest`. */
const SUPERSEDED = 'superseded-request';

/** No reply, no error, no interrupt: the request was abandoned before the model answered. */
const silentlyAbandoned = (r: RequestState) =>
  r.blocks.size === 0 && r.stopReason === null && r.error === null && r.interruptedAt === null;

/** `<status>` of a task notification → how the background agent ended. */
const NOTIFIED_STATUS: Record<string, RunStatus> = {
  completed: 'complete',
  failed: 'error',
  killed: 'interrupted',
  stopped: 'interrupted',
};

/** First characters of a tool result as text; non-text blocks become "[type]". */
function preview(content: unknown): string {
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content))
    text = content
      .map((part) => {
        const p = (part ?? {}) as { type?: unknown; text?: unknown };
        if (p.type === 'text' && typeof p.text === 'string') return p.text;
        // String() of an array joins it recursively: a nested one would overflow the stack.
        return `[${typeof p.type === 'object' && p.type !== null ? 'object' : String(p.type)}]`;
      })
      .join('\n');
  else text = content === undefined ? '' : jsonText(content);
  return text.slice(0, PREVIEW_CHARS);
}

/** JSON text of `value`; empty when it is nested too deep to serialise. */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

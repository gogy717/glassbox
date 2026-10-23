import {
  createDemoQuotas,
  createDemoSessions,
  createDemoSnapshot,
  DEMO_SESSION_ID,
} from '../core/fixtures/demo.js';
import type {
  AgentNode,
  IsoTime,
  ModelRequest,
  QuotaSnapshot,
  RequestDetail,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
  ToolCall,
  Turn,
} from '../core/model.js';
import { MAIN_AGENT_ID } from '../core/model.js';
import { emptyUsage, sumUsage } from '../core/usage.js';
import type { AppStore } from './app.js';
import { compareSessions } from './store.js';

const TICK_MS = 2000;
/** Ticks a main-agent request stays in flight, and a tool stays running. */
const THINK_TICKS = 2;
const TOOL_TICKS = 1;
const IDLE_TICKS = 2;
/** Requests per demo turn; all but the last call a tool. */
const REQUESTS_PER_TURN = 3;

const DEMO_TOOLS: { name: string; input: unknown; result: string }[] = [
  { name: 'Read', input: { file_path: '/repo/src/server/app.ts' }, result: '1\timport { Hono }…' },
  { name: 'Grep', input: { pattern: 'onPatch', path: 'src' }, result: 'src/server/store.ts:142' },
  { name: 'Bash', input: { command: 'npm test', description: 'Run tests' }, result: '89 passed' },
];

type Lane =
  | { phase: 'thinking'; ticksLeft: number; requestId: string }
  | { phase: 'tool'; ticksLeft: number; requestId: string; toolId: string }
  | { phase: 'idle'; ticksLeft: number };

interface Changed {
  agents: Set<string>;
  turns: Set<string>;
  requests: Set<string>;
  toolCalls: Set<string>;
  workflows: Set<string>;
}

/**
 * Serves the demo fixture for `--demo`, and keeps it moving so the UI's live paths can be
 * built without a running Claude Code: every 2 s the main agent's in-flight request ages,
 * completes, calls a tool, starts the next request or turn; early ticks also finish the
 * fixture's running workflow.
 */
export class DemoStore implements AppStore {
  private readonly snap: SessionSnapshot;
  private readonly others: SessionSummary[];
  private readonly quotas: QuotaSnapshot[];
  private readonly sessionCbs = new Set<(s: SessionSummary[]) => void>();
  private readonly patchCbs = new Set<(p: SessionPatch) => void>();
  private timer: NodeJS.Timeout | null = null;
  private tickNo = 0;
  private serial = 0;
  private lane: Lane;

  constructor() {
    const now = new Date();
    this.snap = createDemoSnapshot(now);
    this.others = createDemoSessions(now).filter((s) => s.id !== DEMO_SESSION_ID);
    this.quotas = createDemoQuotas(now);
    const inFlight = this.snap.requests.find(
      (r) => r.agentId === MAIN_AGENT_ID && r.status === 'in-flight',
    );
    this.lane = inFlight
      ? { phase: 'thinking', ticksLeft: THINK_TICKS, requestId: inFlight.id }
      : { phase: 'idle', ticksLeft: IDLE_TICKS };
  }

  async start(): Promise<void> {
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sessionCbs.clear();
    this.patchCbs.clear();
  }

  listSessions(): SessionSummary[] {
    return [structuredClone(this.snap.session), ...this.others].sort(compareSessions);
  }

  async getSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    return sessionId === DEMO_SESSION_ID ? structuredClone(this.snap) : null;
  }

  async getRequestDetail(sessionId: string, requestId: string): Promise<RequestDetail | null> {
    const request = this.findRequest(sessionId, requestId);
    if (!request?.hasDetail) return null;
    return {
      requestId,
      completeness: 'full',
      notes: [],
      params: {
        model: request.model,
        max_tokens: 64000,
        output_config: { effort: request.effort },
      },
      system: [{ type: 'text', text: 'You are Claude Code… (demo)' }],
      tools: [
        { name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object' } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Busy sessions first (demo)' }] }],
    };
  }

  async getToolResult(
    sessionId: string,
    toolCallId: string,
  ): Promise<{ found: boolean; result: unknown }> {
    const tool =
      sessionId === DEMO_SESSION_ID
        ? this.snap.toolCalls.find((t) => t.id === toolCallId && t.hasFullResult)
        : undefined;
    return tool ? { found: true, result: tool.resultPreview } : { found: false, result: undefined };
  }

  /** Demo mode has exactly one session; scripted runs land in it. */
  async expectSession(sessionId: string): Promise<boolean> {
    return sessionId === DEMO_SESSION_ID;
  }

  listQuotas(): QuotaSnapshot[] {
    return structuredClone(this.quotas);
  }

  /** The demo quota never changes. */
  onQuota(_cb: (q: QuotaSnapshot[]) => void): () => void {
    return () => {};
  }

  onSessions(cb: (s: SessionSummary[]) => void): () => void {
    this.sessionCbs.add(cb);
    return () => {
      this.sessionCbs.delete(cb);
    };
  }

  onPatch(sessionId: string, cb: (p: SessionPatch) => void): () => void {
    if (sessionId !== DEMO_SESSION_ID) return () => {};
    this.patchCbs.add(cb);
    return () => {
      this.patchCbs.delete(cb);
    };
  }

  // ── Simulation ────────────────────────────────────────────────────────────────────────

  private tick(): void {
    this.tickNo++;
    const now = new Date().toISOString();
    const changed: Changed = {
      agents: new Set(),
      turns: new Set(),
      requests: new Set(),
      toolCalls: new Set(),
      workflows: new Set(),
    };

    if (this.tickNo === 3) this.finishRunningTools(now, changed);
    if (this.tickNo === 5) this.finishWorkflow(now, changed);
    this.advanceLane(now, changed);

    for (const id of changed.turns) this.refreshTurn(id);
    for (const t of this.snap.turns) if (changed.turns.has(t.id)) changed.agents.add(t.agentId);
    for (const id of changed.agents) this.refreshAgent(id);
    this.refreshSession(now);

    const pick = <T extends { id: string }>(items: T[], ids: Set<string>) =>
      items.filter((x) => ids.has(x.id));
    const patch: SessionPatch = structuredClone({
      session: this.snap.session,
      agents: pick(this.snap.agents, changed.agents),
      turns: pick(this.snap.turns, changed.turns),
      requests: pick(this.snap.requests, changed.requests),
      toolCalls: pick(this.snap.toolCalls, changed.toolCalls),
      workflows: pick(this.snap.workflows, changed.workflows),
      diagnostics: null,
    });
    for (const cb of this.patchCbs) cb(patch);
    const list = this.listSessions();
    for (const cb of this.sessionCbs) cb(list);
  }

  private advanceLane(now: IsoTime, changed: Changed): void {
    const lane = this.lane;
    lane.ticksLeft--;
    if (lane.phase !== 'idle') changed.requests.add(lane.requestId);
    if (lane.ticksLeft > 0) return;

    if (lane.phase === 'thinking') {
      const request = this.request(lane.requestId);
      const turn = this.turn(request.turnId as string);
      const toolSpec =
        request.index < REQUESTS_PER_TURN ? DEMO_TOOLS[this.serial % DEMO_TOOLS.length] : null;
      this.completeRequest(request, now, toolSpec !== null);
      changed.turns.add(turn.id);
      if (toolSpec) {
        const tool = this.startTool(request, toolSpec, now);
        changed.toolCalls.add(tool.id);
        this.lane = {
          phase: 'tool',
          ticksLeft: TOOL_TICKS,
          requestId: request.id,
          toolId: tool.id,
        };
      } else {
        this.snap.session.live = 'idle';
        this.lane = { phase: 'idle', ticksLeft: IDLE_TICKS };
      }
    } else if (lane.phase === 'tool') {
      const tool = this.toolCall(lane.toolId);
      const spec = DEMO_TOOLS.find((t) => t.name === tool.name);
      this.completeTool(tool, now, spec?.result ?? 'ok');
      changed.toolCalls.add(tool.id);
      const turnId = this.request(lane.requestId).turnId as string;
      const next = this.startRequest(turnId, now);
      changed.requests.add(next.id);
      changed.turns.add(turnId);
      this.lane = { phase: 'thinking', ticksLeft: THINK_TICKS, requestId: next.id };
    } else {
      const turn = this.startTurn(now);
      const next = this.startRequest(turn.id, now);
      this.snap.session.live = 'busy';
      changed.turns.add(turn.id);
      changed.requests.add(next.id);
      this.lane = { phase: 'thinking', ticksLeft: THINK_TICKS, requestId: next.id };
    }
  }

  /** The fixture's running tools (a workflow agent's WebFetch) finish early on. */
  private finishRunningTools(now: IsoTime, changed: Changed): void {
    for (const tool of this.snap.toolCalls) {
      if (tool.status !== 'running' || tool.agentId === MAIN_AGENT_ID) continue;
      this.completeTool(tool, now, 'ok');
      changed.toolCalls.add(tool.id);
      changed.turns.add(this.request(tool.requestId).turnId as string);
    }
  }

  /** The workflow's last in-flight agent answers and the run completes. */
  private finishWorkflow(now: IsoTime, changed: Changed): void {
    for (const workflow of this.snap.workflows) {
      for (const request of this.snap.requests) {
        if (request.status !== 'in-flight' || !workflow.agentIds.includes(request.agentId))
          continue;
        this.completeRequest(request, now, false);
        request.blocks.push({ kind: 'text', text: '{"summary": "…"}', at: now });
        changed.requests.add(request.id);
        changed.turns.add(request.turnId as string);
      }
      workflow.status = 'complete';
      workflow.endedAt = now;
      changed.workflows.add(workflow.id);
    }
  }

  private startTurn(now: IsoTime): Turn {
    const index = this.snap.turns.filter((t) => t.agentId === MAIN_AGENT_ID).length + 1;
    const turn: Turn = {
      id: `turn_live_${++this.serial}`,
      agentId: MAIN_AGENT_ID,
      index,
      origin: 'human',
      prompt: `Demo prompt #${index}: keep going`,
      startedAt: now,
      endedAt: null,
      status: 'running',
      requestIds: [],
    };
    this.snap.turns.push(turn);
    return turn;
  }

  private startRequest(turnId: string, now: IsoTime): ModelRequest {
    const turn = this.turn(turnId);
    const request: ModelRequest = {
      id: `req_live_${++this.serial}`,
      agentId: turn.agentId,
      turnId,
      index: turn.requestIds.length + 1,
      model: 'claude-opus-5-5',
      effort: 'max',
      startedAt: now,
      firstBlockAt: null,
      endedAt: null,
      status: 'in-flight',
      stopReason: null,
      usage: null,
      blocks: [],
      toolCallIds: [],
      hasDetail: true,
      error: null,
    };
    turn.requestIds.push(request.id);
    this.snap.requests.push(request);
    return request;
  }

  private completeRequest(request: ModelRequest, now: IsoTime, callsTool: boolean): void {
    const started = Date.parse(request.startedAt ?? now);
    const elapsed = Math.max(1000, Date.parse(now) - started);
    const firstBlockAt = new Date(started + elapsed * 0.6).toISOString();
    const n = ++this.serial;
    const context = 60_000 + n * 3_500;
    request.status = 'complete';
    request.endedAt = now;
    request.firstBlockAt = firstBlockAt;
    request.stopReason = callsTool ? 'tool_use' : 'end_turn';
    request.usage = {
      ...emptyUsage(),
      input: 6,
      cacheRead: context - 3_500 - 6,
      cacheWrite: 3_500,
      cacheWrite1h: 3_500,
      output: 600 + (n % 4) * 300,
      thinking: 300 + (n % 3) * 150,
    };
    request.blocks.push({
      kind: 'thinking',
      text: n % 2 ? 'Checking the next file before changing anything.' : null,
      durationMs: Math.round(elapsed * 0.6),
      at: firstBlockAt,
    });
    if (!callsTool) request.blocks.push({ kind: 'text', text: 'Done with this step.', at: now });
  }

  private startTool(
    request: ModelRequest,
    spec: { name: string; input: unknown },
    now: IsoTime,
  ): ToolCall {
    const tool: ToolCall = {
      id: `tu_live_${++this.serial}`,
      agentId: request.agentId,
      requestId: request.id,
      name: spec.name,
      input: structuredClone(spec.input),
      status: 'running',
      startedAt: now,
      endedAt: null,
      durationMs: null,
      resultPreview: null,
      hasFullResult: false,
      spawned: null,
    };
    request.toolCallIds.push(tool.id);
    request.blocks.push({ kind: 'tool-use', toolCallId: tool.id, at: now });
    this.snap.toolCalls.push(tool);
    return tool;
  }

  private completeTool(tool: ToolCall, now: IsoTime, result: string): void {
    tool.status = 'complete';
    tool.endedAt = now;
    tool.durationMs = Date.parse(now) - Date.parse(tool.startedAt ?? now);
    tool.resultPreview = result;
    tool.hasFullResult = true;
  }

  private refreshTurn(turnId: string): void {
    const turn = this.turn(turnId);
    const requests = turn.requestIds.map((id) => this.request(id));
    const running =
      requests.some((r) => r.status === 'in-flight') ||
      this.snap.toolCalls.some(
        (t) => t.status === 'running' && turn.requestIds.includes(t.requestId),
      );
    turn.status = running ? 'running' : 'complete';
    turn.endedAt = running ? null : (requests.at(-1)?.endedAt ?? null);
  }

  private refreshAgent(agentId: string): void {
    const agent = this.snap.agents.find((a) => a.id === agentId) as AgentNode;
    const requests = this.snap.requests.filter((r) => r.agentId === agentId);
    const turns = this.snap.turns.filter((t) => t.agentId === agentId);
    const running = turns.some((t) => t.status === 'running');
    agent.status = running ? 'running' : 'complete';
    agent.startedAt = requests[0]?.startedAt ?? null;
    agent.endedAt = running ? null : (requests.at(-1)?.endedAt ?? null);
    agent.usage = sumUsage(requests.map((r) => r.usage));
    agent.counts = {
      turns: turns.length,
      requests: requests.length,
      toolCalls: this.snap.toolCalls.filter((t) => t.agentId === agentId).length,
    };
  }

  private refreshSession(now: IsoTime): void {
    const s = this.snap;
    s.session.updatedAt = now;
    s.session.usage = sumUsage(s.requests.map((r) => r.usage));
    s.session.counts = {
      turns: s.turns.filter((t) => t.agentId === MAIN_AGENT_ID).length,
      requests: s.requests.length,
      toolCalls: s.toolCalls.length,
      agents: s.agents.length,
    };
  }

  private findRequest(sessionId: string, requestId: string): ModelRequest | undefined {
    if (sessionId !== DEMO_SESSION_ID) return undefined;
    return this.snap.requests.find((r) => r.id === requestId);
  }

  private request(id: string): ModelRequest {
    return this.snap.requests.find((r) => r.id === id) as ModelRequest;
  }

  private turn(id: string): Turn {
    return this.snap.turns.find((t) => t.id === id) as Turn;
  }

  private toolCall(id: string): ToolCall {
    return this.snap.toolCalls.find((t) => t.id === id) as ToolCall;
  }
}

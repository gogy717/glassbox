import { activityField, latestTurn } from '../core/activity.js';
import {
  createDemoQuotas,
  createDemoSessions,
  createDemoSideSnapshots,
  createDemoSnapshot,
  DEMO_SESSION_ID,
} from '../core/fixtures/demo.js';
import { demoRequestDetail } from '../core/fixtures/demo-detail.js';
import { lastReplyField, requestsById } from '../core/last-reply.js';
import type {
  AgentNode,
  IsoTime,
  ModelRequest,
  QuotaSnapshot,
  RequestDetail,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
  TokenUsage,
  ToolCall,
  Turn,
} from '../core/model.js';
import { MAIN_AGENT_ID } from '../core/model.js';
import { emptyUsage, sumUsage } from '../core/usage.js';
import { type SessionContextBill, sessionBill } from '../shared/context-bill.js';
import { contextUse } from '../shared/context-use.js';
import {
  MINUTE_MS,
  RATE_MINUTES,
  type RateCoverage,
  type RateKind,
  type TokenRate,
} from '../shared/rate.js';
import { detectTrouble } from '../shared/trouble.js';
import type { AppStore } from './app.js';
import { DEMO_SHAPE_LATER, stageCacheBreaks } from './demo-cache-breaks.js';
import { troubleLabel } from './open-session.js';
import { QuotaBurnService } from './quota-burn.js';
import { createDemoBurn } from './quota-burn-demo.js';
import { RateTracker } from './rate.js';
import { RulesService } from './rules.js';
import { createDemoRules, DEMO_HOME } from './rules-demo.js';
import { compareSessions, isActive, listedSummary, withRepo } from './store.js';
import { type WeekRead, WeekService, type WeekStore } from './week.js';
import { demoRepo, demoWeek } from './week-demo.js';

const TICK_MS = 2000;

/**
 * Believable token traffic for the rate: tokens per minute, per agent and token kind, around
 * which each simulated session's spend wanders. The Claude Code session dominates, as the open
 * demo session does; Grok works in bursts.
 */
const DEMO_TRAFFIC: {
  session: string;
  agent: string;
  perMin: Record<RateKind, number>;
  duty: number;
}[] = [
  {
    session: 'demo-rate-claude',
    agent: 'claude-code',
    perMin: { input: 2_400, cacheRead: 880_000, cacheWrite: 36_000, output: 9_500 },
    duty: 1,
  },
  {
    session: 'demo-rate-codex',
    agent: 'codex',
    perMin: { input: 22_000, cacheRead: 160_000, cacheWrite: 0, output: 3_200 },
    duty: 0.9,
  },
  {
    session: 'demo-rate-grok',
    agent: 'grok',
    perMin: { input: 18_000, cacheRead: 40_000, cacheWrite: 0, output: 2_100 },
    duty: 0.3,
  },
];
/** How often the simulated sessions report while the past hour is filled in. */
const HISTORY_STEP_MS = 30_000;
/** Ticks a main-agent request stays in flight, and a tool stays running. */
const THINK_TICKS = 2;
const TOOL_TICKS = 1;
const IDLE_TICKS = 2;
/** Requests per demo turn; all but the last call a tool. */
const REQUESTS_PER_TURN = 3;

/** A demo step: what the agent says it will do, then the tool it calls and what came back. */
interface DemoTool {
  said?: string;
  name: string;
  input: unknown;
  result: string;
  failed?: boolean;
}

const DEMO_TOOLS: DemoTool[] = [
  {
    said: 'Reading the server’s routes before touching the stream.',
    name: 'Read',
    input: { file_path: '/repo/src/server/app.ts' },
    result: '1\timport { Hono }…',
  },
  {
    said: 'Now to find where each patch is sent from.',
    name: 'Grep',
    input: { pattern: 'onPatch', path: 'src' },
    result: 'src/server/store.ts:142',
  },
  {
    said: 'Running the tests before I change anything.',
    name: 'Bash',
    input: { command: 'npm test', description: 'Run tests' },
    result: '89 passed',
  },
];

/**
 * Now and then the demo agent is stuck: in one prompt of every `STUCK_EVERY`, the first of them
 * among the demo's own, it runs a flaky test again and again, each time a model call of its own,
 * failing `STUCK_FAILS` times until a run passes, then answers; so the signs of trouble have
 * something to show.
 */
const FLAKY = {
  said: 'The login test is flaky; running it again.',
  name: 'Bash',
  input: { command: 'npm test -- login', description: 'Run the login test' },
};
const FLAKY_FAIL = 'FAIL tests/login.spec.ts > signs in\n  TimeoutError: waiting for #submit';
const FLAKY_PASS = '1 passed (3.2s)';
const STUCK_EVERY = 4;
const STUCK_FAILS = 4;

/**
 * A second running session, its main context nearly full: 184K of Claude Sonnet's 200K window
 * after one long prompt of edits and test runs, its next call in flight. It stays as it is, so
 * Home's Working row and the sidebar say "Context 92%" whenever the demo runs. Synthetic: no
 * real project, path or transcript.
 */
export const CONTEXT_DEMO_ID = 'claude-code:demo-0000-4000-8000-000000000004';
const CONTEXT_DEMO_CALLS = 22;
const CONTEXT_DEMO_FILES = ['editor.ts', 'store.ts', 'toolbar.ts', 'history.ts', 'shortcuts.ts'];

/** A request's usage that read `context` tokens, the last 3K of them new to the cache. */
function readUsage(context: number, output: number): TokenUsage {
  return {
    ...emptyUsage(),
    input: 8,
    cacheRead: context - 3_000 - 8,
    cacheWrite: 3_000,
    cacheWrite1h: 3_000,
    output,
    thinking: Math.round(output / 2),
  };
}

function createContextDemo(now: Date): SessionSnapshot {
  const t0 = now.getTime() - (CONTEXT_DEMO_CALLS * 2 + 3) * 60_000;
  const at = (min: number): IsoTime => new Date(t0 + min * 60_000).toISOString();
  const cwd = '/Users/demo/Dev/notes';
  const turnId = 'turn_n1';
  const requests: ModelRequest[] = [];
  const toolCalls: ToolCall[] = [];
  for (let i = 0; i < CONTEXT_DEMO_CALLS; i++) {
    const id = `req_n${i + 1}`;
    const toolId = `tu_n${i + 1}`;
    const file = `${cwd}/src/${CONTEXT_DEMO_FILES[i % CONTEXT_DEMO_FILES.length]}`;
    const tool =
      i % 3 === 0
        ? { name: 'Read', input: { file_path: file }, result: '1\texport class Editor {…' }
        : i % 3 === 1
          ? {
              name: 'Edit',
              input: { file_path: file, old_string: `state${i}`, new_string: `store.state${i}` },
              result: 'The file has been updated.',
            }
          : {
              name: 'Bash',
              input: { command: `npm test -- editor --shard=${i}`, description: 'Run the tests' },
              result: `${40 + i} passed`,
            };
    const start = 1 + i * 2;
    // From 30K up to 184K, a little more each call: the files read stay in the context.
    const context = Math.round(30_000 + (154_000 * i) / (CONTEXT_DEMO_CALLS - 1));
    requests.push({
      id,
      agentId: MAIN_AGENT_ID,
      turnId,
      index: i + 1,
      model: 'claude-sonnet-5-5',
      effort: 'high',
      startedAt: at(start),
      firstBlockAt: at(start + 0.5),
      endedAt: at(start + 1),
      status: 'complete',
      stopReason: 'tool_use',
      usage: readUsage(context, 700 + (i % 4) * 250),
      blocks: [
        { kind: 'thinking', text: null, durationMs: 20_000, at: at(start + 0.5) },
        { kind: 'tool-use', toolCallId: toolId, at: at(start + 1) },
      ],
      toolCallIds: [toolId],
      hasDetail: true,
      error: null,
    });
    toolCalls.push({
      id: toolId,
      agentId: MAIN_AGENT_ID,
      requestId: id,
      name: tool.name,
      input: tool.input,
      status: 'complete',
      startedAt: at(start + 1),
      endedAt: at(start + 1.5),
      durationMs: 30_000,
      resultPreview: tool.result,
      hasFullResult: true,
      spawned: null,
    });
  }
  // The next call, in flight: what the agent thinks over with a context nearly full.
  requests.push({
    id: `req_n${CONTEXT_DEMO_CALLS + 1}`,
    agentId: MAIN_AGENT_ID,
    turnId,
    index: CONTEXT_DEMO_CALLS + 1,
    model: 'claude-sonnet-5-5',
    effort: 'high',
    startedAt: at(CONTEXT_DEMO_CALLS * 2 + 1),
    firstBlockAt: null,
    endedAt: null,
    status: 'in-flight',
    stopReason: null,
    usage: null,
    blocks: [],
    toolCallIds: [],
    hasDetail: true,
    error: null,
  });
  const usage = sumUsage(requests.map((r) => r.usage));
  const counts = { turns: 1, requests: requests.length, toolCalls: toolCalls.length };
  const startedAt = at(0);
  const updatedAt = requests.at(-1)?.startedAt ?? startedAt;
  return {
    session: {
      id: CONTEXT_DEMO_ID,
      agent: 'claude-code',
      nativeId: CONTEXT_DEMO_ID.slice('claude-code:'.length),
      title: 'Move the editor onto the new store',
      cwd,
      project: 'notes',
      startedAt,
      updatedAt,
      live: 'busy',
      version: '2.1.308',
      model: 'claude-sonnet-5-5',
      usage,
      counts: { ...counts, agents: 1 },
    },
    agents: [
      {
        id: MAIN_AGENT_ID,
        kind: 'main',
        parentId: null,
        spawnedByToolCallId: null,
        agentType: null,
        label: 'Main',
        workflowRunId: null,
        phase: null,
        model: 'claude-sonnet-5-5',
        status: 'running',
        startedAt,
        endedAt: null,
        usage,
        counts,
      },
    ],
    turns: [
      {
        id: turnId,
        agentId: MAIN_AGENT_ID,
        index: 1,
        origin: 'human',
        prompt: 'Move the editor, its toolbar and its undo history onto the new store',
        startedAt,
        endedAt: null,
        status: 'running',
        requestIds: requests.map((r) => r.id),
      },
    ],
    requests,
    toolCalls,
    workflows: [],
    diagnostics: { unknownRecordTypes: {}, parseErrors: 0, unavailable: [] },
  };
}

/** A snapshot's summary with what the server works out of a running session it has open. */
function withLiveFields(s: SessionSnapshot, now: number): SessionSummary {
  const {
    activity: _old,
    trouble: _sign,
    lastReply: _said,
    contextUse: _use,
    ...session
  } = s.session;
  const next: SessionSummary = {
    ...session,
    ...activityField({
      live: s.session.live,
      toolCalls: s.toolCalls,
      requests: s.requests,
      lastTurn: latestTurn(s.turns),
      updatedAt: s.session.updatedAt,
    }),
    ...lastReplyField({
      live: s.session.live,
      lastTurn: latestTurn(s.turns),
      request: requestsById(s.requests),
    }),
  };
  if (isActive(next.live)) {
    const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((x) => [x.id, x]));
    const input = {
      session: next,
      agents: byId(s.agents),
      turns: byId(s.turns),
      requests: byId(s.requests),
      toolCalls: byId(s.toolCalls),
    };
    next.trouble = detectTrouble(input, MAIN_AGENT_ID, now, troubleLabel)[0] ?? null;
    next.contextUse = contextUse(s.requests, MAIN_AGENT_ID);
  }
  return next;
}

/**
 * The demo session's MCP calls (package F, round 3): its main agent asks a `tracker` and a `docs`
 * server about the bug it fixes, one call failing, and its sub-agent reads the docs too. Each is
 * a call of the request named, started as that request ends, beside its other calls.
 */
const DEMO_MCP: {
  requestId: string;
  name: string;
  input: unknown;
  result: string;
  /** The whole result's characters: the preview is its start. */
  chars: number;
  sec: number;
  failed?: true;
}[] = [
  {
    requestId: 'req_m1',
    name: 'mcp__tracker__list_issues',
    input: { project: 'WEB', state: 'open', label: 'stream' },
    result: '[{"id":"WEB-412","title":"Patches arrive out of order after a reconnect"},…',
    chars: 3_840,
    sec: 0.9,
  },
  {
    requestId: 'req_m1',
    name: 'mcp__tracker__get_issue',
    input: { id: 'WEB-412' },
    result: 'WEB-412 · Patches arrive out of order after a reconnect\nSteps: open a session, …',
    chars: 2_150,
    sec: 0.6,
  },
  {
    requestId: 'req_m4',
    name: 'mcp__docs__search',
    input: { query: 'server-sent events reconnect Last-Event-ID', limit: 5 },
    result: '1. Server-sent events: reconnecting with Last-Event-ID\n2. EventSource retry…',
    chars: 11_400,
    sec: 1.8,
  },
  {
    requestId: 'req_m4',
    name: 'mcp__tracker__add_comment',
    input: { id: 'WEB-412', body: 'Fixed by ordering patches by sequence number.' },
    result: 'tracker: issue WEB-412 is locked',
    chars: 32,
    sec: 1.2,
    failed: true,
  },
  {
    requestId: 'req_s2',
    name: 'mcp__docs__fetch',
    input: { url: 'https://docs.example.com/sse#reconnect' },
    result: '# Reconnecting\nWhen the connection drops, the client waits `retry` ms, then…',
    chars: 8_900,
    sec: 1.1,
  },
];

/** Adds `DEMO_MCP` to the demo session, its requests' calls, and its counts. */
function withDemoMcp(snap: SessionSnapshot): void {
  DEMO_MCP.forEach((c, i) => {
    const request = snap.requests.find((r) => r.id === c.requestId);
    if (!request?.endedAt) return;
    const start = Date.parse(request.endedAt) + 100 * (request.toolCallIds.length + 1);
    const tool: ToolCall = {
      id: `tu_mcp_${i + 1}`,
      agentId: request.agentId,
      requestId: request.id,
      name: c.name,
      input: c.input,
      status: c.failed ? 'error' : 'complete',
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(start + c.sec * 1000).toISOString(),
      durationMs: Math.round(c.sec * 1000),
      resultPreview: c.result,
      hasFullResult: true,
      spawned: null,
      resultChars: c.chars,
    };
    request.toolCallIds.push(tool.id);
    request.blocks.push({ kind: 'tool-use', toolCallId: tool.id, at: tool.startedAt as IsoTime });
    snap.toolCalls.push(tool);
    const agent = snap.agents.find((a) => a.id === request.agentId);
    if (agent?.counts) agent.counts.toolCalls += 1;
    if (snap.session.counts) snap.session.counts.toolCalls += 1;
  });
}

type Lane =
  | { phase: 'thinking'; ticksLeft: number; requestId: string }
  | { phase: 'tool'; ticksLeft: number; requestId: string; toolId: string; tool: DemoTool }
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
 * fixture's running workflow. Every couple of minutes the agent is stuck for a while on a flaky
 * test (`nextTool`), so the signs of trouble show.
 */
export class DemoStore implements AppStore, WeekStore {
  private readonly snap: SessionSnapshot;
  private readonly others: SessionSummary[];
  /**
   * The other listed sessions: they open but never change. All finished, but for the one near
   * its window (`CONTEXT_DEMO_ID`), which runs on the spot.
   */
  private readonly sides: SessionSnapshot[];
  private readonly quotas: QuotaSnapshot[];
  /** The rest of the week behind the weekly receipt: read by the week only, never listed. */
  private readonly weekBehind: SessionSnapshot[];
  /** The weekly receipt's data, read from the demo's sessions and the week behind them. */
  readonly week: WeekService = new WeekService(this, { repoOf: demoRepo });
  /** A permission history behind the demo's sessions: read by Rules only, never listed. */
  private readonly rulesBehind: SessionSnapshot[];
  /** The Rules page's data: the demo's sessions, the week behind them, and that history. */
  readonly rules: RulesService;
  /** The last hours behind the quota's "Who used it": read by it only, never listed. */
  private readonly burnBehind: SessionSnapshot[];
  /** Who used the plan window: the demo's sessions, the week behind them, and those hours. */
  readonly burn: QuotaBurnService;
  private readonly sessionCbs = new Set<(s: SessionSummary[]) => void>();
  private readonly patchCbs = new Set<(p: SessionPatch) => void>();
  private timer: NodeJS.Timeout | null = null;
  private tickNo = 0;
  private serial = 0;
  /** Prompts the demo has started, and the flaky test's runs in this one while it is stuck. */
  private prompts = 0;
  private flakyRuns: number | null = null;
  private lane: Lane;
  /** The token rate, counted from simulated sessions as the real store counts real ones. */
  private readonly rate: RateTracker;
  private rateClock: number;
  private readonly rateTotals = new Map<string, TokenUsage>();
  private readonly rateCbs = new Set<(r: TokenRate) => void>();
  /** A seeded generator: the same believable traffic on every run. */
  private seed = 0x2f6e2b1;

  constructor() {
    const now = new Date();
    // With a prompt-cache break of each kind, which only the demo server serves.
    this.snap = stageCacheBreaks(createDemoSnapshot(now));
    withDemoMcp(this.snap);
    const full = createContextDemo(now);
    full.session = withLiveFields(full, now.getTime());
    this.others = [
      ...createDemoSessions(now).filter((s) => s.id !== DEMO_SESSION_ID),
      full.session,
    ];
    this.sides = [...createDemoSideSnapshots(now), full];
    this.quotas = createDemoQuotas(now);
    const week = demoWeek(now.getTime());
    this.weekBehind = week.sessions;
    this.week.setWaitSource((id) => week.waits.get(id));
    const history = createDemoRules(now.getTime());
    this.rulesBehind = history.sessions;
    this.rules = new RulesService(
      {
        weekSessions: () => [...this.weekSessions(), ...this.rulesBehind.map((s) => s.session)],
        readSession: async (id) => {
          const behind = this.rulesBehind.find((s) => s.session.id === id);
          return behind ? { snapshot: structuredClone(behind), bytes: 0 } : this.readSession(id);
        },
      },
      {
        home: DEMO_HOME,
        readSettings: async (projects) => history.settings(projects),
        yourSettings: `${DEMO_HOME}/.claude/settings.json`,
      },
    );
    this.burnBehind = createDemoBurn(now.getTime());
    this.burn = new QuotaBurnService({
      weekSessions: () => [...this.weekSessions(), ...this.burnBehind.map((s) => s.session)],
      readSession: async (id) => {
        const behind = this.burnBehind.find((s) => s.session.id === id);
        return behind ? { snapshot: structuredClone(behind), bytes: 0 } : this.readSession(id);
      },
    });
    const inFlight = this.snap.requests.find(
      (r) => r.agentId === MAIN_AGENT_ID && r.status === 'in-flight',
    );
    this.lane = inFlight
      ? { phase: 'thinking', ticksLeft: THINK_TICKS, requestId: inFlight.id }
      : { phase: 'idle', ticksLeft: IDLE_TICKS };
    // Fill in the past hour, so the rate has history to show from the first second.
    this.rateClock = now.getTime() - RATE_MINUTES * MINUTE_MS;
    this.rate = new RateTracker(() => this.rateClock);
    this.spend(0);
    for (let t = this.rateClock + HISTORY_STEP_MS; t <= now.getTime(); t += HISTORY_STEP_MS) {
      this.rateClock = t;
      this.spend(HISTORY_STEP_MS);
    }
    this.refreshActivity();
  }

  /** Each simulated session spends `ms` worth of its traffic, and the tracker sees its totals. */
  private spend(ms: number): void {
    for (const s of DEMO_TRAFFIC) {
      const total = this.rateTotals.get(s.session) ?? emptyUsage();
      // Working or not this step, and how hard: a slow swell around its usual rate, plus noise,
      // as real sessions drift between long reads and quick steps.
      if (ms > 0 && this.random() < s.duty) {
        const phase = (this.rateClock / (11 * MINUTE_MS) + s.session.length) * Math.PI;
        const k = (ms / MINUTE_MS) * (0.8 + 0.35 * Math.sin(phase) + this.random() * 0.25);
        total.input += Math.round(s.perMin.input * k);
        total.cacheRead += Math.round(s.perMin.cacheRead * k);
        total.cacheWrite += Math.round(s.perMin.cacheWrite * k);
        total.output += Math.round(s.perMin.output * k);
      }
      this.rateTotals.set(s.session, total);
      this.rate.observe(s.session, s.agent, { ...total });
    }
  }

  private random(): number {
    this.seed = (this.seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  async start(): Promise<void> {
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  async stop(): Promise<void> {
    this.week.stop();
    this.rules.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sessionCbs.clear();
    this.patchCbs.clear();
  }

  listSessions(): SessionSummary[] {
    // Listed as the real store lists them: idle sessions say since when.
    return [structuredClone(this.snap.session), ...this.others]
      .map((s) => withRepo(listedSummary(s), demoRepo))
      .sort(compareSessions);
  }

  weekSessions(): SessionSummary[] {
    return [...this.listSessions(), ...this.weekBehind.map((s) => s.session)];
  }

  async readSession(sessionId: string): Promise<WeekRead | null> {
    const snap =
      this.snapshotOf(sessionId) ?? this.weekBehind.find((s) => s.session.id === sessionId);
    return snap ? { snapshot: structuredClone(snap), bytes: 0 } : null;
  }

  async getSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    // The week's sessions open too, though never listed: the Crossing panel shows their edits.
    const snap =
      this.snapshotOf(sessionId) ?? this.weekBehind.find((s) => s.session.id === sessionId);
    return snap ? structuredClone(snap) : null;
  }

  async getRequestDetail(sessionId: string, requestId: string): Promise<RequestDetail | null> {
    const snap = this.snapshotOf(sessionId);
    return snap && this.findRequest(sessionId, requestId)?.hasDetail
      ? demoRequestDetail(snap, requestId)
      : null;
  }

  /** What the agent's finished requests carried, from what the demo's requests sent. */
  async getContextBill(sessionId: string, agentId: string): Promise<SessionContextBill | null> {
    const snap = this.snapshotOf(sessionId);
    if (!snap) return null;
    const finished = snap.requests
      .filter((r) => r.agentId === agentId && r.status !== 'in-flight')
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
    return sessionBill(
      agentId,
      finished.map((request) => ({
        request,
        detail: request.hasDetail ? demoRequestDetail(snap, request.id) : null,
      })),
      snap.session.cwd,
    );
  }

  async getToolResult(
    sessionId: string,
    toolCallId: string,
  ): Promise<{ found: boolean; result: unknown }> {
    const tool = this.snapshotOf(sessionId)?.toolCalls.find(
      (t) => t.id === toolCallId && t.hasFullResult,
    );
    return tool ? { found: true, result: tool.resultPreview } : { found: false, result: undefined };
  }

  /** Demo mode has exactly one session; scripted runs land in it. */
  async expectSession(sessionId: string): Promise<boolean> {
    return sessionId === DEMO_SESSION_ID;
  }

  listQuotas(): QuotaSnapshot[] {
    return structuredClone(this.quotas);
  }

  getRate(): TokenRate {
    return this.rate.snapshot(this.coverage());
  }

  /**
   * The demo's own running sessions, as the real store covers its own: each one counted. Not the
   * simulated spenders, which the list never shows.
   */
  private coverage(): RateCoverage {
    const c: RateCoverage = { running: 0, counted: 0, agents: {} };
    for (const s of this.listSessions()) {
      if (!isActive(s.live)) continue;
      const agent = c.agents[s.agent] ?? { running: 0, counted: 0 };
      c.agents[s.agent] = agent;
      c.running++;
      c.counted++;
      agent.running++;
      agent.counted++;
    }
    return c;
  }

  onRate(cb: (r: TokenRate) => void): () => void {
    this.rateCbs.add(cb);
    return () => this.rateCbs.delete(cb);
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
    // The rate moves with the clock: the simulated sessions spend another tick's worth.
    this.rateClock = Date.now();
    this.spend(TICK_MS);
    const rate = this.getRate();
    for (const cb of this.rateCbs) cb(rate);
  }

  private advanceLane(now: IsoTime, changed: Changed): void {
    const lane = this.lane;
    lane.ticksLeft--;
    if (lane.phase !== 'idle') changed.requests.add(lane.requestId);
    if (lane.ticksLeft > 0) return;

    if (lane.phase === 'thinking') {
      const request = this.request(lane.requestId);
      const turn = this.turn(request.turnId as string);
      const toolSpec = this.nextTool(request);
      this.completeRequest(request, now, toolSpec !== null, toolSpec?.said);
      changed.turns.add(turn.id);
      if (toolSpec) {
        const tool = this.startTool(request, toolSpec, now);
        changed.toolCalls.add(tool.id);
        this.lane = {
          phase: 'tool',
          ticksLeft: TOOL_TICKS,
          requestId: request.id,
          toolId: tool.id,
          tool: toolSpec,
        };
      } else {
        this.snap.session.live = 'idle';
        this.lane = { phase: 'idle', ticksLeft: IDLE_TICKS };
      }
    } else if (lane.phase === 'tool') {
      const tool = this.toolCall(lane.toolId);
      this.completeTool(tool, now, lane.tool.result, lane.tool.failed);
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

  /**
   * The tool the request that just finished calls, or null when it answers: the usual round, two
   * calls a prompt; while the agent is stuck, the flaky test until a run passes.
   */
  private nextTool(request: ModelRequest): DemoTool | null {
    if (this.flakyRuns !== null) {
      const run = this.flakyRuns++;
      if (run < STUCK_FAILS) return { ...FLAKY, result: FLAKY_FAIL, failed: true };
      if (run === STUCK_FAILS) return { ...FLAKY, result: FLAKY_PASS };
      return null;
    }
    if (request.index >= REQUESTS_PER_TURN) return null;
    return DEMO_TOOLS[this.serial % DEMO_TOOLS.length] as DemoTool;
  }

  private startTurn(now: IsoTime): Turn {
    this.flakyRuns = this.prompts++ % STUCK_EVERY === 0 ? 0 : null;
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
      shapeHash: DEMO_SHAPE_LATER,
    };
    turn.requestIds.push(request.id);
    this.snap.requests.push(request);
    return request;
  }

  /** `said`: what the reply says before the tool it calls, as agents often do. */
  private completeRequest(
    request: ModelRequest,
    now: IsoTime,
    callsTool: boolean,
    said?: string,
  ): void {
    const started = Date.parse(request.startedAt ?? now);
    const elapsed = Math.max(1000, Date.parse(now) - started);
    const firstBlockAt = new Date(started + elapsed * 0.6).toISOString();
    const n = ++this.serial;
    // Grows quickly, then levels off under 140K: never near its 200K window, so the demo session
    // never drifts into a context nearly full.
    const context = 60_000 + Math.round(80_000 * (1 - Math.exp(-n / 120)));
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
    if (said) request.blocks.push({ kind: 'text', text: said, at: now });
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

  private completeTool(tool: ToolCall, now: IsoTime, result: string, failed = false): void {
    tool.status = failed ? 'error' : 'complete';
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
    this.refreshActivity();
  }

  /**
   * What the demo session is doing and what it last said, worked out as a parser would, and
   * its strongest sign of trouble and how full its context is, as the server reads them of a
   * session it has open.
   */
  private refreshActivity(): void {
    this.snap.session = withLiveFields(this.snap, Date.now());
  }

  private snapshotOf(sessionId: string): SessionSnapshot | undefined {
    return sessionId === DEMO_SESSION_ID
      ? this.snap
      : this.sides.find((s) => s.session.id === sessionId);
  }

  private findRequest(sessionId: string, requestId: string): ModelRequest | undefined {
    return this.snapshotOf(sessionId)?.requests.find((r) => r.id === requestId);
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

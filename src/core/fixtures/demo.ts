/**
 * A hand-made, realistic session used by the web UI in demo mode, by server tests and by
 * component tests. Times are relative to `now` so in-flight timers look alive.
 *
 * It covers: a main agent with three turns, a background sub-agent, a two-phase workflow
 * run with three agents, a failed tool, a running tool and an in-flight request.
 */
import type {
  AgentNode,
  IsoTime,
  ModelRequest,
  QuotaSnapshot,
  QuotaWindow,
  ResponseBlock,
  SessionSnapshot,
  SessionSummary,
  TokenUsage,
  ToolCall,
  Turn,
  WorkflowRun,
} from '../model.js';
import { MAIN_AGENT_ID } from '../model.js';
import { emptyUsage, sumUsage } from '../usage.js';

export const DEMO_SESSION_ID = 'claude-code:demo-0000-4000-8000-000000000001';

interface DemoRequestSpec {
  id: string;
  agentId: string;
  turnId: string;
  startSec: number;
  durSec: number | null;
  ctx: number;
  write: number;
  out: number;
  think: number;
  thinkingText?: string;
  text?: string;
  tools?: DemoToolSpec[];
  stop?: string;
  effort?: string;
}

interface DemoToolSpec {
  id: string;
  name: string;
  input: unknown;
  durSec: number | null;
  result?: string;
  error?: boolean;
  spawned?: ToolCall['spawned'];
}

export function createDemoSnapshot(now: Date = new Date()): SessionSnapshot {
  const t0 = now.getTime() - 40 * 60_000;
  const at = (sec: number): IsoTime => new Date(t0 + sec * 1000).toISOString();
  const nowSec = (now.getTime() - t0) / 1000;

  const requests: ModelRequest[] = [];
  const toolCalls: ToolCall[] = [];

  const usage = (s: DemoRequestSpec): TokenUsage => ({
    ...emptyUsage(),
    input: 6,
    cacheRead: s.ctx - s.write - 6,
    cacheWrite: s.write,
    cacheWrite1h: s.write,
    output: s.out,
    thinking: s.think,
  });

  const indexInTurn = new Map<string, number>();
  const addRequest = (s: DemoRequestSpec) => {
    const index = (indexInTurn.get(s.turnId) ?? 0) + 1;
    indexInTurn.set(s.turnId, index);
    const inFlight = s.durSec === null;
    const end = s.durSec === null ? null : s.startSec + s.durSec;
    const blocks: ResponseBlock[] = [];
    if (!inFlight) {
      const thinkEnd = s.startSec + (s.durSec ?? 0) * 0.6;
      blocks.push({
        kind: 'thinking',
        text: s.thinkingText ?? null,
        durationMs: Math.round((s.durSec ?? 0) * 600),
        at: at(thinkEnd),
      });
      if (s.text) blocks.push({ kind: 'text', text: s.text, at: at(thinkEnd + 0.5) });
    }
    const toolIds: string[] = [];
    let toolStart = end ?? nowSec;
    for (const tool of s.tools ?? []) {
      toolIds.push(tool.id);
      blocks.push({ kind: 'tool-use', toolCallId: tool.id, at: at(toolStart) });
      const toolEnd = tool.durSec === null ? null : toolStart + tool.durSec;
      toolCalls.push({
        id: tool.id,
        agentId: s.agentId,
        requestId: s.id,
        name: tool.name,
        input: tool.input,
        status: tool.durSec === null ? 'running' : tool.error ? 'error' : 'complete',
        startedAt: at(toolStart),
        endedAt: toolEnd === null ? null : at(toolEnd),
        durationMs: tool.durSec === null ? null : Math.round(tool.durSec * 1000),
        resultPreview: tool.result ?? null,
        hasFullResult: tool.result !== undefined,
        spawned: tool.spawned ?? null,
      });
      if (toolEnd !== null) toolStart = toolEnd;
    }
    requests.push({
      id: s.id,
      agentId: s.agentId,
      turnId: s.turnId,
      index,
      model: 'claude-opus-5-5',
      effort: s.effort ?? 'max',
      startedAt: at(s.startSec),
      firstBlockAt: inFlight ? null : at(s.startSec + (s.durSec ?? 0) * 0.6),
      endedAt: end === null ? null : at(end),
      status: inFlight ? 'in-flight' : 'complete',
      stopReason: inFlight ? null : (s.stop ?? (toolIds.length ? 'tool_use' : 'end_turn')),
      usage: inFlight ? null : usage(s),
      blocks,
      toolCallIds: toolIds,
      hasDetail: true,
      error: null,
    });
  };

  // ── Main agent, turn 1: inspect and fix a bug ──────────────────────────────────────────
  addRequest({
    id: 'req_m1',
    agentId: MAIN_AGENT_ID,
    turnId: 'turn_m1',
    startSec: 2,
    durSec: 14,
    ctx: 31_250,
    write: 31_000,
    out: 820,
    think: 610,
    thinkingText: 'Looking for where the session list is sorted before touching the UI.',
    text: 'Let me look at how sessions are discovered first.',
    tools: [
      {
        id: 'tu_m1a',
        name: 'Bash',
        input: { command: 'rg -n "sortSessions" src', description: 'Find session sorting' },
        durSec: 0.4,
        result: 'src/server/store.ts:41:export function sortSessions(',
      },
    ],
  });
  addRequest({
    id: 'req_m2',
    agentId: MAIN_AGENT_ID,
    turnId: 'turn_m1',
    startSec: 17,
    durSec: 21,
    ctx: 34_900,
    write: 3_400,
    out: 1_540,
    think: 1_100,
    tools: [
      {
        id: 'tu_m2a',
        name: 'Read',
        input: { file_path: '/repo/src/server/store.ts' },
        durSec: 0.15,
        result: '1\timport { readdir } from "node:fs/promises";\n2\t…',
      },
      {
        id: 'tu_m2b',
        name: 'Edit',
        input: {
          file_path: '/repo/src/server/store.ts',
          old_string: 'a.updatedAt',
          new_string: 'b.updatedAt',
        },
        durSec: 0.05,
        result: '<tool_use_error>String to replace not found in file.</tool_use_error>',
        error: true,
      },
    ],
  });
  addRequest({
    id: 'req_m3',
    agentId: MAIN_AGENT_ID,
    turnId: 'turn_m1',
    startSec: 39,
    durSec: 9,
    ctx: 37_800,
    write: 2_700,
    out: 420,
    think: 150,
    text: 'Fixed: busy sessions now sort first, then by most recent update.',
  });

  // ── Main agent, turn 2: spawn a background sub-agent and a workflow ────────────────────
  addRequest({
    id: 'req_m4',
    agentId: MAIN_AGENT_ID,
    turnId: 'turn_m2',
    startSec: 300,
    durSec: 48,
    ctx: 52_400,
    write: 14_300,
    out: 3_900,
    think: 3_100,
    thinkingText: 'Splitting the research: one explorer for the parser, a workflow for the rest.',
    tools: [
      {
        id: 'tu_m4a',
        name: 'Agent',
        input: {
          description: 'Explore transcript format',
          subagent_type: 'Explore',
          prompt: 'Map the record types…',
          run_in_background: true,
        },
        durSec: 0.1,
        result: 'Async agent launched successfully.',
        spawned: { kind: 'agent', agentId: 'a1b2c3d4e5f60718' },
      },
      {
        id: 'tu_m4b',
        name: 'Workflow',
        input: { script: "export const meta = { name: 'cc-recon', … }" },
        durSec: 0.15,
        result: 'Workflow launched in background.',
        spawned: { kind: 'workflow', runId: 'wf_demo0001-abc' },
      },
    ],
  });
  addRequest({
    id: 'req_m5',
    agentId: MAIN_AGENT_ID,
    turnId: 'turn_m2',
    startSec: 349,
    durSec: 6,
    ctx: 56_500,
    write: 4_100,
    out: 260,
    think: 90,
    text: 'Both are running in the background. I will report back when they finish.',
  });

  // ── Main agent, turn 3: a long max-effort request still in flight ──────────────────────
  addRequest({
    id: 'req_m6',
    agentId: MAIN_AGENT_ID,
    turnId: 'turn_m3',
    startSec: nowSec - 83,
    durSec: null,
    ctx: 0,
    write: 0,
    out: 0,
    think: 0,
  });

  // ── Sub-agent (Explore), complete ──────────────────────────────────────────────────────
  for (let i = 0; i < 4; i++) {
    addRequest({
      id: `req_s${i + 1}`,
      agentId: 'a1b2c3d4e5f60718',
      turnId: 'turn_s1',
      startSec: 301 + i * 20,
      durSec: 18,
      ctx: 18_000 + i * 9_000,
      write: i === 0 ? 18_000 : 9_000,
      out: 700,
      think: 400,
      effort: 'xhigh',
      tools:
        i < 3
          ? [
              {
                id: `tu_s${i + 1}`,
                name: 'Grep',
                input: { pattern: `type: "${['assistant', 'user', 'attachment'][i]}"` },
                durSec: 0.3,
                result: `${120 + i * 40} matches`,
              },
            ]
          : [],
      text: i === 3 ? 'Found 27 record types; summary attached.' : undefined,
    });
  }

  // ── Workflow agents ─────────────────────────────────────────────────────────────────────
  const wfAgents = [
    { id: 'af00000000000001', label: 'recon:live-write', phase: 'Recon', n: 6, done: true },
    { id: 'af00000000000002', label: 'recon:prior-art', phase: 'Recon', n: 9, done: false },
    { id: 'af00000000000003', label: 'verify:live-write', phase: 'Verify', n: 3, done: false },
  ];
  for (const [ai, a] of wfAgents.entries()) {
    for (let i = 0; i < a.n; i++) {
      const last = i === a.n - 1;
      const inFlight = last && !a.done && ai === 2;
      const runningTool = last && !a.done && ai === 1;
      addRequest({
        id: `req_w${ai + 1}_${i + 1}`,
        agentId: a.id,
        turnId: `turn_w${ai + 1}`,
        startSec: 352 + ai * 200 + i * 30,
        durSec: inFlight ? null : 26,
        ctx: 24_000 + i * 21_000,
        write: i === 0 ? 24_000 : 6_000,
        out: 1_900,
        think: 1_200,
        effort: 'xhigh',
        tools:
          inFlight || (last && a.done)
            ? []
            : [
                {
                  id: `tu_w${ai + 1}_${i + 1}`,
                  name: i % 2 ? 'WebFetch' : 'Bash',
                  input:
                    i % 2
                      ? { url: 'https://example.com/docs' }
                      : { command: 'python3 -I survey.py' },
                  durSec: runningTool ? null : 3.2,
                  result: runningTool ? undefined : 'ok',
                },
              ],
        text: last && a.done ? '{"summary": "…"}' : undefined,
      });
    }
  }

  // ── Turns ───────────────────────────────────────────────────────────────────────────────
  const turnOf = (
    id: string,
    agentId: string,
    index: number,
    origin: Turn['origin'],
    prompt: string,
  ): Turn => {
    const reqs = requests.filter((r) => r.turnId === id);
    const running =
      reqs.some((r) => r.status === 'in-flight') ||
      toolCalls.some((t) => t.status === 'running' && reqs.some((r) => r.id === t.requestId));
    const last = reqs.at(-1);
    return {
      id,
      agentId,
      index,
      origin,
      prompt,
      startedAt: reqs[0]?.startedAt ?? at(0),
      endedAt: running ? null : (last?.endedAt ?? null),
      status: running ? 'running' : 'complete',
      requestIds: reqs.map((r) => r.id),
    };
  };
  const turns: Turn[] = [
    turnOf(
      'turn_m1',
      MAIN_AGENT_ID,
      1,
      'human',
      'Busy sessions should be listed first in the sidebar',
    ),
    turnOf(
      'turn_m2',
      MAIN_AGENT_ID,
      2,
      'human',
      [
        'Research how a live viewer could read Claude Code transcripts, use ultracode.',
        '',
        'What I need to know:',
        '- which record types the JSONL transcripts hold, and which of them changed between versions',
        '- how to tell that a session is still running without asking the process',
        '- what ClaudeBar and the DSH workflow plugin already do that we could reuse',
        '',
        'Write the findings to notes/research.md, with sources.',
      ].join('\n'),
    ),
    turnOf('turn_m3', MAIN_AGENT_ID, 3, 'human', 'Now write the design document from the findings'),
    turnOf(
      'turn_s1',
      'a1b2c3d4e5f60718',
      1,
      'agent-prompt',
      'Map the record types in ~/.claude/projects transcripts…',
    ),
    ...wfAgents.map((a, i) =>
      turnOf(`turn_w${i + 1}`, a.id, 1, 'agent-prompt', `Task for ${a.label}…`),
    ),
  ];

  // ── Agents ──────────────────────────────────────────────────────────────────────────────
  const agentOf = (
    base: Omit<AgentNode, 'usage' | 'counts' | 'status' | 'startedAt' | 'endedAt'>,
  ): AgentNode => {
    const reqs = requests.filter((r) => r.agentId === base.id);
    const agentTurns = turns.filter((t) => t.agentId === base.id);
    const running = agentTurns.some((t) => t.status === 'running');
    return {
      ...base,
      status: running ? 'running' : 'complete',
      startedAt: reqs[0]?.startedAt ?? null,
      endedAt: running ? null : (reqs.at(-1)?.endedAt ?? null),
      usage: sumUsage(reqs.map((r) => r.usage)),
      counts: {
        turns: agentTurns.length,
        requests: reqs.length,
        toolCalls: toolCalls.filter((t) => t.agentId === base.id).length,
      },
    };
  };
  const agents: AgentNode[] = [
    agentOf({
      id: MAIN_AGENT_ID,
      kind: 'main',
      parentId: null,
      spawnedByToolCallId: null,
      agentType: null,
      label: 'Main',
      workflowRunId: null,
      phase: null,
      model: 'claude-opus-5-5',
    }),
    agentOf({
      id: 'a1b2c3d4e5f60718',
      kind: 'subagent',
      parentId: MAIN_AGENT_ID,
      spawnedByToolCallId: 'tu_m4a',
      agentType: 'Explore',
      label: 'Explore transcript format',
      workflowRunId: null,
      phase: null,
      model: 'claude-opus-5-5',
    }),
    ...wfAgents.map((a) =>
      agentOf({
        id: a.id,
        kind: 'workflow-agent',
        parentId: MAIN_AGENT_ID,
        spawnedByToolCallId: 'tu_m4b',
        agentType: 'workflow-subagent',
        label: a.label,
        workflowRunId: 'wf_demo0001-abc',
        phase: a.phase,
        model: 'claude-opus-5-5',
      }),
    ),
  ];

  const workflows: WorkflowRun[] = [
    {
      id: 'wf_demo0001-abc',
      name: 'cc-recon',
      taskId: 'wdemo0001',
      toolCallId: 'tu_m4b',
      parentAgentId: MAIN_AGENT_ID,
      status: 'running',
      phases: [
        { title: 'Recon', detail: 'parallel read-only investigations' },
        { title: 'Verify', detail: 'skeptic re-checks local claims' },
      ],
      agentIds: wfAgents.map((a) => a.id),
      startedAt: at(349),
      endedAt: null,
    },
  ];

  const session: SessionSummary = {
    id: DEMO_SESSION_ID,
    agent: 'claude-code',
    nativeId: 'demo-0000-4000-8000-000000000001',
    title: 'Live viewer research (demo)',
    cwd: '/Users/demo/Dev/glassbox',
    project: 'glassbox',
    startedAt: at(0),
    updatedAt: now.toISOString(),
    live: 'busy',
    version: '2.1.308',
    model: 'claude-opus-5-5',
    usage: sumUsage(requests.map((r) => r.usage)),
    counts: {
      turns: turns.filter((t) => t.agentId === MAIN_AGENT_ID).length,
      requests: requests.length,
      toolCalls: toolCalls.length,
      agents: agents.length,
    },
  };

  return {
    session,
    agents,
    turns,
    requests,
    toolCalls,
    workflows,
    diagnostics: { unknownRecordTypes: {}, parseErrors: 0, unavailable: [] },
  };
}

/** A small session list: the demo session plus two idle/closed ones without parsed usage. */
export function createDemoSessions(now: Date = new Date()): SessionSummary[] {
  const demo = createDemoSnapshot(now).session;
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  return [
    demo,
    {
      ...demo,
      id: 'claude-code:demo-0000-4000-8000-000000000002',
      nativeId: 'demo-0000-4000-8000-000000000002',
      title: 'Fix flaky login test',
      cwd: '/Users/demo/Dev/shopfront',
      project: 'shopfront',
      startedAt: ago(180),
      updatedAt: ago(95),
      live: 'idle',
      usage: null,
      counts: null,
    },
    {
      ...demo,
      id: 'claude-code:demo-0000-4000-8000-000000000003',
      nativeId: 'demo-0000-4000-8000-000000000003',
      title: null,
      cwd: '/Users/demo/Dev/blog',
      project: 'blog',
      startedAt: ago(4000),
      updatedAt: ago(3900),
      live: 'closed',
      version: '2.1.266',
      usage: null,
      counts: null,
    },
  ];
}

/** A plan quota as Claude Code caches it: 5-hour, weekly and a per-model weekly window. */
export function createDemoQuota(now: Date = new Date()): QuotaSnapshot {
  const inMin = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
  return {
    provider: 'anthropic',
    agent: 'claude-code',
    plan: 'Max 5x',
    fetchedAt: new Date(now.getTime() - 4 * 60_000).toISOString(),
    stale: false,
    windows: [
      {
        id: 'five_hour',
        kind: 'session',
        label: null,
        model: null,
        usedPercent: 62,
        resetsAt: inMin(97),
      },
      {
        id: 'seven_day',
        kind: 'weekly',
        label: null,
        model: null,
        usedPercent: 38,
        resetsAt: inMin(3 * 24 * 60),
      },
      {
        id: 'weekly:Opus',
        kind: 'weekly-model',
        label: null,
        model: 'Opus',
        usedPercent: 51,
        resetsAt: inMin(3 * 24 * 60),
      },
    ],
    extraUsage: null,
    balance: null,
    source: 'claude-code-cache',
  };
}

/**
 * Plan quotas of every provider glassbox knows, as their sources report them: Claude Code's
 * cache, a Codex session log, oh-my-pi's usage cache (Grok and Copilot) and DeepSeek's balance.
 */
export function createDemoQuotas(now: Date = new Date()): QuotaSnapshot[] {
  const inMin = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const window = (
    id: string,
    kind: QuotaWindow['kind'],
    label: string | null,
    usedPercent: number,
    resetsInMin: number,
  ): QuotaWindow => ({ id, kind, label, model: null, usedPercent, resetsAt: inMin(resetsInMin) });
  const empty = { stale: false, extraUsage: null, balance: null };
  return [
    createDemoQuota(now),
    {
      ...empty,
      provider: 'openai',
      agent: 'codex',
      plan: 'Plus',
      fetchedAt: ago(12),
      windows: [
        window('primary', 'session', null, 23, 168),
        window('secondary', 'weekly', null, 41, 4 * 24 * 60),
      ],
      source: 'codex-session',
    },
    {
      ...empty,
      provider: 'xai',
      agent: 'oh-my-pi',
      plan: 'SuperGrok',
      fetchedAt: ago(9),
      windows: [
        window('xai-oauth:credits:1w', 'weekly', 'SuperGrok Weekly Credits', 25, 2 * 24 * 60),
        window('xai-oauth:product:grokbot:1w', 'weekly', 'GrokBot (Weekly)', 16, 2 * 24 * 60),
        window('xai-oauth:product:grokbuild:1w', 'weekly', 'Grok Build (Weekly)', 9, 2 * 24 * 60),
      ],
      source: 'oh-my-pi-cache',
    },
    {
      ...empty,
      provider: 'github-copilot',
      agent: 'oh-my-pi',
      plan: 'Individual',
      fetchedAt: ago(9),
      windows: [
        window('copilot:premium', 'monthly', 'Premium Requests', 74, 9 * 24 * 60),
        window('copilot:chat', 'monthly', 'Chat Requests', 12, 9 * 24 * 60),
        window('copilot:completions', 'monthly', 'Completions', 3, 9 * 24 * 60),
      ],
      source: 'oh-my-pi-cache',
    },
    {
      ...empty,
      provider: 'deepseek',
      agent: null,
      plan: null,
      fetchedAt: ago(2),
      windows: [],
      balance: { amount: 12.3, currency: 'CNY' },
      source: 'deepseek-api',
    },
  ];
}

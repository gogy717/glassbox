/**
 * A believable week behind the demo's weekly receipt: sessions across five CLIs and six projects,
 * worked in the day's usual blocks, with late nights, a lighter weekend and the odd swarm of
 * sub-agents. They are not listed as sessions (the demo's sidebar keeps its three); only the
 * week reads them. The same week on every run, placed relative to `now`.
 */
import type {
  AgentKind,
  AgentNode,
  IsoTime,
  ModelRequest,
  SessionSnapshot,
  TokenUsage,
  ToolCall,
  Turn,
} from '../core/model.js';
import { MAIN_AGENT_ID } from '../core/model.js';
import { emptyUsage, sumUsage } from '../core/usage.js';

const MIN = 60_000;

interface Cli {
  agent: AgentKind;
  /** Share of the week's sessions. */
  weight: number;
  model: string;
  /** Whether its sessions report usage (the demo's Grok does not, so "not reported" shows). */
  measured: boolean;
  /** Writes no cache (as OpenAI-style APIs report it). */
  noCacheWrite?: true;
  tools: { name: string; input: unknown }[];
}

const CLIS: Cli[] = [
  {
    agent: 'claude-code',
    weight: 0.56,
    model: 'claude-opus-5-5',
    measured: true,
    tools: [
      { name: 'Read', input: { file_path: 'src/app.ts' } },
      { name: 'Grep', input: { pattern: 'TODO', path: 'src' } },
      { name: 'Edit', input: { file_path: 'src/app.ts' } },
      { name: 'Bash', input: { command: 'npm test' } },
      { name: 'Bash', input: { command: 'git diff --stat' } },
      { name: 'Read', input: { file_path: 'README.md' } },
      { name: 'WebSearch', input: { query: 'vite library mode' } },
    ],
  },
  {
    agent: 'codex',
    weight: 0.2,
    model: 'gpt-5.5-codex',
    measured: true,
    noCacheWrite: true,
    tools: [
      { name: 'exec_command', input: { cmd: ['bash', '-lc', 'rg -n render src'] } },
      { name: 'apply_patch', input: { input: '*** Begin Patch' } },
      { name: 'exec_command', input: { cmd: ['bash', '-lc', 'npm test'] } },
      { name: 'read_file', input: { path: 'src/app.ts' } },
    ],
  },
  {
    agent: 'opencode',
    weight: 0.1,
    model: 'claude-sonnet-5-5',
    measured: true,
    tools: [
      { name: 'read', input: { filePath: 'src/app.ts' } },
      { name: 'edit', input: { filePath: 'src/app.ts' } },
      { name: 'bash', input: { command: 'npm run build' } },
      { name: 'grep', input: { pattern: 'export' } },
    ],
  },
  {
    agent: 'oh-my-pi',
    weight: 0.08,
    model: 'claude-opus-5-5',
    measured: true,
    tools: [
      { name: 'read', input: { path: 'src/app.ts' } },
      { name: 'edit', input: { path: 'src/app.ts' } },
      { name: 'bash', input: { command: 'cargo test' } },
    ],
  },
  {
    agent: 'grok',
    weight: 0.06,
    model: 'grok-5',
    measured: false,
    tools: [
      { name: 'read_file', input: { path: 'notes.md' } },
      { name: 'search_replace', input: { path: 'notes.md' } },
      { name: 'run_terminal_command', input: { command: 'make' } },
    ],
  },
];

const PROJECTS = ['glassbox', 'shopfront', 'blog', 'infra', 'dotfiles', 'notes'];

const TITLES = [
  'Build the Now board',
  'Fix flaky login test',
  'Draft the release notes',
  'Speed up the session list',
  'Add a dark theme to the docs',
  'Migrate the CI to Node 24',
  'Profile the cold start',
  'Review the auth refactor',
  'Write the weekly receipt',
  'Untangle the build cache',
  'Port the parser to streams',
  'Tidy the dotfiles',
];

/** A seeded generator: the same week on every run. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

interface Planned {
  start: number;
  end: number;
  cli: Cli;
  project: string;
  title: string;
  /** Sub-agents spawned at once, mid-session (0 for none). */
  swarm: number;
}

/** When the week's sessions happen: the day's blocks, a late night now and then. */
function plan(now: number, random: () => number): Planned[] {
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)] as T;
  const cli = () => {
    let r = random();
    for (const c of CLIS) {
      r -= c.weight;
      if (r <= 0) return c;
    }
    return CLIS[0] as Cli;
  };
  const out: Planned[] = [];
  for (let d = 8; d >= 0; d--) {
    const day = new Date(now - d * 24 * 60 * MIN);
    day.setHours(0, 0, 0, 0);
    const at = (h: number) => day.getTime() + h * 60 * MIN;
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const blocks: [number, number][] = weekend
      ? [[13.5 + random(), 2.5 + random() * 1.5]]
      : [
          [9 + random() * 0.6, 2.6 + random() * 0.6],
          [13.4 + random() * 0.5, 3.8 + random() * 0.8],
        ];
    if (random() < (weekend ? 0.75 : 0.5))
      blocks.push([21.2 + random() * 1.3, 1.8 + random() * 2.2]);
    for (const [from, hours] of blocks) {
      let t = at(from);
      const stop = at(from + hours);
      while (t < stop) {
        const minutes = 25 + random() * 70;
        const start = t;
        const end = Math.min(start + minutes * MIN, now - MIN);
        if (end - start > 5 * MIN) {
          const c = cli();
          out.push({
            start,
            end,
            cli: c,
            project: pick(PROJECTS),
            title: pick(TITLES),
            swarm: c.agent === 'claude-code' && random() < 0.3 ? 2 + Math.floor(random() * 5) : 0,
          });
        }
        // Mostly one after another, now and then the next one started before this ends.
        t += minutes * MIN * (0.95 + random() * 0.7);
      }
    }
  }
  return out;
}

const iso = (t: number): IsoTime => new Date(t).toISOString();

/** One session's snapshot, made of turns of requests and tool calls; sub-agents as planned. */
function build(p: Planned, n: number, random: () => number): SessionSnapshot {
  const nativeId = `demo-week-${String(n).padStart(3, '0')}`;
  const requests: ModelRequest[] = [];
  const toolCalls: ToolCall[] = [];
  const turns: Turn[] = [];
  const agents: AgentNode[] = [];
  const usageFor = (i: number): TokenUsage | null => {
    if (!p.cli.measured) return null;
    const ctx = Math.min(160_000, 18_000 + i * 1_300 + Math.floor(random() * 4_000));
    const write = p.cli.noCacheWrite ? 0 : 900 + Math.floor(random() * 2_400);
    const output = 140 + Math.floor(random() * 1_300);
    return {
      ...emptyUsage(),
      input: p.cli.noCacheWrite
        ? 2_000 + Math.floor(random() * 6_000)
        : 6 + Math.floor(random() * 30),
      cacheRead: ctx,
      cacheWrite: write,
      cacheWrite1h: write,
      output,
      thinking: Math.floor(output * random() * 0.6),
    };
  };

  /** An agent's work from `from` to `to`: calls of thinking then writing, tools between. */
  const work = (agentId: string, turnId: string, from: number, to: number): string[] => {
    const ids: string[] = [];
    let t = from;
    while (t < to - 20_000) {
      const i = requests.length;
      const id = `r${n}_${i}`;
      const think = (4 + random() * 36) * 1000;
      const write = (2 + random() * 13) * 1000;
      const first = t + 400 + think;
      const end = first + write;
      const tools: string[] = [];
      let tt = end;
      for (let j = 0, k = Math.floor(random() * 3); j < k; j++) {
        const tool = p.cli.tools[Math.floor(random() * p.cli.tools.length)] as Cli['tools'][number];
        const dur = (0.5 + random() * random() * 30) * 1000;
        const tid = `t${n}_${i}_${j}`;
        const failed = random() < 0.015;
        toolCalls.push({
          id: tid,
          agentId,
          requestId: id,
          name: tool.name,
          input: tool.input,
          status: failed ? 'error' : 'complete',
          startedAt: iso(tt),
          endedAt: iso(tt + dur),
          durationMs: Math.round(dur),
          resultPreview: failed ? 'exit 1' : 'ok',
          hasFullResult: false,
          spawned: null,
        });
        tools.push(tid);
        tt += dur;
      }
      const failed = random() < 0.006;
      requests.push({
        id,
        agentId,
        turnId,
        index: ids.length + 1,
        model: p.cli.model,
        effort: p.cli.agent === 'claude-code' ? 'max' : null,
        startedAt: iso(t),
        firstBlockAt: iso(first),
        endedAt: iso(end),
        status: failed ? 'error' : 'complete',
        stopReason: tools.length ? 'tool_use' : 'end_turn',
        usage: usageFor(i),
        blocks: [
          { kind: 'thinking', text: null, durationMs: Math.round(think), at: iso(first) },
          ...tools.map((toolCallId) => ({ kind: 'tool-use' as const, toolCallId, at: iso(end) })),
        ],
        toolCallIds: tools,
        hasDetail: false,
        error: failed ? { message: 'Overloaded', status: 529, retryAttempt: null } : null,
      });
      ids.push(id);
      t = tt + 300 + random() * 2_500;
    }
    return ids;
  };

  // The main agent's turns: the session's time cut into one to three, idle minutes between.
  const parts = 1 + Math.floor(random() * 3);
  const span = p.end - p.start;
  let swarmAt = p.swarm ? p.start + span * (0.2 + random() * 0.3) : null;
  for (let k = 0; k < parts; k++) {
    const from = p.start + (span * k) / parts + (k ? 2 + random() * 6 : 0) * MIN;
    const to = p.start + (span * (k + 1)) / parts;
    const turnId = `turn${n}_${k}`;
    const ids = work(MAIN_AGENT_ID, turnId, from, to);
    const last = requests.find((r) => r.id === ids.at(-1));
    turns.push({
      id: turnId,
      agentId: MAIN_AGENT_ID,
      index: k + 1,
      origin: 'human',
      prompt: p.title,
      startedAt: iso(from),
      endedAt: last?.endedAt ?? iso(to),
      status: 'complete',
      requestIds: ids,
    });
    // The swarm: sub-agents spawned together from this turn, working side by side.
    if (swarmAt !== null && swarmAt < to && ids.length > 0) {
      for (let a = 0; a < p.swarm; a++) {
        const id = `sub${n}_${a}`;
        const from = swarmAt + a * 4_000;
        const to = Math.min(p.end, from + (4 + random() * 10) * MIN);
        const subTurn = `turn${n}_s${a}`;
        const subIds = work(id, subTurn, from, to);
        const subReqs = requests.filter((r) => r.agentId === id);
        turns.push({
          id: subTurn,
          agentId: id,
          index: 1,
          origin: 'human',
          prompt: p.title,
          startedAt: iso(from),
          endedAt: subReqs.at(-1)?.endedAt ?? iso(to),
          status: 'complete',
          requestIds: subIds,
        });
        agents.push({
          id,
          kind: 'subagent',
          parentId: MAIN_AGENT_ID,
          spawnedByToolCallId: null,
          agentType: 'general-purpose',
          label: `Worker ${a + 1}`,
          workflowRunId: null,
          phase: null,
          model: p.cli.model,
          status: 'complete',
          startedAt: iso(from),
          endedAt: subReqs.at(-1)?.endedAt ?? iso(to),
          usage: sumUsage(subReqs.map((r) => r.usage)),
          counts: {
            turns: 1,
            requests: subReqs.length,
            toolCalls: toolCalls.filter((t) => t.agentId === id).length,
          },
        });
      }
      swarmAt = null;
    }
  }
  const mine = requests.filter((r) => r.agentId === MAIN_AGENT_ID);
  agents.unshift({
    id: MAIN_AGENT_ID,
    kind: 'main',
    parentId: null,
    spawnedByToolCallId: null,
    agentType: null,
    label: 'Main',
    workflowRunId: null,
    phase: null,
    model: p.cli.model,
    status: 'complete',
    startedAt: iso(p.start),
    endedAt: turns.filter((t) => t.agentId === MAIN_AGENT_ID).at(-1)?.endedAt ?? iso(p.end),
    usage: sumUsage(mine.map((r) => r.usage)),
    counts: {
      turns: turns.filter((t) => t.agentId === MAIN_AGENT_ID).length,
      requests: mine.length,
      toolCalls: toolCalls.filter((t) => t.agentId === MAIN_AGENT_ID).length,
    },
  });
  const usage = p.cli.measured ? sumUsage(requests.map((r) => r.usage)) : null;
  const updatedAt = requests.at(-1)?.endedAt ?? iso(p.end);
  return {
    session: {
      id: `${p.cli.agent}:${nativeId}`,
      agent: p.cli.agent,
      nativeId,
      title: p.title,
      cwd: `/Users/demo/Dev/${p.project}`,
      project: p.project,
      startedAt: iso(p.start),
      updatedAt,
      live: 'closed',
      version: null,
      model: p.cli.model,
      usage,
      counts: {
        turns: turns.length,
        requests: requests.length,
        toolCalls: toolCalls.length,
        agents: agents.length,
      },
    },
    agents,
    turns,
    requests,
    toolCalls,
    workflows: [],
    diagnostics: { unknownRecordTypes: {}, parseErrors: 0, unavailable: [] },
  };
}

/** The demo week: the sessions of the last eight days, as of `now`. */
export function createDemoWeek(now: number): SessionSnapshot[] {
  const random = rng(0x5eed_0043);
  return plan(now, random).map((p, i) => build(p, i + 1, random));
}

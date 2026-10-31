/**
 * A believable week behind the demo's weekly receipt: sessions across five CLIs and six projects,
 * worked in the day's usual blocks, with late nights, a lighter weekend and the odd swarm of
 * sub-agents; some of glassbox's in a second worktree, whose changes cross the open session's.
 * They are not listed as sessions (the demo's sidebar keeps its three); only the week reads them.
 * The same week on every run, placed relative to `now`.
 */
import type {
  AgentKind,
  AgentNode,
  IsoTime,
  LineChange,
  ModelRequest,
  RepoIdentity,
  SessionSnapshot,
  TokenUsage,
  ToolCall,
  Turn,
} from '../core/model.js';
import { MAIN_AGENT_ID } from '../core/model.js';
import { emptyUsage, sumUsage } from '../core/usage.js';
import type { ApprovalWindow, WaitSource } from '../shared/waiting.js';

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

/** The demo's directories. */
const DEV = '/Users/demo/Dev';
/** glassbox's second working tree, where its last two Claude Code sessions of the week run. */
const WORKTREE = `${DEV}/worktrees/glassbox-sidebar`;

/**
 * The demo's repositories, as the server reads them from `.git` (the demo's directories do not
 * exist): `/Users/demo/Dev/worktrees/<repo>-<name>` is a worktree of `/Users/demo/Dev/<repo>`;
 * any other directory is the main working tree of a repository of its own name.
 */
export function demoRepo(cwd: string): RepoIdentity {
  const tree = /^(.*)\/worktrees\/([^/-]+)-[^/]+$/.exec(cwd);
  if (tree) return { root: `${tree[1]}/${tree[2]}`, dir: cwd, name: tree[2] as string };
  return { root: cwd, dir: cwd, name: cwd.split('/').filter(Boolean).at(-1) ?? cwd };
}

/**
 * What the worktree's two sessions changed, as Claude Code records it: `store.ts` on the very
 * line the open session's fix rewrites, and `sessions.ts` far from the lines the fix touches.
 */
const CROSSING: { file: string; before: string; after: string; lines: LineChange[] }[] = [
  {
    file: 'src/server/store.ts',
    before: 'return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));',
    after: 'return sessions.sort(byRecent);',
    lines: [[41, 1, 1]],
  },
  {
    file: 'src/server/sessions.ts',
    before: ['export function groupSessions(list: Session[]) {', '  return group(list);'].join(
      '\n',
    ),
    after: [
      'export function groupSessions(list: Session[], by: GroupBy = "project") {',
      '  if (by === "time") return byTime(list);',
      '  // Pinned sessions keep their own group.',
      '  return group(list);',
    ].join('\n'),
    lines: [[52, 2, 4]],
  },
];

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
      cwd: `${DEV}/${p.project}`,
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

/**
 * glassbox's last two Claude Code sessions of the week run in its second worktree, and make the
 * changes that cross: each one's first finished Edit becomes one, so no figure of the week moves.
 */
function intoWorktree(week: SessionSnapshot[]): void {
  const moved = week
    .filter((s) => s.session.project === 'glassbox' && s.session.agent === 'claude-code')
    .slice(-CROSSING.length);
  moved.forEach((s, i) => {
    s.session.cwd = WORKTREE;
    s.session.project = 'glassbox-sidebar';
    const t = s.toolCalls.find((x) => x.name === 'Edit' && x.status === 'complete');
    const c = CROSSING[i] as (typeof CROSSING)[number];
    if (!t) return;
    t.input = { file_path: `${WORKTREE}/${c.file}`, old_string: c.before, new_string: c.after };
    t.resultPreview = `The file ${WORKTREE}/${c.file} has been updated.`;
    t.lineChanges = c.lines;
  });
}

/**
 * The week's MCP calls, made of calls it already has, so no other figure moves: one Claude Code
 * web search in eight asks the `docs` or the `tracker` server instead (`mcp__server__tool`), and
 * each Grok session's first file read asks the tracker for an issue (`server__tool`, as Grok
 * names them), the last of those failing. Result sizes as such servers send them back.
 */
function withMcp(week: SessionSnapshot[]): void {
  let k = 0;
  for (const s of week)
    for (const t of s.toolCalls) {
      if (t.name !== 'WebSearch') continue;
      const turn = k++ % 16;
      if (turn === 0) {
        t.name = 'mcp__docs__search';
        t.input = { query: 'vite library mode', limit: 5 };
        t.resultChars = 6_200 + ((k * 1_733) % 8_000);
      } else if (turn === 8) {
        t.name = 'mcp__tracker__list_issues';
        t.input = { project: 'WEB', state: 'open' };
        t.resultChars = 2_400 + ((k * 977) % 3_000);
      }
    }
  let last: ToolCall | null = null;
  for (const s of week) {
    if (s.session.agent !== 'grok') continue;
    const t = s.toolCalls.find((x) => x.name === 'read_file');
    if (!t) continue;
    t.name = 'tracker__get_issue';
    t.input = { id: 'WEB-412' };
    t.resultChars = 1_800;
    last = t;
  }
  if (last) {
    last.status = 'error';
    last.resultPreview = 'tracker: issue WEB-412 not found';
    last.resultChars = last.resultPreview.length;
  }
}

/** The demo's questions and plan approvals: what the agent asked, and the answer it waited for. */
const ASK = {
  name: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Which approach should the change take?',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'Keep it small', description: 'Touch only the failing path' },
          { label: 'Rewrite it', description: 'Replace the whole module' },
        ],
      },
    ],
  },
};
const PLAN = { name: 'ExitPlanMode', input: { plan: 'Fix the failing path, then run the tests.' } };

/**
 * The demo week's waits, drawn on a seed of their own so the sessions stay as they were: a
 * question and a plan approval hold open a call after a model call that is followed by a quiet
 * spell; about half the sessions ran in glassbox, whose run was live from the first prompt to a
 * few minutes after the last reply (so the gaps between prompts were waits), and some of their
 * shell commands waited on a permission prompt the run showed. What the runs knew is returned
 * by session: the transcript keeps none of it.
 */
function addWaits(week: SessionSnapshot[], random: () => number): Map<string, WaitSource> {
  const sources = new Map<string, WaitSource>();
  const pickOf = <T>(list: T[]) => list[Math.floor(random() * list.length)] as T;
  for (const snap of week) {
    if (snap.session.agent !== 'claude-code') continue;
    const mains = snap.requests
      .filter((r) => r.agentId === MAIN_AGENT_ID && r.endedAt)
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
    // A model call that a quiet spell of two minutes or more follows: room for the answer.
    const rooms = mains.flatMap((r, i) => {
      const next = mains[i + 1];
      const from = Date.parse(r.endedAt ?? '');
      const to = Date.parse(next?.startedAt ?? '');
      return next && to - from >= 2 * MIN ? [{ r, from, room: to - from - 30_000 }] : [];
    });
    const ask = rooms.length > 0 && random() < 0.6 ? pickOf(rooms) : null;
    const others = rooms.filter((room) => room !== ask);
    const plan = others.length > 0 && random() < 0.4 ? pickOf(others) : null;
    const add = (
      room: (typeof rooms)[number],
      spec: { name: string; input: unknown },
      suffix: string,
      minutes: number,
    ) => {
      const { r, from } = room;
      const dur = Math.min(room.room, (0.5 + random() * minutes) * MIN);
      const id = `${r.id}-${suffix}`;
      snap.toolCalls.push({
        id,
        agentId: MAIN_AGENT_ID,
        requestId: r.id,
        name: spec.name,
        input: spec.input,
        status: 'complete',
        startedAt: iso(from),
        endedAt: iso(from + dur),
        durationMs: Math.round(dur),
        resultPreview: 'answered',
        hasFullResult: false,
        spawned: null,
      });
      r.toolCallIds.push(id);
      r.blocks.push({ kind: 'tool-use', toolCallId: id, at: iso(from) });
      r.stopReason = 'tool_use';
      snap.session.counts = snap.session.counts && {
        ...snap.session.counts,
        toolCalls: snap.session.counts.toolCalls + 1,
      };
      const main = snap.agents[0];
      if (main) main.counts = { ...main.counts, toolCalls: main.counts.toolCalls + 1 };
    };
    if (ask) add(ask, ASK, 'ask', 6);
    if (plan) add(plan, PLAN, 'plan', 4);

    // Run in glassbox, or not: only a glassbox run knows its prompts and when it was live.
    if (random() >= 0.5) continue;
    const mainTurns = snap.turns.filter((t) => t.agentId === MAIN_AGENT_ID);
    const first = Date.parse(mainTurns[0]?.startedAt ?? '');
    const last = Date.parse(mainTurns.at(-1)?.endedAt ?? '');
    const live =
      Number.isFinite(first) && Number.isFinite(last)
        ? [[first, last + (1 + random() * 4) * MIN] as const]
        : [];

    // Some shell commands: the prompt was shown when the call began, and answered part way in.
    const windows = new Map<string, ApprovalWindow>();
    for (const t of snap.toolCalls) {
      if (t.name !== 'Bash' || t.agentId !== MAIN_AGENT_ID || !t.startedAt || !t.endedAt) continue;
      if (random() >= 0.12) continue;
      const from = Date.parse(t.startedAt);
      const to = Date.parse(t.endedAt);
      const decided = Math.min(to, from + (10 + random() * 150) * 1000);
      windows.set(t.id, { requestedAt: from, decidedAt: decided });
    }
    sources.set(snap.session.id, { approvals: windows, live });
  }
  return sources;
}

/** The demo week: its sessions, and what their glassbox runs knew of their waits. */
export interface DemoWeek {
  sessions: SessionSnapshot[];
  /** By session id: see `WeekService.setWaitSource`. */
  waits: Map<string, WaitSource>;
}

/** The demo week with its waits: the sessions of the last eight days, as of `now`. */
export function demoWeek(now: number): DemoWeek {
  const random = rng(0x5eed_0043);
  const week = plan(now, random).map((p, i) => build(p, i + 1, random));
  intoWorktree(week);
  withMcp(week);
  const waits = addWaits(week, rng(0x5eed_0047));
  return { sessions: week, waits };
}

/** The demo week's sessions, as of `now`. */
export function createDemoWeek(now: number): SessionSnapshot[] {
  return demoWeek(now).sessions;
}

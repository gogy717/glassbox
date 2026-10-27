import { MAIN_AGENT_ID } from '../core/model.js';
import { emptyUsage, sumUsage } from '../core/usage.js';
const MIN = 60_000;
const CLIS = [
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
export function demoRepo(cwd) {
    const tree = /^(.*)\/worktrees\/([^/-]+)-[^/]+$/.exec(cwd);
    if (tree)
        return { root: `${tree[1]}/${tree[2]}`, dir: cwd, name: tree[2] };
    return { root: cwd, dir: cwd, name: cwd.split('/').filter(Boolean).at(-1) ?? cwd };
}
/**
 * What the worktree's two sessions changed, as Claude Code records it: `store.ts` on the very
 * line the open session's fix rewrites, and `sessions.ts` far from the lines the fix touches.
 */
const CROSSING = [
    {
        file: 'src/server/store.ts',
        before: 'return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));',
        after: 'return sessions.sort(byRecent);',
        lines: [[41, 1, 1]],
    },
    {
        file: 'src/server/sessions.ts',
        before: ['export function groupSessions(list: Session[]) {', '  return group(list);'].join('\n'),
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
function rng(seed) {
    let s = seed;
    return () => {
        s = (s * 1_103_515_245 + 12_345) & 0x7fffffff;
        return s / 0x7fffffff;
    };
}
/** When the week's sessions happen: the day's blocks, a late night now and then. */
function plan(now, random) {
    const pick = (list) => list[Math.floor(random() * list.length)];
    const cli = () => {
        let r = random();
        for (const c of CLIS) {
            r -= c.weight;
            if (r <= 0)
                return c;
        }
        return CLIS[0];
    };
    const out = [];
    for (let d = 8; d >= 0; d--) {
        const day = new Date(now - d * 24 * 60 * MIN);
        day.setHours(0, 0, 0, 0);
        const at = (h) => day.getTime() + h * 60 * MIN;
        const weekend = day.getDay() === 0 || day.getDay() === 6;
        const blocks = weekend
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
const iso = (t) => new Date(t).toISOString();
/** One session's snapshot, made of turns of requests and tool calls; sub-agents as planned. */
function build(p, n, random) {
    const nativeId = `demo-week-${String(n).padStart(3, '0')}`;
    const requests = [];
    const toolCalls = [];
    const turns = [];
    const agents = [];
    const usageFor = (i) => {
        if (!p.cli.measured)
            return null;
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
    const work = (agentId, turnId, from, to) => {
        const ids = [];
        let t = from;
        while (t < to - 20_000) {
            const i = requests.length;
            const id = `r${n}_${i}`;
            const think = (4 + random() * 36) * 1000;
            const write = (2 + random() * 13) * 1000;
            const first = t + 400 + think;
            const end = first + write;
            const tools = [];
            let tt = end;
            for (let j = 0, k = Math.floor(random() * 3); j < k; j++) {
                const tool = p.cli.tools[Math.floor(random() * p.cli.tools.length)];
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
                    ...tools.map((toolCallId) => ({ kind: 'tool-use', toolCallId, at: iso(end) })),
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
function intoWorktree(week) {
    const moved = week
        .filter((s) => s.session.project === 'glassbox' && s.session.agent === 'claude-code')
        .slice(-CROSSING.length);
    moved.forEach((s, i) => {
        s.session.cwd = WORKTREE;
        s.session.project = 'glassbox-sidebar';
        const t = s.toolCalls.find((x) => x.name === 'Edit' && x.status === 'complete');
        const c = CROSSING[i];
        if (!t)
            return;
        t.input = { file_path: `${WORKTREE}/${c.file}`, old_string: c.before, new_string: c.after };
        t.resultPreview = `The file ${WORKTREE}/${c.file} has been updated.`;
        t.lineChanges = c.lines;
    });
}
/** The demo week: the sessions of the last eight days, as of `now`. */
export function createDemoWeek(now) {
    const random = rng(0x5eed_0043);
    const week = plan(now, random).map((p, i) => build(p, i + 1, random));
    intoWorktree(week);
    return week;
}
//# sourceMappingURL=week-demo.js.map
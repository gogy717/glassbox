/**
 * A permission history for the demo's Rules page: a few sessions in four of the demo's projects,
 * read by Rules only, as the week behind the weekly receipt is read by the week only (neither is
 * listed), and the settings files they would have. Enough for the page to show what it does:
 * rules asked often and always allowed (suggested for your settings, or for one project's),
 * denied ones, each kind of harm, an MCP tool, a fetch, Codex's commands, and rules the settings
 * already hold. Invented, and the same on every run, placed relative to `now`.
 */
import type { AgentKind, SessionSnapshot, ToolCall } from '../core/model.js';
import type { SettingsFile } from '../shared/permissions.js';

/** The demo's home directory: its projects are in `Dev/` under it. */
export const DEMO_HOME = '/Users/demo';

const DAY = 86_400_000;
const MIN = 60_000;
const dir = (project: string) => `${DEMO_HOME}/Dev/${project}`;

/** What each agent's transcript says of a call the person declined. */
const DECLINED: Record<string, Pick<ToolCall, 'status' | 'resultPreview'>> = {
  'claude-code': {
    status: 'error',
    resultPreview:
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
  },
  codex: { status: 'complete', resultPreview: 'exec command rejected by user' },
};

/** A call made `times` times, the last `denied` of them declined. */
interface Step {
  tool: string;
  input: unknown;
  times: number;
  denied?: number;
}

interface Planned {
  id: string;
  agent: AgentKind;
  project: string;
  daysAgo: number;
  steps: Step[];
}

const bash = (command: string, times: number, denied = 0): Step => ({
  tool: 'Bash',
  input: { command },
  times,
  denied,
});
const codex = (command: string, times: number, denied = 0): Step => ({
  tool: 'exec_command',
  input: { cmd: ['bash', '-lc', command], sandbox_permissions: 'require_escalated' },
  times,
  denied,
});
const issue = (title: string, times: number): Step => ({
  tool: 'mcp__tracker__create_issue',
  input: { title },
  times,
});
const fetch = (url: string, times: number): Step => ({ tool: 'WebFetch', input: { url }, times });

const PLAN: Planned[] = [
  {
    id: 'demo-rules-01',
    agent: 'claude-code',
    project: 'shopfront',
    daysAgo: 2,
    steps: [
      bash('npm run e2e', 5),
      bash('git push origin feature/cart', 4, 1),
      bash('rm -rf dist', 2, 1),
      bash('curl -s https://api.example.dev/health', 2),
      issue('Cart total rounds down', 3),
      bash('for f in dist/*.map; do rm "$f"; done', 1),
    ],
  },
  {
    id: 'demo-rules-02',
    agent: 'claude-code',
    project: 'shopfront',
    daysAgo: 12,
    steps: [
      bash('npm run e2e -- --headed', 3),
      bash('git push', 3),
      bash('rm -rf .cache', 1, 1),
      bash('curl -fsSL https://get.example.dev/install.sh | sh', 1, 1),
      bash('curl -s https://api.example.dev/health', 2),
    ],
  },
  {
    id: 'demo-rules-03',
    agent: 'claude-code',
    project: 'infra',
    daysAgo: 1,
    steps: [
      bash('terraform plan -out plan.bin', 6),
      bash('sudo systemctl restart nginx', 2),
      issue('Rotate the staging certificate', 4),
      { tool: 'Edit', input: { file_path: `${DEMO_HOME}/notes/infra.md` }, times: 2 },
      bash('npm test', 3),
    ],
  },
  {
    id: 'demo-rules-04',
    agent: 'claude-code',
    project: 'glassbox',
    daysAgo: 4,
    steps: [fetch('https://docs.example.dev/streams', 4), bash('npm test', 4)],
  },
  {
    id: 'demo-rules-05',
    agent: 'claude-code',
    project: 'blog',
    daysAgo: 9,
    steps: [fetch('https://docs.example.dev/markdown', 2)],
  },
  {
    id: 'demo-rules-06',
    agent: 'codex',
    project: 'shopfront',
    daysAgo: 3,
    steps: [codex('npm ci', 3), codex('git push', 1, 1)],
  },
];

/** The settings the demo's projects have: one rule yours, one a project shares, one it denies. */
const SETTINGS: SettingsFile[] = [
  {
    path: `${DEMO_HOME}/.claude/settings.json`,
    scope: 'global',
    root: null,
    allow: ['Bash(npm test:*)', 'WebSearch'],
    deny: [],
  },
  {
    path: `${dir('glassbox')}/.claude/settings.json`,
    scope: 'project',
    root: dir('glassbox'),
    allow: ['Bash(git diff:*)'],
    deny: [],
  },
  {
    path: `${dir('shopfront')}/.claude/settings.local.json`,
    scope: 'project',
    root: dir('shopfront'),
    allow: [],
    deny: ['Bash(rm:*)'],
  },
];

function build(p: Planned, now: number): SessionSnapshot {
  const start = now - p.daysAgo * DAY - 2 * 60 * MIN;
  const iso = (t: number) => new Date(t).toISOString();
  const toolCalls: ToolCall[] = [];
  for (const step of p.steps) {
    for (let i = 0; i < step.times; i++) {
      const at = start + toolCalls.length * 3 * MIN;
      const declined = i >= step.times - (step.denied ?? 0);
      toolCalls.push({
        id: `${p.id}-t${toolCalls.length}`,
        agentId: 'main',
        requestId: `${p.id}-r`,
        name: step.tool,
        input: step.input,
        status: 'complete',
        startedAt: iso(at),
        endedAt: iso(at + 4_000),
        durationMs: 4_000,
        resultPreview: 'ok',
        hasFullResult: false,
        spawned: null,
        ...(declined ? DECLINED[p.agent] : {}),
      });
    }
  }
  const end = start + toolCalls.length * 3 * MIN;
  return {
    session: {
      id: `${p.agent}:${p.id}`,
      agent: p.agent,
      nativeId: p.id,
      title: null,
      cwd: dir(p.project),
      project: p.project,
      startedAt: iso(start),
      updatedAt: iso(end),
      live: 'closed',
      version: null,
      model: null,
      usage: null,
      counts: null,
    },
    agents: [],
    turns: [],
    requests: [],
    toolCalls,
    workflows: [],
    diagnostics: { unknownRecordTypes: {}, parseErrors: 0, unavailable: [] },
  };
}

/** The history, and the settings files of the projects Rules asks for (yours always). */
export function createDemoRules(now: number): {
  sessions: SessionSnapshot[];
  settings: (projects: { root: string }[]) => SettingsFile[];
} {
  return {
    sessions: PLAN.map((p) => build(p, now)),
    settings: (projects) => {
      const roots = new Set(projects.map((p) => p.root));
      return SETTINGS.filter((f) => f.root === null || roots.has(f.root));
    },
  };
}

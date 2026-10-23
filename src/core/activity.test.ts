import { describe, expect, it } from 'vitest';
import { type ActivityInput, activityTarget, sessionActivity, thinkingSince } from './activity.js';
import type { ModelRequest, ToolCall, Turn } from './model.js';

const at = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();

const tool = (o: Partial<ToolCall> & { name: string; startSec: number }): ToolCall => ({
  id: `t-${o.startSec}`,
  agentId: 'main',
  requestId: 'r',
  input: {},
  status: 'running',
  startedAt: at(o.startSec),
  endedAt: null,
  durationMs: null,
  resultPreview: null,
  hasFullResult: false,
  spawned: null,
  ...o,
});

const call = (o: Partial<ModelRequest> & { startSec: number }): ModelRequest => ({
  id: `r-${o.startSec}`,
  agentId: 'main',
  turnId: 'turn-1',
  index: 1,
  model: null,
  effort: null,
  startedAt: at(o.startSec),
  firstBlockAt: null,
  endedAt: null,
  status: 'in-flight',
  stopReason: null,
  usage: null,
  blocks: [],
  toolCallIds: [],
  hasDetail: false,
  error: null,
  ...o,
});

const turn = (o: Partial<Turn> = {}): Turn => ({
  id: 'turn-1',
  agentId: 'main',
  index: 1,
  origin: 'human',
  prompt: 'fix it',
  startedAt: at(0),
  endedAt: null,
  status: 'running',
  requestIds: [],
  ...o,
});

const input = (o: Partial<ActivityInput>): ActivityInput => ({
  live: 'busy',
  toolCalls: [],
  requests: [],
  lastTurn: turn(),
  updatedAt: at(0),
  ...o,
});

describe('sessionActivity', () => {
  it('says nothing about a session that is not running', () => {
    for (const live of ['closed', 'unknown'] as const)
      expect(
        sessionActivity(input({ live, toolCalls: [tool({ name: 'Read', startSec: 1 })] })),
      ).toBeNull();
  });

  it('names the running tool and what it works on', () => {
    const read = tool({ name: 'Read', startSec: 5, input: { file_path: '/w/web/src/tokens.css' } });
    const done = tool({ name: 'Bash', startSec: 9, status: 'complete', endedAt: at(10) });
    expect(sessionActivity(input({ toolCalls: [read, done] }))).toEqual({
      kind: 'tool',
      tool: 'Read',
      target: 'tokens.css',
      agentId: 'main',
      since: at(5),
    });
  });

  it('picks what started last, across agents', () => {
    const delegate = tool({
      name: 'Agent',
      startSec: 2,
      input: { description: 'Find the parser' },
    });
    const subRead = tool({ name: 'Grep', startSec: 8, agentId: 'a1', input: { pattern: 'claim' } });
    expect(sessionActivity(input({ toolCalls: [subRead, delegate] }))).toMatchObject({
      kind: 'tool',
      tool: 'Grep',
      target: 'claim',
      agentId: 'a1',
    });
    // The sub-agent is thinking about its next step: newer than the Agent tool waiting on it.
    const subCall = call({ startSec: 9, agentId: 'a1' });
    expect(sessionActivity(input({ toolCalls: [delegate], requests: [subCall] }))).toMatchObject({
      kind: 'thinking',
      agentId: 'a1',
      since: at(9),
    });
  });

  it('counts a tool its open call asked for as running, though its status is not known yet', () => {
    const exec = tool({
      name: 'exec',
      startSec: 0,
      startedAt: null,
      status: 'unknown',
      input: 'ls beds',
    });
    const asking = call({
      startSec: 3,
      blocks: [{ kind: 'tool-use', toolCallId: exec.id, at: at(5) }],
      toolCallIds: [exec.id],
    });
    expect(sessionActivity(input({ toolCalls: [exec], requests: [asking] }))).toMatchObject({
      kind: 'tool',
      tool: 'exec',
      target: 'ls beds',
      since: at(5),
    });
    // Unknown and not asked for by a call in flight: left over, not running.
    const answered = { ...asking, status: 'complete' as const, endedAt: at(9) };
    expect(sessionActivity(input({ toolCalls: [exec], requests: [answered] }))?.kind).toBe(
      'thinking',
    );
  });

  it('times a call in flight from its start, and tells thinking from writing', () => {
    expect(sessionActivity(input({ requests: [call({ startSec: 3 })] }))).toEqual({
      kind: 'thinking',
      tool: null,
      target: null,
      agentId: 'main',
      since: at(3),
    });
    const thought = call({
      startSec: 3,
      blocks: [{ kind: 'thinking', text: null, durationMs: 4000, at: at(7) }],
    });
    expect(sessionActivity(input({ requests: [thought] }))?.kind).toBe('thinking');
    const replying = call({ startSec: 3, blocks: [{ kind: 'text', text: 'Done.', at: at(8) }] });
    expect(sessionActivity(input({ requests: [replying] }))).toMatchObject({
      kind: 'writing',
      since: at(3),
    });
    const answered = call({ startSec: 3, status: 'complete', endedAt: at(9) });
    expect(sessionActivity(input({ requests: [answered] }))).toMatchObject({
      kind: 'thinking',
      since: at(9),
    });
  });

  it('counts a busy open turn with nothing on record as thinking since its last step', () => {
    const r = call({ startSec: 1, status: 'complete', endedAt: at(4) });
    const t = tool({ name: 'Read', startSec: 4, status: 'complete', endedAt: at(6) });
    const sub = tool({
      name: 'Read',
      startSec: 4,
      agentId: 'a1',
      status: 'complete',
      endedAt: at(20),
    });
    expect(sessionActivity(input({ requests: [r], toolCalls: [t, sub] }))).toEqual({
      kind: 'thinking',
      tool: null,
      target: null,
      agentId: 'main',
      since: at(6),
    });
    expect(sessionActivity(input({ lastTurn: turn({ startedAt: at(2) }) }))?.since).toBe(at(2));
  });

  it('does not guess when busy but the turn is over', () => {
    expect(
      sessionActivity(input({ lastTurn: turn({ status: 'complete', endedAt: at(5) }) })),
    ).toBeNull();
    expect(sessionActivity(input({ lastTurn: null }))).toBeNull();
  });

  it('waits on the person, with the tool that asked when one is running', () => {
    const bash = tool({ name: 'Bash', startSec: 6, input: { command: 'rm -rf dist' } });
    expect(sessionActivity(input({ live: 'waiting', toolCalls: [bash] }))).toEqual({
      kind: 'waiting',
      tool: 'Bash',
      target: 'rm -rf dist',
      agentId: 'main',
      since: at(6),
    });
    expect(sessionActivity(input({ live: 'waiting' }))).toEqual({
      kind: 'waiting',
      tool: null,
      target: null,
      agentId: 'main',
      since: null,
    });
  });

  it('is idle since the last step when work went on after the turn’s end mark', () => {
    const resumed = call({ startSec: 50, status: 'complete', endedAt: at(70) });
    expect(
      sessionActivity(
        input({
          live: 'idle',
          lastTurn: turn({ status: 'complete', endedAt: at(30) }),
          requests: [resumed],
        }),
      )?.since,
    ).toBe(at(70));
  });

  it('is idle since the last turn ended, else since the last write', () => {
    expect(
      sessionActivity(
        input({ live: 'idle', lastTurn: turn({ status: 'complete', endedAt: at(30) }) }),
      ),
    ).toEqual({ kind: 'idle', tool: null, target: null, agentId: 'main', since: at(30) });
    expect(sessionActivity(input({ live: 'idle', lastTurn: null, updatedAt: at(40) }))?.since).toBe(
      at(40),
    );
  });
});

describe('activityTarget', () => {
  it.each([
    ['Claude Code Read', 'Read', { file_path: '/w/src/core/model.ts', offset: 10 }, 'model.ts'],
    [
      'Claude Code Bash',
      'Bash',
      { command: 'npm test -- --run\n', description: 'Run tests' },
      'npm test -- --run',
    ],
    ['Claude Code Grep', 'Grep', { pattern: 'claimEarly', path: '/w/src' }, 'claimEarly'],
    [
      'Claude Code Agent',
      'Agent',
      { description: 'Find the parser', prompt: '…' },
      'Find the parser',
    ],
    [
      'Claude Code WebFetch',
      'WebFetch',
      { url: 'https://example.com/docs', prompt: 'x' },
      'example.com',
    ],
    [
      'Claude Code AskUserQuestion',
      'AskUserQuestion',
      { questions: [{ question: 'Which port?' }] },
      'Which port?',
    ],
    [
      'Codex shell argv',
      'shell',
      { command: ['bash', '-lc', 'rg -n activity src'] },
      'rg -n activity src',
    ],
    ['Codex exec_command', 'exec_command', { cmd: 'cargo test' }, 'cargo test'],
    [
      'Codex apply_patch',
      'apply_patch',
      '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: b.md\n',
      'a.ts, b.md',
    ],
    ['OpenCode read', 'read', { filePath: '/home/user/garden/notes.md' }, 'notes.md'],
    ['OpenCode pending raw input', 'bash', '{"command":"ls -la"}', 'ls -la'],
    [
      'OpenCode patch',
      'patch',
      { patchText: '*** Begin Patch\n*** Delete File: old.txt\n' },
      'old.txt',
    ],
    ['oh-my-pi read of a page', 'read', { path: 'https://docs.rs/x', i: 'Check docs' }, 'docs.rs'],
    ['oh-my-pi intent only', 'task', { i: 'Summarise the log' }, 'Summarise the log'],
    ['Grok list_dir', 'list_dir', { target_directory: '/w/src/adapters/' }, 'adapters'],
    [
      'Codex exec code',
      'exec',
      '// @exec: {"timeout": 30}\nls beds\ncat herb.txt',
      'ls beds cat herb.txt',
    ],
    [
      'Claude Code Skill',
      'Skill',
      { skill: 'superpowers:brainstorming' },
      'superpowers:brainstorming',
    ],
    [
      'Claude Code SendMessage',
      'SendMessage',
      { to: 'glassbox-87', summary: 'W6a done', message: '…' },
      'W6a done',
    ],
    ['Claude Code ListAgents', 'ListAgents', {}, null],
    ['an MCP tool with nothing known', 'mcp__db__query_rows', { limit: 5 }, null],
    ['input still arriving', 'Write', '{"file_path":"/w/a.t', null],
    ['no input', 'Read', null, null],
  ])('%s', (_name, name, input, expected) => {
    expect(activityTarget(name, input)).toBe(expected);
  });

  it('keeps a long command to one short line', () => {
    const target = activityTarget('Bash', { command: `echo ${'x'.repeat(500)}\nsecond line` });
    expect(target).toHaveLength(121);
    expect(target?.endsWith('…')).toBe(true);
  });
});

describe('activityTarget masks credentials before they leave the server', () => {
  // Synthetic: the shapes of real tokens, none of their values.
  const ghp = `ghp_${'a'.repeat(36)}`;
  const ant = `sk-ant-api03-${'b'.repeat(40)}`;
  const proj = `sk-proj-${'c'.repeat(40)}`;
  const jwt = `eyJ${'d'.repeat(20)}.${'e'.repeat(20)}.${'f'.repeat(20)}`;
  const bash = (command: string) => activityTarget('Bash', { command });

  it.each([
    ['a token in the environment', `GITHUB_TOKEN=${ghp} gh pr list`, 'GITHUB_TOKEN=••• gh pr list'],
    [
      'an exported API key',
      `export OPENAI_API_KEY=${proj} && codex`,
      'export OPENAI_API_KEY=••• && codex',
    ],
    ['a quoted password', `PGPASSWORD='hunter2 x' psql -h db`, 'PGPASSWORD=••• psql -h db'],
    ['a session cookie flag', 'tool --session=abc123 run', 'tool --session=••• run'],
    [
      'a query-string key',
      'curl "https://api.x.io/v1?api_key=abc123&q=1"',
      'curl "https://api.x.io/v1?api_key=•••&q=1"',
    ],
    [
      'a bearer header',
      `curl -H "Authorization: Bearer ${ant}" https://api.x.io`,
      'curl -H "Authorization: •••" https://api.x.io',
    ],
    [
      'a bearer token in code',
      `fetch(u, { headers: { Authorization: 'Bearer ${ant}' } })`,
      "fetch(u, { headers: { Authorization: 'Bearer •••' } })",
    ],
    [
      'an API key header',
      "curl -H 'X-Api-Key: abc123' https://api.x.io",
      "curl -H 'X-Api-Key: •••' https://api.x.io",
    ],
    [
      'a JSON body key',
      `curl -d '{"token": "abc123", "n": 1}' https://x.io`,
      `curl -d '{"token": "•••", "n": 1}' https://x.io`,
    ],
    [
      'a password flag with a space',
      'vault login --password hunter2 --method=userpass',
      'vault login --password ••• --method=userpass',
    ],
    ['a token flag with a space', `gh auth login --token ${ghp}`, 'gh auth login --token •••'],
    ['mysql -p', 'mysql -u root -phunter2 shop', 'mysql -u root -p••• shop'],
    ['curl -u', 'curl -u admin:hunter2 https://x.io', 'curl -u admin:••• https://x.io'],
    [
      'URL userinfo',
      'git clone https://bob:hunter2@git.x.io/r.git',
      'git clone https://bob:•••@git.x.io/r.git',
    ],
    [
      'a bare GitHub token',
      `echo ${ghp} | gh auth login --with-token`,
      'echo ••• | gh auth login --with-token',
    ],
    ['a bare Anthropic key', `claude --api ${ant}`, 'claude --api •••'],
    [
      'a fine-grained GitHub token',
      `git push https://github_pat_${'g'.repeat(30)}@github.com/x`,
      'git push https://•••@github.com/x',
    ],
    ['a GitLab token', `glab auth login -t glpat-${'h'.repeat(20)}`, 'glab auth login -t •••'],
    ['a Slack token', `slack post xoxb-${'1'.repeat(12)}-abc`, 'slack post •••'],
    [
      'an AWS key id',
      'aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP',
      'aws configure set aws_access_key_id •••',
    ],
    ['a Google key', `gcloud x --key=AIza${'i'.repeat(35)}`, 'gcloud x --key=•••'],
    ['a JWT', `http :8080 "Cookie:${jwt}"`, 'http :8080 "Cookie:•••"'],
  ])('%s', (_name, command, expected) => {
    expect(bash(command)).toBe(expected);
  });

  it('masks code, patterns and argv as well as command strings', () => {
    expect(activityTarget('exec', `const key = '${ant}';\nrun(key)`)).toBe(
      "const key = '•••'; run(key)",
    );
    expect(activityTarget('Grep', { pattern: `token=${ghp}` })).toBe('token=•••');
    expect(
      activityTarget('shell', { command: ['bash', '-lc', `export OPENAI_API_KEY=${proj}; codex`] }),
    ).toBe('export OPENAI_API_KEY=•••; codex');
  });

  it('masks a secret whole before cutting the line, wherever it falls', () => {
    const target = bash(`${'x'.repeat(110)} GITHUB_TOKEN=${ghp} gh pr list`) ?? '';
    expect(target).not.toMatch(/ghp_|aaaa/);
    expect(target.endsWith('…')).toBe(true);
  });

  it.each([
    'npm test -- --run',
    'git log --oneline -5',
    'rg -n "sessionActivity" src',
    'psql -h localhost -p 5432 -U app shop',
    'sort --key 2 data.txt',
    'ssh git@github.com',
    'cat secret_notes.md',
    'grep -n "password" config.example',
    'curl https://example.com/api/v1/items?page=2',
    'echo sk-short',
    'GITHUB_TOKEN=$GH_TOKEN gh pr list',
    `API_KEY=\${OPENAI_API_KEY} node run.js`,
    'grep -n "key=\\|meters.map" web/src/QuotaBar.tsx',
    "grep -E '^export DEEPSEEK_API_KEY=' ~/.bashrc | wc -l",
    'grep -n "key={item.id}" web/src/List.tsx',
  ])('leaves an ordinary command alone: %s', (command) => {
    expect(bash(command)).toBe(command);
  });

  it('shows the home directory as ~, and only the home directory', () => {
    const home = process.env.HOME ?? '';
    expect(bash(`cd ${home}/dev/app && npm test`)).toBe('cd ~/dev/app && npm test');
    expect(bash(`ls ${home}`)).toBe('ls ~');
    expect(bash(`ls ${home}2/x`)).toBe(`ls ${home}2/x`);
    expect(activityTarget('Grep', { pattern: `${home}/notes` })).toBe('~/notes');
  });

  it('has no host for a URL without one', () => {
    expect(activityTarget('WebFetch', { url: 'file:///etc/hosts' })).toBeNull();
    expect(activityTarget('WebFetch', { url: 'user:pass@host/x' })).toBeNull();
    expect(activityTarget('WebFetch', { url: 'https://bob:pw@example.com/x' })).toBe('example.com');
  });
});

describe('thinkingSince', () => {
  it('runs from the call’s last step: the end of its latest own tool', () => {
    const own = tool({ id: 'own', name: 'exec', startSec: 4, status: 'complete', endedAt: at(8) });
    const other = tool({
      id: 'other',
      name: 'Read',
      startSec: 4,
      status: 'complete',
      endedAt: at(20),
    });
    const c = call({ startSec: 3, toolCallIds: [own.id] });
    expect(thinkingSince(c, [own, other])).toBe(at(8));
    expect(thinkingSince({ ...c, toolCallIds: [] }, [own, other])).toBe(at(3));
    // The session's line uses it too, so it does not jump back once the tool ends.
    expect(sessionActivity(input({ requests: [c], toolCalls: [own, other] }))).toMatchObject({
      kind: 'thinking',
      since: at(8),
    });
  });
});

describe('comparing times', () => {
  it('orders by instant, not by text: …:05.100Z is after …:05Z', () => {
    const whole = tool({ name: 'Read', startSec: 0, startedAt: '2026-01-01T00:00:05Z' });
    const later = tool({ name: 'Grep', startSec: 0, startedAt: '2026-01-01T00:00:05.100Z' });
    expect(sessionActivity(input({ toolCalls: [later, whole] }))?.tool).toBe('Grep');
    expect(sessionActivity(input({ toolCalls: [whole, later] }))?.tool).toBe('Grep');
  });
});

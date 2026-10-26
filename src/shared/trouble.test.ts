import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentNode, ModelRequest, SessionActivity, ToolCall, Turn } from '../core/model.js';
import { detectTrouble, type TroubleInput, type TroubleSignal } from './trouble.js';

const T0 = Date.UTC(2026, 9, 23, 9, 0, 0);
const MIN = 60_000;
const at = (min: number) => new Date(T0 + min * MIN).toISOString();
/** Ten minutes after the last thing below happened, unless a test says otherwise. */
const NOW = T0 + 120 * MIN;

let serial = 0;
beforeEach(() => {
  serial = 0;
});

function agent(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id,
    kind: id === 'main' ? 'main' : 'subagent',
    parentId: id === 'main' ? null : 'main',
    spawnedByToolCallId: null,
    agentType: null,
    label: id,
    workflowRunId: null,
    phase: null,
    model: null,
    status: 'running',
    startedAt: at(0),
    endedAt: null,
    usage: {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
      thinking: 0,
      webSearch: 0,
      webFetch: 0,
    },
    counts: { turns: 0, requests: 0, toolCalls: 0 },
    ...over,
  };
}

/** A finished call of the main agent, a minute after the one before it. */
function call(name: string, input: unknown, over: Partial<ToolCall> = {}): ToolCall {
  serial++;
  return {
    id: `t${serial}`,
    agentId: 'main',
    requestId: `r${serial}`,
    name,
    input,
    status: 'complete',
    startedAt: at(serial),
    endedAt: at(serial),
    durationMs: 1000,
    resultPreview: null,
    hasFullResult: false,
    spawned: null,
    ...over,
  };
}
const bash = (command: string, over: Partial<ToolCall> = {}) => call('Bash', { command }, over);

function request(over: Partial<ModelRequest> = {}): ModelRequest {
  serial++;
  return {
    id: `q${serial}`,
    agentId: 'main',
    turnId: 'turn1',
    index: serial,
    model: null,
    effort: null,
    startedAt: at(serial),
    firstBlockAt: null,
    endedAt: at(serial),
    status: 'complete',
    stopReason: 'end_turn',
    usage: null,
    blocks: [],
    toolCallIds: [],
    hasDetail: false,
    error: null,
    ...over,
  };
}

function turn(index: number, startMin: number, endMin: number | null, over: Partial<Turn> = {}) {
  return {
    id: `turn${index}`,
    agentId: 'main',
    index,
    origin: 'human',
    prompt: '…',
    startedAt: at(startMin),
    endedAt: endMin === null ? null : at(endMin),
    status: endMin === null ? 'running' : 'complete',
    requestIds: [],
    ...over,
  } satisfies Turn;
}

interface Parts {
  live?: TroubleInput['session']['live'];
  activity?: SessionActivity;
  updatedAt?: string;
  agents?: AgentNode[];
  turns?: Turn[];
  requests?: ModelRequest[];
  calls?: ToolCall[];
}

function input(p: Parts): TroubleInput {
  const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((x) => [x.id, x]));
  return {
    session: {
      live: p.live ?? 'busy',
      updatedAt: p.updatedAt ?? at(100),
      ...(p.activity ? { activity: p.activity } : {}),
    },
    agents: byId(p.agents ?? [agent('main')]),
    turns: byId(p.turns ?? []),
    requests: byId(p.requests ?? []),
    toolCalls: byId(p.calls ?? []),
  };
}

const label = (t: { name: string; input: unknown }) =>
  t.name === 'Bash' ? String((t.input as { command: string }).command) : t.name;
const detect = (p: Parts, agentId = 'main', now = NOW) =>
  detectTrouble(input(p), agentId, now, label);
const kinds = (signals: TroubleSignal[]) => signals.map((s) => s.kind);

describe('detectTrouble', () => {
  it('finds nothing in a session going well', () => {
    expect(
      detect({
        turns: [turn(1, 0, 4), turn(2, 10, 15), turn(3, 110, null)],
        calls: [bash('npm test'), call('Read', { file_path: 'a.ts' }), bash('npm test')],
        requests: [request(), request({ status: 'error' }), request()],
      }),
    ).toEqual([]);
  });

  describe('repeat', () => {
    it('is three or more calls in a row with the same command line, the latest last', () => {
      const calls = [
        call('Read', { file_path: 'a.ts' }),
        bash('npm test'),
        bash('npm  test '),
        bash('npm test'),
        bash('npm test', { status: 'running', endedAt: null }),
      ];
      expect(detect({ calls })).toEqual([
        {
          kind: 'repeat',
          params: { x: 'npm test', n: 4 },
          at: { kind: 'tool', agentId: 'main', requestId: 'r5', toolCallId: 't5' },
          since: at(2),
        },
      ]);
    });

    it('is not two in a row, nor commands that differ, nor a streak something broke since', () => {
      expect(detect({ calls: [bash('npm test'), bash('npm test')] })).toEqual([]);
      expect(
        detect({ calls: [bash('npm test -- a'), bash('npm test -- b'), bash('npm test -- c')] }),
      ).toEqual([]);
      expect(
        detect({ calls: [bash('npm test'), bash('npm test'), bash('npm test'), bash('ls')] }),
      ).toEqual([]);
    });

    it('compares other tools by their input, and leaves polling alone', () => {
      const read = () => call('Read', { file_path: 'a.ts', limit: 10 });
      expect(kinds(detect({ calls: [read(), read(), read()] }))).toEqual(['repeat']);
      expect(
        detect({
          calls: [
            call('Read', { file_path: 'a.ts' }),
            call('Read', { file_path: 'b.ts' }),
            call('Read', { file_path: 'c.ts' }),
          ],
        }),
      ).toEqual([]);
      const poll = () => call('BashOutput', { bash_id: 'shell_1' });
      expect(detect({ calls: [poll(), poll(), poll(), poll()] })).toEqual([]);
      const wait = () => bash('sleep 60 && gh run view 42');
      expect(detect({ calls: [wait(), wait(), wait()] })).toEqual([]);
    });
  });

  describe('failing', () => {
    it('is three or more failed calls in a row, a call still running aside', () => {
      const calls = [
        bash('true'),
        bash('a', { status: 'error' }),
        bash('b', { status: 'error' }),
        bash('c', { status: 'error' }),
        bash('d', { status: 'running', endedAt: null }),
      ];
      expect(detect({ calls })).toEqual([
        {
          kind: 'failing',
          params: { n: 3 },
          at: { kind: 'tool', agentId: 'main', requestId: 'r4', toolCallId: 't4' },
          since: at(2),
        },
      ]);
    });

    it('is not two, nor failures a success came after', () => {
      expect(
        detect({ calls: [bash('a', { status: 'error' }), bash('b', { status: 'error' })] }),
      ).toEqual([]);
      const calls = ['a', 'b', 'c'].map((c) => bash(c, { status: 'error' }));
      expect(detect({ calls: [...calls, bash('d')] })).toEqual([]);
    });
  });

  describe('errors', () => {
    it('is two or more failed model calls among the last ten', () => {
      const requests = [
        request(),
        request({ status: 'error' }),
        request(),
        request({ status: 'error' }),
        request(),
      ];
      expect(detect({ requests })).toEqual([
        {
          kind: 'errors',
          params: { n: 2, of: 5 },
          at: { kind: 'request', agentId: 'main', requestId: 'q4' },
          since: at(2),
        },
      ]);
    });

    it('is not one, nor two that ten calls since have left behind', () => {
      expect(detect({ requests: [request({ status: 'error' }), request()] })).toEqual([]);
      const old = [request({ status: 'error' }), request({ status: 'error' })];
      const since = Array.from({ length: 10 }, () => request());
      expect(detect({ requests: [...old, ...since] })).toEqual([]);
    });
  });

  describe('long turn', () => {
    const turns = [turn(1, 0, 4), turn(2, 10, 13), turn(3, 20, 25), turn(4, 86, null)];

    it('is a running prompt over three times the others’ median and over ten minutes', () => {
      expect(detect({ turns })).toEqual([
        {
          kind: 'long-turn',
          params: { median: 4 * MIN },
          at: { kind: 'turn', agentId: 'main', turnId: 'turn4' },
          since: at(86),
        },
      ]);
    });

    it('is not under ten minutes, nor under three times the median, nor a first prompt', () => {
      // 34 minutes in, but the others took 15.
      const slow = [turn(1, 0, 15), turn(2, 20, 35), turn(3, 86, null)];
      expect(detect({ turns: slow })).toEqual([]);
      // Three times the median, but nine minutes.
      expect(detect({ turns: [turn(1, 0, 1), turn(2, 111, null)] })).toEqual([]);
      expect(detect({ turns: [turn(1, 0, null)] })).toEqual([]);
    });

    it('is the waiting signal’s to say while the session waits for you', () => {
      expect(kinds(detect({ turns, live: 'waiting', updatedAt: at(118) }))).toEqual([]);
    });
  });

  it('counts three or more compactions as one sign', () => {
    const requests = [
      request({ compactedBefore: true }),
      request({ compactedBefore: true }),
      request(),
      request({ compactedBefore: true }),
    ];
    expect(detect({ requests })).toEqual([
      {
        kind: 'compaction',
        params: { n: 3 },
        at: { kind: 'request', agentId: 'main', requestId: 'q4' },
        since: at(4),
      },
    ]);
    expect(detect({ requests: requests.slice(0, 3) })).toEqual([]);
  });

  describe('waiting', () => {
    const blocked = bash('rm -rf dist', { status: 'running', endedAt: null });
    const activity: SessionActivity = {
      kind: 'waiting',
      tool: 'Bash',
      target: 'rm',
      agentId: 'main',
      since: at(105),
    };

    it('is waiting for you more than ten minutes, at the call that waits', () => {
      expect(detect({ live: 'waiting', activity, calls: [blocked] })).toEqual([
        {
          kind: 'waiting',
          params: {},
          at: { kind: 'tool', agentId: 'main', requestId: 'r1', toolCallId: 't1' },
          since: at(105),
        },
      ]);
    });

    it('is not ten minutes or less, nor a session that does not wait', () => {
      expect(
        detect({ live: 'waiting', activity, calls: [blocked] }, 'main', T0 + 115 * MIN),
      ).toEqual([]);
      expect(detect({ live: 'busy', activity, calls: [blocked] })).toEqual([]);
    });

    it('counts from the last write when nothing says since when, at the running prompt', () => {
      expect(
        detect({ live: 'waiting', updatedAt: at(100), turns: [turn(1, 90, null)] }, 'main', NOW),
      ).toEqual([
        {
          kind: 'waiting',
          params: {},
          at: { kind: 'turn', agentId: 'main', turnId: 'turn1' },
          since: at(100),
        },
      ]);
    });
  });

  describe('steps', () => {
    it('counts a model step once: calls asked for together that fail together are one failure', () => {
      const together = { requestId: 'r-batch' };
      expect(
        detect({
          calls: [
            bash('npm test', { ...together, status: 'error' }),
            bash('npm run lint', { ...together, status: 'error' }),
            bash('npx tsc', { ...together, status: 'error' }),
          ],
        }),
      ).toEqual([]);
      const read = () => call('Read', { file_path: 'a.ts' }, together);
      expect(detect({ calls: [read(), read(), read()] })).toEqual([]);
    });

    it('fails a step only when all it did failed, and counts the calls that failed', () => {
      const step = (id: string, ...statuses: ToolCall['status'][]) =>
        statuses.map((status, i) => bash(`c${id}${i}`, { requestId: id, status }));
      const calls = [
        ...step('a', 'error', 'complete'),
        ...step('b', 'error', 'error'),
        ...step('c', 'error'),
        ...step('d', 'error', 'error'),
      ];
      expect(detect({ calls })).toMatchObject([{ kind: 'failing', params: { n: 5 } }]);
    });

    it('keeps a streak within the prompt that runs: the calls of an earlier one are not it', () => {
      const [first, second, third] = [request(), request(), request()] as [
        ModelRequest,
        ModelRequest,
        ModelRequest,
      ];
      const run = (q: ModelRequest) => bash('npm test', { requestId: q.id });
      const calls = [run(first), run(second), run(third)];
      // You asked for the tests again: two runs in the prompt before, one in this.
      const earlier = [first, second].map((q) => ({ ...q, turnId: 'turn1' }));
      expect(
        detect({
          turns: [turn(1, 0, 4), turn(2, 118, null)],
          requests: [...earlier, { ...third, turnId: 'turn2' }],
          calls,
        }),
      ).toEqual([]);
      // The three in the prompt that runs.
      expect(
        kinds(
          detect({
            turns: [turn(1, 118, null)],
            requests: [first, second, third].map((q) => ({ ...q, turnId: 'turn1' })),
            calls,
          }),
        ),
      ).toEqual(['repeat']);
    });

    it('looks past the polls between the calls it compares', () => {
      const exec = () => call('exec_command', { cmd: 'npm test' });
      const poll = () => call('write_stdin', { session_id: 1, chars: '' });
      expect(detect({ calls: [exec(), poll(), exec(), poll(), poll(), exec()] })).toMatchObject([
        { kind: 'repeat', params: { n: 3 } },
      ]);
    });
  });

  describe('scope', () => {
    const loop = (agentId: string) => [1, 2, 3].map(() => bash('npm test', { agentId }));

    it('reads the agent and its running sub-agents', () => {
      const agents = [agent('main'), agent('sub'), agent('done', { status: 'complete' })];
      expect(detect({ agents, calls: loop('sub') }).map((s) => s.at)).toEqual([
        { kind: 'tool', agentId: 'sub', requestId: 'r3', toolCallId: 't3' },
      ]);
      // A sub-agent that finished is not stuck, however it ended.
      expect(detect({ agents, calls: loop('done') })).toEqual([]);
      // Unless it is the one asked about.
      expect(kinds(detect({ agents, calls: loop('done') }, 'done'))).toEqual(['repeat']);
      // The main agent's sub-agents are not a sibling's.
      expect(detect({ agents, calls: loop('main') }, 'sub')).toEqual([]);
      // Nor are the model calls of one that finished: its errors and compactions are done with.
      const done = { agentId: 'done', status: 'error' as const, compactedBefore: true };
      expect(detect({ agents, requests: [request(done), request(done), request(done)] })).toEqual(
        [],
      );
    });

    it('lists the strongest sign first', () => {
      const failing = ['a', 'a', 'a'].map((c) => bash(c, { status: 'error' }));
      const requests = [
        request({ status: 'error', compactedBefore: true }),
        request({ status: 'error', compactedBefore: true }),
        request({ compactedBefore: true }),
      ];
      expect(kinds(detect({ calls: failing, requests }))).toEqual([
        'repeat',
        'failing',
        'errors',
        'compaction',
      ]);
    });
  });
});

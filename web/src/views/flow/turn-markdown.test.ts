import { describe, expect, it } from 'vitest';
import type { AgentNode, ModelRequest, ToolCall, Turn } from '../../../../src/core/model.js';
import type { OpenSession } from '../../data/store';
import { makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { turnMarkdown } from './turn-markdown';

const AT = '2026-10-23T09:00:00.000Z';

const turn = (prompt: string): Turn => ({
  id: 't1',
  agentId: 'main',
  index: 1,
  origin: 'human',
  prompt,
  startedAt: AT,
  endedAt: AT,
  status: 'complete',
  requestIds: [],
});

function request(
  id: string,
  index: number,
  text: string | null,
  tools: string[] = [],
): ModelRequest {
  return {
    id,
    agentId: 'main',
    turnId: 't1',
    index,
    model: 'claude-opus-4-1',
    effort: null,
    startedAt: AT,
    firstBlockAt: AT,
    endedAt: AT,
    status: 'complete',
    stopReason: tools.length ? 'tool_use' : 'end_turn',
    usage: null,
    blocks: [
      ...(text === null ? [] : [{ kind: 'text' as const, text, at: AT }]),
      ...tools.map((toolCallId) => ({ kind: 'tool-use' as const, toolCallId, at: AT })),
    ],
    toolCallIds: tools,
    hasDetail: false,
    error: null,
  };
}

const tool = (id: string, requestId: string, name: string, input: unknown, ms: number | null) =>
  ({
    id,
    agentId: 'main',
    requestId,
    name,
    input,
    status: ms === null ? 'running' : 'complete',
    startedAt: AT,
    endedAt: ms === null ? null : AT,
    durationMs: ms,
    resultPreview: null,
    hasFullResult: false,
    spawned: null,
  }) as ToolCall;

function session(t: Turn, requests: ModelRequest[], tools: ToolCall[], agents: AgentNode[] = []) {
  const base = demoOpen();
  const open: OpenSession = {
    ...base,
    agents: new Map([...base.agents].filter(([id]) => id === 'main')),
    turns: new Map([[t.id, t]]),
    requests: new Map(requests.map((r) => [r.id, r])),
    toolCalls: new Map(tools.map((x) => [x.id, x])),
  };
  for (const a of agents) open.agents.set(a.id, a);
  return open;
}

const en = makeI18n('en').t;

describe('turnMarkdown', () => {
  it('quotes the prompt, then gives the final reply, then each call: what it did, how long', () => {
    const t = turn('Fix the flaky login test\n\nIt fails one run in five');
    const open = session(
      t,
      [
        request('r1', 1, 'Let me look first.', ['tu1', 'tu2']),
        request('r2', 2, 'It now waits for the **Sign in** button.\n\n20 runs pass.'),
      ],
      [
        tool('tu1', 'r1', 'Bash', { command: 'git status', description: 'Status' }, 1234),
        tool('tu2', 'r1', 'Read', { file_path: '/w/app/src/login.spec.ts' }, 30),
      ],
    );
    expect(turnMarkdown(open, t, en)).toBe(
      [
        '> Fix the flaky login test',
        '>',
        '> It fails one run in five',
        '',
        'It now waits for the **Sign in** button.',
        '',
        '20 runs pass.',
        '',
        '- `Bash` git status · 1.2s',
        '- `Read` login.spec.ts · 30ms',
      ].join('\n'),
    );
  });

  it('gives a sub-agent one line, by its type and its model calls', () => {
    const t = turn('Map the parser');
    const agentTool: ToolCall = {
      ...tool(
        'tu1',
        'r1',
        'Agent',
        { description: 'Map it', subagent_type: 'general-purpose' },
        9000,
      ),
      spawned: { kind: 'agent', agentId: 'a1' },
    };
    const agent = {
      ...(demoOpen().agents.get('main') as AgentNode),
      id: 'a1',
      kind: 'subagent',
      parentId: 'main',
      spawnedByToolCallId: 'tu1',
      agentType: 'general-purpose',
      label: 'Map it',
      counts: { turns: 1, requests: 12, toolCalls: 30 },
    } as AgentNode;
    const open = session(t, [request('r1', 1, null, ['tu1'])], [agentTool], [agent]);
    expect(turnMarkdown(open, t, en)).toBe(
      ['> Map the parser', '', '- Agent `general-purpose` · 12 calls'].join('\n'),
    );
    expect(turnMarkdown(open, t, makeI18n('zh').t)).toBe(
      ['> Map the parser', '', '- 子代理 `general-purpose` · 12 次调用'].join('\n'),
    );
    // Not loaded yet: the call as any other.
    open.agents.delete('a1');
    expect(turnMarkdown(open, t, en)).toBe(
      ['> Map the parser', '', '- `Agent` Map it · 9.0s'].join('\n'),
    );
  });

  it('leaves out what the prompt does not have yet: a final reply, a finished call’s time', () => {
    const t = turn('Run the tests');
    const open = session(
      t,
      [request('r1', 1, 'Running them now.', ['tu1'])],
      [tool('tu1', 'r1', 'Bash', { command: 'npm test' }, null)],
    );
    // The last call ran a tool: what it said is not a final reply.
    expect(turnMarkdown(open, t, en)).toBe(['> Run the tests', '', '- `Bash` npm test'].join('\n'));
    expect(turnMarkdown(session(t, [], []), t, en)).toBe('> Run the tests');
  });
});

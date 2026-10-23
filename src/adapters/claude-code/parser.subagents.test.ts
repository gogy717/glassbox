import { describe, expect, it } from 'vitest';
import { checkSnapshot } from '../../core/invariants.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import {
  agentMeta,
  apiRequest,
  assistantBlocks,
  at,
  compactBoundary,
  taskNotification,
  toolResult,
  userPrompt,
} from './__fixtures__/builders.js';
import { mainFile, makeSource, subagentFile, subagentMetaFile } from './__fixtures__/harness.js';
import { ClaudeSessionParser } from './parser.js';

const spawnAgent = (toolUseId: string, opts: { requestId?: string; agentId?: string } = {}) =>
  assistantBlocks({
    requestId: opts.requestId ?? `req-${toolUseId}`,
    agentId: opts.agentId,
    blocks: [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: { description: 'Scan the repo', subagent_type: 'Explore', prompt: 'Look around' },
      },
    ],
  });

const subagentRun = (agentId: string, requestId: string, output = 30) =>
  [
    userPrompt({ agentId, text: 'Look around', ts: at(10) }),
    apiRequest({ id: `api-${requestId}`, agentId, ts: at(11) }),
    assistantBlocks({
      agentId,
      requestId,
      requestRef: `api-${requestId}`,
      blocks: ['text'],
      blockTs: [at(15)],
      usage: { output },
    }),
  ].flat();

function parser() {
  return new ClaudeSessionParser(makeSource());
}

describe('sub-agents', () => {
  it('a sub-agent file becomes its own agent with an agent-prompt turn and its own requests', () => {
    const p = parser();
    p.ingestLines(mainFile, [userPrompt({ ts: at(0) }), ...spawnAgent('toolu_a')]);
    p.ingestLines(subagentFile('a1'), subagentRun('a1', 'req_sub', 30));
    const s = p.snapshot();
    const sub = s.agents.find((a) => a.id === 'a1');
    expect(sub).toMatchObject({ kind: 'subagent', parentId: MAIN_AGENT_ID, startedAt: at(10) });
    expect(sub?.usage.output).toBe(30);
    expect(sub?.counts).toEqual({ turns: 1, requests: 1, toolCalls: 0 });
    const turn = s.turns.find((t) => t.agentId === 'a1');
    expect(turn).toMatchObject({ origin: 'agent-prompt', index: 1, prompt: 'Look around' });
    expect(s.requests.find((r) => r.id === 'api-req_sub')).toMatchObject({
      agentId: 'a1',
      turnId: turn?.id,
    });
    const main = s.agents.find((a) => a.id === MAIN_AGENT_ID);
    expect(main?.counts.requests).toBe(1);
    expect(s.session.counts?.agents).toBe(2);
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('meta gives label, type and the spawning tool call, which points back at the agent', () => {
    const p = parser();
    p.ingestLines(mainFile, [userPrompt(), ...spawnAgent('toolu_a')]);
    p.ingestJson(
      subagentMetaFile('a1'),
      agentMeta({ agentType: 'Explore', description: 'Scan the repo', toolUseId: 'toolu_a' }),
    );
    p.ingestLines(subagentFile('a1'), subagentRun('a1', 'req_sub'));
    const s = p.snapshot();
    expect(s.agents.find((a) => a.id === 'a1')).toMatchObject({
      label: 'Scan the repo',
      agentType: 'Explore',
      spawnedByToolCallId: 'toolu_a',
      parentId: MAIN_AGENT_ID,
    });
    expect(s.toolCalls.find((t) => t.id === 'toolu_a')?.spawned).toEqual({
      kind: 'agent',
      agentId: 'a1',
    });
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('links nested agents whatever order their files arrive in', () => {
    const p = parser();
    p.ingestLines(mainFile, [userPrompt(), ...spawnAgent('toolu_a')]);
    // The nested agent's meta arrives before its parent sub-agent's records.
    p.ingestJson(subagentMetaFile('a2'), agentMeta({ toolUseId: 'toolu_b' }));
    p.ingestJson(subagentMetaFile('a1'), agentMeta({ toolUseId: 'toolu_a' }));
    let s = p.snapshot();
    expect(s.agents.find((a) => a.id === 'a2')?.spawnedByToolCallId).toBeNull();
    expect(checkSnapshot(s)).toEqual([]);

    const ch = p.ingestLines(subagentFile('a1'), [
      userPrompt({ agentId: 'a1' }),
      ...spawnAgent('toolu_b', { agentId: 'a1' }),
    ]);
    expect(ch.agents).toContain('a2');
    s = p.snapshot();
    expect(s.agents.find((a) => a.id === 'a2')).toMatchObject({
      parentId: 'a1',
      spawnedByToolCallId: 'toolu_b',
    });
    expect(s.toolCalls.find((t) => t.id === 'toolu_b')?.spawned).toEqual({
      kind: 'agent',
      agentId: 'a2',
    });
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('the Agent tool result links the agent even without meta', () => {
    const p = parser();
    p.ingestLines(mainFile, [
      userPrompt(),
      ...spawnAgent('toolu_a'),
      toolResult({
        toolUseId: 'toolu_a',
        content: 'Async agent launched',
        toolUseResult: { status: 'async_launched', agentId: 'a1', isAsync: true },
      }),
    ]);
    p.ingestLines(subagentFile('a1'), subagentRun('a1', 'req_sub'));
    const s = p.snapshot();
    expect(s.agents.find((a) => a.id === 'a1')).toMatchObject({
      spawnedByToolCallId: 'toolu_a',
      label: 'Scan the repo',
      status: 'running',
    });
    expect(s.toolCalls.find((t) => t.id === 'toolu_a')?.spawned).toEqual({
      kind: 'agent',
      agentId: 'a1',
    });
  });
});

describe('sub-agent status', () => {
  const setup = () => {
    const p = parser();
    p.setLive('busy');
    p.ingestLines(mainFile, [userPrompt(), ...spawnAgent('toolu_a')]);
    p.ingestJson(subagentMetaFile('a1'), agentMeta({ toolUseId: 'toolu_a' }));
    p.ingestLines(subagentFile('a1'), subagentRun('a1', 'req_sub'));
    return p;
  };
  const status = (p: ClaudeSessionParser) => p.snapshot().agents.find((a) => a.id === 'a1')?.status;

  it('is running while live with no completion signal, unknown once closed', () => {
    const p = setup();
    expect(status(p)).toBe('running');
    p.setLive('closed');
    expect(status(p)).toBe('unknown');
  });

  it('is complete when meta says finished', () => {
    const p = setup();
    const ch = p.ingestJson(
      subagentMetaFile('a1'),
      agentMeta({ toolUseId: 'toolu_a', finished: true }),
    );
    expect(ch.agents).toContain('a1');
    expect(status(p)).toBe('complete');
  });

  it('follows the task notification for its tool call', () => {
    const p = setup();
    p.ingestLines(mainFile, [
      taskNotification({ taskId: 'a1', toolUseId: 'toolu_a', status: 'completed', ts: at(40) }),
    ]);
    expect(status(p)).toBe('complete');
    expect(p.snapshot().agents.find((a) => a.id === 'a1')?.endedAt).toBe(at(40));

    const q = setup();
    q.ingestLines(mainFile, [taskNotification({ taskId: 'a1', status: 'failed' })]);
    expect(status(q)).toBe('error');
  });

  it('is complete when the parent tool result reports completed', () => {
    const p = setup();
    p.ingestLines(mainFile, [
      toolResult({
        toolUseId: 'toolu_a',
        toolUseResult: { status: 'completed', agentId: 'a1', totalTokens: 5 },
      }),
    ]);
    expect(status(p)).toBe('complete');
  });
});

describe('sub-agent requests without stop_reason', () => {
  it('the last response of a finished agent is complete', () => {
    const p = parser();
    p.ingestLines(mainFile, [userPrompt(), ...spawnAgent('toolu_a')]);
    p.ingestJson(subagentMetaFile('a1'), agentMeta({ toolUseId: 'toolu_a' }));
    p.ingestLines(subagentFile('a1'), [
      userPrompt({ agentId: 'a1' }),
      ...assistantBlocks({
        agentId: 'a1',
        requestId: 'r_last',
        blocks: ['text'],
        stopReason: null,
      }),
    ]);
    p.setLive('closed');
    expect(p.snapshot().requests.find((r) => r.id === 'r_last')?.status).toBe('interrupted');
    const ch = p.ingestJson(
      subagentMetaFile('a1'),
      agentMeta({ toolUseId: 'toolu_a', finished: true }),
    );
    expect(ch.requests).toContain('r_last');
    expect(p.snapshot().requests.find((r) => r.id === 'r_last')?.status).toBe('complete');
  });
});

describe('fork de-duplication', () => {
  it('a fork agent copying the parent request is counted once, for the parent', () => {
    const shared = assistantBlocks({
      requestId: 'req_shared',
      blocks: [{ type: 'tool_use', id: 'toolu_f', name: 'Agent' }],
      usage: { output: 100, input: 5, cacheRead: 0, cacheWrite1h: 0 },
    });
    const p = parser();
    p.ingestLines(mainFile, [userPrompt(), ...shared]);
    // The fork's first record is a copy of the parent's (fresh uuid, same requestId).
    const copy = JSON.parse(shared[0] as string);
    copy.uuid = 'fork-copy-uuid';
    copy.agentId = 'f1';
    copy.isSidechain = true;
    p.ingestJson(subagentMetaFile('f1'), agentMeta({ agentType: 'fork', toolUseId: 'toolu_f' }));
    p.ingestLines(subagentFile('f1'), [
      JSON.stringify(copy),
      userPrompt({ agentId: 'f1', text: 'continue as fork' }),
      ...assistantBlocks({
        agentId: 'f1',
        requestId: 'req_fork_own',
        blocks: ['text'],
        usage: { output: 7, input: 1, cacheRead: 0, cacheWrite1h: 0 },
      }),
    ]);
    const s = p.snapshot();
    expect(s.requests.map((r) => [r.id, r.agentId])).toEqual([
      ['req_shared', MAIN_AGENT_ID],
      ['req_fork_own', 'f1'],
    ]);
    expect(s.session.usage?.output).toBe(107);
    expect(s.agents.find((a) => a.id === 'f1')?.usage.output).toBe(7);
    expect(checkSnapshot(s)).toEqual([]);
  });
});

describe('sub-agent compaction', () => {
  it("a compaction in a sub-agent marks only that agent's next request", () => {
    const p = parser();
    p.ingestLines(mainFile, [userPrompt(), ...spawnAgent('toolu_a')]);
    p.ingestLines(subagentFile('a1'), [
      userPrompt({ agentId: 'a1' }),
      compactBoundary({ agentId: 'a1' }),
    ]);
    p.ingestLines(mainFile, assistantBlocks({ requestId: 'r_main', blocks: ['text'] }));
    p.ingestLines(
      subagentFile('a1'),
      assistantBlocks({ agentId: 'a1', requestId: 'r_sub', blocks: ['text'] }),
    );
    const flags = Object.fromEntries(
      p.snapshot().requests.map((r) => [r.id, r.compactedBefore ?? false]),
    );
    expect(flags).toEqual({ 'req-toolu_a': false, r_main: false, r_sub: true });
  });
});

describe('ended sub-agents', () => {
  const started = () => {
    const p = parser();
    p.setLive('busy');
    p.ingestLines(mainFile, [userPrompt(), ...spawnAgent('toolu_a')]);
    p.ingestJson(subagentMetaFile('a1'), agentMeta({ toolUseId: 'toolu_a' }));
    return p;
  };
  const view = (p: ClaudeSessionParser) => {
    const s = p.snapshot();
    return {
      agent: s.agents.find((a) => a.id === 'a1')?.status,
      requests: s.requests.filter((r) => r.agentId === 'a1').map((r) => r.status),
      turns: s.turns.filter((t) => t.agentId === 'a1').map((t) => t.status),
      tools: s.toolCalls.filter((t) => t.agentId === 'a1').map((t) => t.status),
    };
  };

  it('a killed agent waiting on the model is no longer in flight', () => {
    const p = started();
    p.ingestLines(subagentFile('a1'), [
      userPrompt({ agentId: 'a1' }),
      apiRequest({ id: 'api-a', agentId: 'a1' }),
    ]);
    const ch = p.ingestLines(mainFile, [
      taskNotification({ taskId: 'a1', toolUseId: 'toolu_a', status: 'killed' }),
    ]);
    expect(ch.requests).toContain('api-a');
    expect(view(p)).toEqual({
      agent: 'interrupted',
      requests: ['interrupted'],
      turns: ['interrupted'],
      tools: [],
    });
  });

  it('a killed agent running a tool no longer shows the tool running', () => {
    const p = started();
    p.ingestLines(subagentFile('a1'), [
      userPrompt({ agentId: 'a1' }),
      ...assistantBlocks({
        agentId: 'a1',
        requestId: 'r_a',
        blocks: [{ type: 'tool_use', id: 't_a' }],
      }),
    ]);
    const ch = p.ingestLines(mainFile, [
      taskNotification({ taskId: 'a1', toolUseId: 'toolu_a', status: 'killed' }),
    ]);
    expect(ch.toolCalls).toContain('t_a');
    expect(view(p).tools).toEqual(['unknown']);
    expect(view(p).turns).not.toContain('running');
  });

  it('a foreground agent whose Agent call errored has ended', () => {
    const p = started();
    p.ingestLines(subagentFile('a1'), [
      userPrompt({ agentId: 'a1' }),
      apiRequest({ id: 'api-a', agentId: 'a1' }),
    ]);
    p.ingestLines(mainFile, [
      toolResult({
        toolUseId: 'toolu_a',
        isError: true,
        content: '[Request interrupted by user for tool use]',
      }),
    ]);
    expect(view(p)).toMatchObject({ agent: 'interrupted', requests: ['interrupted'] });
  });
});

describe('fork transcripts', () => {
  it("the fork's copy of the parent tool result neither overwrites it nor hides the directive", () => {
    const p = parser();
    p.ingestLines(mainFile, [
      userPrompt(),
      ...assistantBlocks({
        requestId: 'r_parent',
        blocks: [{ type: 'tool_use', id: 'toolu_f', name: 'Agent' }],
        blockTs: [at(2)],
      }),
      toolResult({ toolUseId: 'toolu_f', content: 'REAL parent result', ts: at(30) }),
    ]);
    p.ingestJson(subagentMetaFile('f1'), agentMeta({ agentType: 'fork', toolUseId: 'toolu_f' }));
    p.ingestLines(subagentFile('f1'), [
      userPrompt({
        agentId: 'f1',
        ts: at(5),
        origin: null,
        contentBlocks: [
          { type: 'tool_result', tool_use_id: 'toolu_f', content: 'Fork started placeholder' },
          { type: 'text', text: 'Do the forked task' },
        ],
      }),
    ]);
    const s = p.snapshot();
    expect(s.toolCalls.find((t) => t.id === 'toolu_f')).toMatchObject({
      resultPreview: 'REAL parent result',
      endedAt: at(30),
    });
    expect(s.turns.filter((t) => t.agentId === 'f1').map((t) => [t.origin, t.prompt])).toEqual([
      ['agent-prompt', 'Do the forked task'],
    ]);
  });
});

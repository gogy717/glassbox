import { describe, expect, it } from 'vitest';
import { checkSnapshot } from '../../core/invariants.js';
import {
  at,
  CHILD_ID,
  CWD,
  gardenSession,
  line,
  ms,
  SESSION_ID,
  sessionMeta,
  TURN_1,
  TURN_2,
  tokenCount,
  unix,
  usage,
} from './__fixtures__/builders.js';
import { childFile, feed, mainFile } from './__fixtures__/harness.js';

describe('CodexSessionParser', () => {
  it('maps one user turn onto several model responses and counts each response once', () => {
    const parser = feed(gardenSession());
    const snap = parser.snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(JSON.stringify(snap)).not.toContain('ciphertext-sentinel');
    expect(JSON.stringify(snap)).not.toContain('ui echo should not duplicate');
    expect(JSON.stringify(snap)).not.toContain('injected context');
    expect(snap.session).toMatchObject({
      id: `codex:${SESSION_ID}`,
      agent: 'codex',
      title: 'Garden plan',
      cwd: CWD,
      project: 'garden',
      model: 'gpt-5.6-sol',
      version: '0.153.4',
      live: 'closed',
    });
    expect(
      snap.turns.map((t) => ({
        index: t.index,
        origin: t.origin,
        prompt: t.prompt,
        status: t.status,
      })),
    ).toEqual([{ index: 1, origin: 'human', prompt: 'Draw a garden plan', status: 'complete' }]);
    expect(snap.requests.map((r) => r.id)).toEqual(['resp_1', 'resp_2']);
    expect(snap.requests[0]).toMatchObject({
      index: 1,
      turnId: TURN_1,
      model: 'gpt-5.6-sol',
      effort: 'high',
      status: 'complete',
      startedAt: at(3),
      firstBlockAt: at(3),
      endedAt: at(7),
      usage: { input: 60, cacheRead: 40, cacheWrite: 0, output: 10, thinking: 4, webSearch: 0 },
    });
    expect(snap.requests[0]?.blocks).toEqual([
      { kind: 'thinking', text: 'sketch the beds', durationMs: 500, at: at(3) },
      { kind: 'text', text: "I'll look around.", at: at(4) },
      { kind: 'tool-use', toolCallId: 'call_exec', at: at(5) },
    ]);
    expect(snap.requests[1]).toMatchObject({
      index: 2,
      status: 'complete',
      usage: { input: 0, cacheRead: 50, output: 5, thinking: 5 },
    });
    expect(snap.requests[1]?.blocks[0]).toEqual({
      kind: 'thinking',
      text: null,
      durationMs: null,
      at: at(8),
    });
    expect(snap.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call_exec',
        name: 'exec',
        input: 'ls beds',
        status: 'complete',
        requestId: 'resp_1',
        durationMs: 40,
        resultPreview: 'herb.txt',
        hasFullResult: true,
        spawned: null,
      }),
    ]);
    expect(parser.toolResult('call_exec')).toBe('herb.txt');
    expect(snap.workflows).toEqual([]);
    expect(snap.agents.map((a) => a.id)).toEqual(['main']);
    expect(snap.session.usage).toEqual(snap.agents[0]?.usage);
    expect(snap.session.usage).toMatchObject({ input: 60, cacheRead: 90, output: 15, thinking: 9 });
    expect(snap.session.counts).toEqual({ turns: 1, requests: 2, toolCalls: 1, agents: 1 });
    expect(snap.diagnostics).toEqual({
      unknownRecordTypes: { snack_time: 1 },
      parseErrors: 1,
      unavailable: ['live-state-heuristic'],
    });
    expect(parser.requestDetail('resp_2')).toMatchObject({
      completeness: 'partial',
      system: 'You tend a garden.',
      tools: [{ name: 'exec' }],
      messages: null,
    });
    const changes = parser.ingestLines(
      {
        path: '/tmp/more.jsonl',
        format: 'jsonl',
        role: 'rollout',
        agentId: null,
        workflowRunId: null,
      },
      [],
    );
    expect(changes.requests).toEqual([]);
  });

  it('links a child rollout as a sub-agent and keeps its tokens on that agent', () => {
    const parent = [
      sessionMeta(),
      line('turn_context', 1, 1, { turn_id: TURN_1, model: 'gpt-5.6-sol', effort: 'low' }),
      line('event_msg', 2, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
      line('event_msg', 3, 1, {
        type: 'item_completed',
        item: { type: 'UserMessage', content: [{ type: 'text', text: 'Scout the herbs' }] },
      }),
      line('response_item', 4, 2, {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'call_spawn',
        arguments: JSON.stringify({ task_name: 'scout' }),
        internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
      }),
      line('event_msg', 5, 2, {
        type: 'item_completed',
        item: {
          type: 'SubAgentActivity',
          id: 'call_spawn',
          kind: 'started',
          agent_thread_id: CHILD_ID,
          agent_path: 'explore',
        },
      }),
      usage({
        ordinal: 6,
        sec: 3,
        responseId: 'resp_parent',
        turnId: TURN_1,
        input: 20,
        cached: 0,
        output: 4,
        reasoning: 1,
      }),
      line('event_msg', 7, 4, { type: 'task_complete', turn_id: TURN_1, completed_at: unix(4) }),
    ];
    const child = [
      line('session_meta', 0, 2, {
        id: CHILD_ID,
        cwd: CWD,
        cli_version: '0.153.4',
        parent_thread_id: SESSION_ID,
        timestamp: at(2),
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: SESSION_ID,
              agent_path: 'explore',
              agent_nickname: 'Scout',
              depth: 1,
            },
          },
        },
      }),
      line('turn_context', 1, 2, { turn_id: TURN_2, model: 'gpt-5.6-terra', effort: 'low' }),
      line('event_msg', 2, 2, { type: 'task_started', turn_id: TURN_2, started_at: unix(2) }),
      line('response_item', 3, 2, {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Look at the herbs' }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN_2 },
      }),
      line('response_item', 4, 3, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Thyme.' }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN_2 },
      }),
      usage({
        ordinal: 5,
        sec: 4,
        responseId: 'resp_child',
        turnId: TURN_2,
        input: 10,
        cached: 0,
        output: 2,
        reasoning: 1,
      }),
      line('event_msg', 6, 4, { type: 'task_complete', turn_id: TURN_2, completed_at: unix(4) }),
    ];
    const snap = feed(parent, [{ file: childFile, lines: child }]).snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.agents.map((a) => a.id)).toEqual(['main', CHILD_ID]);
    expect(snap.agents[1]).toMatchObject({
      kind: 'subagent',
      parentId: 'main',
      spawnedByToolCallId: 'call_spawn',
      agentType: 'explore',
      label: 'Scout',
      model: 'gpt-5.6-terra',
      usage: { input: 10, cacheRead: 0, output: 2, thinking: 1 },
    });
    expect(snap.agents[0]?.usage).toMatchObject({ input: 20, output: 4, thinking: 1 });
    expect(snap.session.usage).toMatchObject({ input: 30, output: 6, thinking: 2 });
    expect(snap.toolCalls[0]).toMatchObject({
      id: 'call_spawn',
      name: 'spawn_agent',
      spawned: { kind: 'agent', agentId: CHILD_ID },
    });
    expect(snap.turns.find((t) => t.id === TURN_2)).toMatchObject({
      agentId: CHILD_ID,
      origin: 'agent-prompt',
      prompt: 'Look at the herbs',
    });

    const reversed = feed([], [{ file: childFile, lines: child }]);
    reversed.ingestLines(
      {
        path: '/tmp/parent.jsonl',
        format: 'jsonl',
        role: 'rollout',
        agentId: null,
        workflowRunId: null,
      },
      parent,
    );
    const again = reversed.snapshot();
    expect(checkSnapshot(again)).toEqual([]);
    expect(again.agents[1]).toMatchObject({
      id: CHILD_ID,
      spawnedByToolCallId: 'call_spawn',
      label: 'Scout',
    });
  });

  it('falls back to token_count on old rollouts and does not double-count a repeat or a usage record', () => {
    const onlyCount = feed([
      sessionMeta(),
      line('event_msg', 1, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
      line('response_item', 2, 1, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Ok' }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
      }),
      tokenCount(3, 2, 20, 5, 4, 2),
      tokenCount(4, 2, 20, 5, 4, 2),
      line('response_item', 5, 3, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'More' }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
      }),
      tokenCount(6, 4, 30, 5, 6, 1),
      line('event_msg', 7, 5, { type: 'task_complete', turn_id: TURN_1, completed_at: unix(5) }),
    ]).snapshot();
    expect(checkSnapshot(onlyCount)).toEqual([]);
    expect(onlyCount.requests).toHaveLength(2);
    expect(onlyCount.requests[0]?.usage).toMatchObject({
      input: 15,
      cacheRead: 5,
      output: 4,
      thinking: 2,
    });
    expect(onlyCount.requests[1]?.usage).toMatchObject({
      input: 25,
      cacheRead: 5,
      output: 6,
      thinking: 1,
    });
    expect(onlyCount.session.usage).toMatchObject({
      input: 40,
      cacheRead: 10,
      output: 10,
      thinking: 3,
    });

    const countThenUsage = feed([
      sessionMeta(),
      line('event_msg', 1, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
      line('response_item', 2, 2, {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'note' }],
        encrypted_content: 'ciphertext-sentinel',
        internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
      }),
      tokenCount(3, 3, 10, 0, 1, 0),
      usage({ ordinal: 4, sec: 3, responseId: 'resp_real', turnId: TURN_1, input: 10, output: 1 }),
      line('event_msg', 5, 4, { type: 'task_complete', turn_id: TURN_1, completed_at: unix(4) }),
    ]).snapshot();
    expect(checkSnapshot(countThenUsage)).toEqual([]);
    expect(countThenUsage.requests.map((r) => r.id)).toEqual(['resp_real']);
    expect(countThenUsage.session.usage).toMatchObject({ input: 10, output: 1 });
  });

  it('marks a turn error, an abort, and an open call that the process has left', () => {
    const errored = feed([
      sessionMeta(),
      line('event_msg', 1, 1, {
        type: 'task_started',
        turn_id: TURN_1,
        started_at: unix(1),
        turn_attribution: { turn_trigger: 'automation_heartbeat_scheduled' },
      }),
      line('event_msg', 2, 1, {
        type: 'item_completed',
        item: { type: 'UserMessage', content: [{ type: 'text', text: 'tick' }] },
      }),
      line('response_item', 3, 2, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'no' }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
      }),
      usage({ ordinal: 4, sec: 3, responseId: 'resp_err', turnId: TURN_1, input: 8, output: 1 }),
      line('event_msg', 5, 4, {
        type: 'task_complete',
        turn_id: TURN_1,
        completed_at: unix(4),
        error: { message: 'rate limited', codex_error_info: 'not-a-status' },
      }),
    ]).snapshot();
    expect(errored.turns[0]).toMatchObject({ origin: 'other', status: 'error', prompt: 'tick' });
    expect(errored.requests[0]).toMatchObject({
      status: 'error',
      error: { message: 'rate limited', status: null, retryAttempt: null },
    });
    expect(checkSnapshot(errored)).toEqual([]);

    const parser = feed(
      [
        sessionMeta(),
        line('event_msg', 1, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
        line('response_item', 2, 2, {
          type: 'reasoning',
          summary: [],
          encrypted_content: 'ciphertext-sentinel',
          internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
        }),
      ],
      [],
      'busy',
    );
    expect(parser.snapshot().requests[0]).toMatchObject({ status: 'in-flight', usage: null });
    expect(parser.snapshot().turns[0]).toMatchObject({ status: 'running' });
    parser.setLive('closed');
    const closed = parser.snapshot();
    expect(closed.requests[0]?.status).toBe('interrupted');
    expect(closed.turns[0]?.status).toBe('interrupted');
    expect(closed.session.live).toBe('closed');
    expect(checkSnapshot(closed)).toEqual([]);

    const aborted = feed([
      sessionMeta(),
      line('event_msg', 1, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
      line('response_item', 2, 2, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'partial' }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
      }),
      line('event_msg', 3, 3, { type: 'turn_aborted', turn_id: TURN_1, reason: 'interrupted' }),
    ]).snapshot();
    expect(aborted.turns[0]?.status).toBe('interrupted');
    expect(aborted.requests[0]?.status).toBe('interrupted');
    expect(checkSnapshot(aborted)).toEqual([]);
  });

  it('flags the request after compaction and reports an unreadable archive', () => {
    const snap = feed([
      sessionMeta(),
      line('event_msg', 1, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
      line('response_item', 2, 2, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'before' }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
      }),
      usage({ ordinal: 3, sec: 2, responseId: 'resp_before', turnId: TURN_1, input: 4, output: 1 }),
      line('compacted', 4, 3, { replacement_history: [{ role: 'user', content: 'old' }] }),
      line('response_item', 5, 4, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'after' }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
      }),
      usage({ ordinal: 6, sec: 5, responseId: 'resp_after', turnId: TURN_1, input: 6, output: 1 }),
      line('event_msg', 7, 5, { type: 'task_complete', turn_id: TURN_1, completed_at: unix(5) }),
    ]).snapshot();
    expect(
      snap.requests.map((r) => ({ id: r.id, compactedBefore: r.compactedBefore ?? false })),
    ).toEqual([
      { id: 'resp_before', compactedBefore: false },
      { id: 'resp_after', compactedBefore: true },
    ]);
    expect(JSON.stringify(snap)).not.toContain('replacement_history');
    expect(checkSnapshot(snap)).toEqual([]);

    const parser = feed([sessionMeta()]);
    parser.markArchivesUnavailable();
    expect(parser.snapshot().diagnostics.unavailable).toEqual([
      'archived-sessions',
      'live-state-heuristic',
    ]);
    expect(checkSnapshot(parser.snapshot())).toEqual([]);
  });

  it('records a web_search_call as a tool and takes timing from the WebSearch item', () => {
    const snap = feed([
      sessionMeta(),
      line('event_msg', 1, 1, {
        type: 'task_started',
        turn_id: TURN_1,
        started_at: unix(1),
        turn_attribution: { turn_trigger: 'composer' },
      }),
      line('response_item', 2, 2, {
        type: 'web_search_call',
        id: 'ws_call_1',
        status: 'completed',
        action: { type: 'search', query: 'thyme', queries: ['thyme'] },
        internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
      }),
      line('event_msg', 3, 3, {
        type: 'item_completed',
        turn_id: TURN_1,
        started_at_ms: ms(2),
        completed_at_ms: ms(2) + 120,
        item: { type: 'WebSearch', id: 'ws_call_1', query: 'thyme' },
      }),
      usage({ ordinal: 4, sec: 4, responseId: 'resp_search', turnId: TURN_1, input: 8, output: 2 }),
      line('event_msg', 5, 4, { type: 'task_complete', turn_id: TURN_1, completed_at: unix(4) }),
    ]).snapshot();
    expect(snap.diagnostics.unknownRecordTypes).toEqual({});
    expect(snap.toolCalls).toHaveLength(1);
    expect(snap.toolCalls[0]).toMatchObject({
      id: 'ws_call_1',
      name: 'web_search',
      requestId: 'resp_search',
      status: 'complete',
      durationMs: 120,
      input: { type: 'search', query: 'thyme', queries: ['thyme'] },
    });
    expect(snap.session.usage?.webSearch).toBe(0);
    expect(checkSnapshot(snap)).toEqual([]);
  });
});

/** Too deep for JSON.stringify, which gives up between 5,000 and 8,000 levels on Node 24. */
const DEPTH = 20_000;
const DEEP_VALUES = [
  `${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}`,
  `${'{"content":'.repeat(DEPTH)}"x"${'}'.repeat(DEPTH)}`,
];
const MARK = '__deep_value__';

/** Copies of `line` with one value replaced by a deep one, for every value position. */
function deepened(line: string): string[] {
  let root: unknown;
  try {
    root = JSON.parse(line);
  } catch {
    return [];
  }
  const out: string[] = [];
  const visit = (node: unknown, set: (v: unknown) => void) => {
    set(MARK);
    const text = JSON.stringify(root);
    // Raw, and as a string holding JSON (tool arguments are parsed from one).
    for (const deep of [...DEEP_VALUES, JSON.stringify(DEEP_VALUES[0])])
      out.push(text.replace(`"${MARK}"`, deep));
    set(node);
    if (node === null || typeof node !== 'object') return;
    const holder = node as Record<string, unknown>;
    for (const key of Object.keys(holder)) {
      visit(holder[key], (v) => {
        holder[key] = v;
      });
    }
  };
  visit(root, (v) => {
    root = v;
  });
  return out;
}

describe('malformed input never throws', () => {
  it('a value nested too deep to serialise, anywhere in any record', () => {
    const lines = gardenSession();
    const failures: string[] = [];
    lines.forEach((original, at) => {
      for (const deep of deepened(original)) {
        try {
          const p = feed([...lines.slice(0, at), deep]);
          p.ingestLines(mainFile, lines.slice(at + 1));
          const snap = p.snapshot();
          for (const r of snap.requests) p.requestDetail(r.id);
          for (const t of snap.toolCalls) p.toolResult(t.id);
        } catch (err) {
          failures.push(`line ${at}: ${(err as Error).message}`);
        }
      }
    });
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('out-of-range times in every record kind are treated as missing', () => {
    const bad = (type: string, payload: object) =>
      JSON.stringify({ timestamp: 1e300, ordinal: 1, type, payload });
    expect(() =>
      feed([
        JSON.stringify({
          timestamp: 1e300,
          ordinal: 0,
          type: 'session_meta',
          payload: { id: SESSION_ID, timestamp: 1e300 },
        }),
        bad('event_msg', { type: 'task_started', turn_id: TURN_1, started_at: 1e300 }),
        bad('event_msg', {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'c1',
            started_at_ms: 1e300,
            completed_at_ms: 1e300,
          },
        }),
        bad('event_msg', { type: 'task_complete', turn_id: TURN_1, completed_at: 1e300 }),
      ]).snapshot(),
    ).not.toThrow();
  });
});

describe('copied history in child rollouts', () => {
  it('records before subagent_history_start_ordinal are the parent’s, not the child’s', () => {
    const pass = (turnId: string) => ({
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
    const main = [
      sessionMeta(),
      line('event_msg', 1, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
      line('response_item', 2, 2, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Spawning a helper.' }],
        ...pass(TURN_1),
      }),
      usage({ ordinal: 3, sec: 3, responseId: 'resp_p1', turnId: TURN_1, input: 50, output: 5 }),
      line('event_msg', 4, 9, { type: 'task_complete', turn_id: TURN_1, completed_at: unix(9) }),
    ];
    const child = [
      line('session_meta', 0, 2, {
        id: CHILD_ID,
        session_id: CHILD_ID,
        timestamp: at(2),
        parent_thread_id: SESSION_ID,
        subagent_history_start_ordinal: 5,
        forked_from_id: SESSION_ID,
      }),
      // A copy of the parent's turn so far.
      line('event_msg', 1, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
      line('response_item', 2, 2, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Spawning a helper.' }],
        ...pass(TURN_1),
      }),
      usage({ ordinal: 3, sec: 3, responseId: 'resp_p1', turnId: TURN_1, input: 50, output: 5 }),
      line('response_item', 4, 3, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Copied tail.' }],
        ...pass(TURN_1),
      }),
      // The child's own work.
      line('event_msg', 5, 4, { type: 'task_started', turn_id: 'child-turn', started_at: unix(4) }),
      line('response_item', 6, 5, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Helper here.' }],
        ...pass('child-turn'),
      }),
      usage({
        ordinal: 7,
        sec: 6,
        responseId: 'resp_c1',
        turnId: 'child-turn',
        input: 30,
        output: 3,
      }),
      line('event_msg', 8, 7, {
        type: 'task_complete',
        turn_id: 'child-turn',
        completed_at: unix(7),
      }),
    ];
    const s = feed(main, [{ file: childFile, lines: child }]).snapshot();
    expect(s.requests.map((r) => [r.agentId, r.id])).toEqual([
      ['main', 'resp_p1'],
      [CHILD_ID, 'resp_c1'],
    ]);
    expect(s.turns.filter((t) => t.agentId === CHILD_ID).map((t) => t.id)).toEqual(['child-turn']);
    expect(s.session.usage?.output).toBe(8);
    expect(checkSnapshot(s)).toEqual([]);
  });
});

describe('token_count usage', () => {
  const pass = { internal_chat_message_metadata_passthrough: { turn_id: TURN_1 } };
  const start = line('event_msg', 1, 1, {
    type: 'task_started',
    turn_id: TURN_1,
    started_at: unix(1),
  });
  const think = (ordinal: number) =>
    line('response_item', ordinal, ordinal, {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'x',
      ...pass,
    });
  const say = (ordinal: number) =>
    line('response_item', ordinal, ordinal, {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }],
      ...pass,
    });
  const tokens = (s: ReturnType<ReturnType<typeof feed>['snapshot']>) =>
    s.requests.map((r) => (r.usage ? r.usage.input + r.usage.cacheRead + r.usage.output : null));

  it('a rebroadcast (same cumulative total) after new output is not a second call', () => {
    const s = feed([
      sessionMeta(),
      start,
      think(2),
      tokenCount(3, 3, 100, 0, 10, 0, 110),
      think(4),
      // Rate-limit update mid-response: the last call's usage again, no new tokens.
      tokenCount(5, 5, 100, 0, 10, 0, 110),
      say(6),
      tokenCount(7, 7, 200, 0, 20, 0, 330),
    ]).snapshot();
    expect(tokens(s)).toEqual([110, 220]);
    expect(s.requests[1]?.blocks.map((b) => b.kind)).toEqual(['thinking', 'text']);
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('the context size rewritten after compaction is not a call', () => {
    const s = feed([
      sessionMeta(),
      start,
      think(2),
      tokenCount(3, 3, 100, 0, 10, 0, 110),
      line('compacted', 4, 4, { message: '' }),
      tokenCount(5, 5, 30, 0, 0, 0, 110),
      think(6),
      tokenCount(7, 7, 40, 0, 5, 0, 155),
    ]).snapshot();
    expect(tokens(s)).toEqual([110, 45]);
  });

  it('a total that restarts lower (resumed process) still counts the new call', () => {
    const s = feed([
      sessionMeta(),
      start,
      think(2),
      tokenCount(3, 3, 100, 0, 10, 0, 5000),
      think(4),
      tokenCount(5, 5, 100, 0, 10, 0, 110),
    ]).snapshot();
    expect(tokens(s)).toEqual([110, 110]);
  });
});

describe('compaction', () => {
  it('the first call after a compaction is marked while it is still running', () => {
    const pass = { internal_chat_message_metadata_passthrough: { turn_id: TURN_1 } };
    const lines = [
      sessionMeta(),
      line('event_msg', 1, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
      line('response_item', 2, 2, {
        type: 'reasoning',
        summary: [],
        encrypted_content: 'x',
        ...pass,
      }),
      usage({ ordinal: 3, sec: 3, responseId: 'resp_1', turnId: TURN_1, input: 900, output: 9 }),
      line('compacted', 4, 4, { message: '' }),
      line('response_item', 5, 5, {
        type: 'reasoning',
        summary: [],
        encrypted_content: 'x',
        ...pass,
      }),
    ];
    const live = feed(lines, [], 'busy').snapshot();
    expect(live.requests.map((r) => [r.status, r.compactedBefore ?? false])).toEqual([
      ['complete', false],
      ['in-flight', true],
    ]);
    const done = feed([
      ...lines,
      usage({ ordinal: 6, sec: 6, responseId: 'resp_2', turnId: TURN_1, input: 90, output: 9 }),
    ]).snapshot();
    expect(done.requests.map((r) => [r.id, r.compactedBefore ?? false])).toEqual([
      ['resp_1', false],
      ['resp_2', true],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { checkSnapshot } from '../../core/invariants.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import {
  at,
  ROOT_ID,
  reasoning,
  SessionBuilder,
  stepFinish,
  stepStart,
  text,
  tokens,
  tool,
} from './__fixtures__/builders.js';
import { feed, makeSource, replayChecked, sessionFile } from './__fixtures__/harness.js';
import { OpenCodeSessionParser } from './parser.js';

/** One finished question and answer, shaped like OpenCode 1.19's first real session. */
function simpleSession() {
  const b = new SessionBuilder();
  const u = b.user(ROOT_ID, 10, text('who are you'));
  const a = b.assistant(ROOT_ID, u, 11, {
    completedSec: 14,
    finish: 'stop',
    tokens: tokens(11435, 51, 49),
  });
  b.part(a, 12, stepStart());
  b.part(a, 12, reasoning('Simple answer.', 12, 13));
  b.part(a, 13, text('I am a coding agent.', 13, 14));
  b.part(a, 14, stepFinish('stop', tokens(11435, 51, 49)));
  return { b, u, a };
}

/** The root starts an `explore` sub-agent with the task tool, then reads a file itself. */
function subagentSession() {
  const b = new SessionBuilder();
  const child = b.session({
    parent_id: ROOT_ID,
    title: 'Find the shears (@explore subagent)',
    agent: 'explore',
    createdSec: 22,
  });
  const u = b.user(ROOT_ID, 20, text('where are the shears?'));
  const a1 = b.assistant(ROOT_ID, u, 21, {
    completedSec: 40,
    finish: 'tool-calls',
    tokens: tokens(900, 30),
  });
  b.part(a1, 21, stepStart());
  const task = b.part(
    a1,
    22,
    tool({
      callId: 'call_task',
      name: 'task',
      status: 'completed',
      input: {
        description: 'Find the shears',
        prompt: 'Look in the shed',
        subagent_type: 'explore',
      },
      output: '<task id="x" state="completed">In the shed</task>',
      startSec: 22,
      endSec: 39,
      childSessionId: child,
    }),
  );
  b.part(a1, 40, stepFinish('tool-calls', tokens(900, 30)));
  const cu = b.user(child, 23, text('Look in the shed'));
  const ca = b.assistant(child, cu, 24, {
    completedSec: 38,
    finish: 'stop',
    tokens: tokens(400, 20, 5, 100),
  });
  b.part(ca, 24, stepStart());
  b.part(
    ca,
    25,
    tool({
      callId: 'call_ls',
      name: 'bash',
      status: 'completed',
      input: { command: 'ls' },
      output: 'shears\n',
      startSec: 25,
      endSec: 26,
    }),
  );
  b.part(ca, 37, text('In the shed', 37, 38));
  b.part(ca, 38, stepFinish('stop', tokens(400, 20, 5, 100)));
  const a2 = b.assistant(ROOT_ID, u, 41, {
    completedSec: 44,
    finish: 'stop',
    tokens: tokens(50, 4, 0, 900),
  });
  b.part(a2, 42, stepStart());
  b.part(a2, 43, text('In the shed.', 43, 44));
  b.part(a2, 44, stepFinish('stop', tokens(50, 4, 0, 900)));
  return { b, child, task, a1, a2, ca };
}

describe('OpenCodeSessionParser: a finished session', () => {
  it('turns a user message into a turn and an assistant message into a request', () => {
    const { b, u, a } = simpleSession();
    const snap = feed(b.doc()).snapshot();

    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.turns).toEqual([
      {
        id: u,
        agentId: MAIN_AGENT_ID,
        index: 1,
        origin: 'human',
        prompt: 'who are you',
        startedAt: at(10),
        endedAt: at(14),
        status: 'complete',
        requestIds: [a],
      },
    ]);
    expect(snap.requests).toEqual([
      {
        id: a,
        agentId: MAIN_AGENT_ID,
        turnId: u,
        index: 1,
        model: 'free-model-1',
        effort: null,
        startedAt: at(11),
        firstBlockAt: at(12),
        endedAt: at(14),
        status: 'complete',
        stopReason: 'stop',
        usage: {
          input: 11435,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 100,
          thinking: 49,
          webSearch: 0,
          webFetch: 0,
        },
        blocks: [
          { kind: 'thinking', text: 'Simple answer.', durationMs: 1000, at: at(12) },
          { kind: 'text', text: 'I am a coding agent.', at: at(13) },
        ],
        toolCallIds: [],
        hasDetail: false,
        error: null,
      },
    ]);
  });

  it('sums the session from its requests and names title, place, model and version', () => {
    const { b } = simpleSession();
    const { session, agents } = feed(b.doc()).snapshot();
    expect(session).toMatchObject({
      id: `opencode:${ROOT_ID}`,
      agent: 'opencode',
      title: 'Garden chores',
      cwd: '/home/user/garden',
      project: 'garden',
      startedAt: at(0),
      updatedAt: at(14),
      version: '1.19.4',
      model: 'free-model-1',
      counts: { turns: 1, requests: 1, toolCalls: 0, agents: 1 },
    });
    expect(session.usage).toMatchObject({ input: 11435, output: 100, thinking: 49 });
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: MAIN_AGENT_ID,
      kind: 'main',
      label: 'Main',
      status: 'complete',
    });
  });

  it('shows no title while OpenCode still has its placeholder', () => {
    const b = new SessionBuilder({ title: 'New session - 2026-10-23T14:53:51.390Z' });
    expect(feed(b.doc()).snapshot().session.title).toBeNull();
  });

  it('lists what OpenCode does not record', () => {
    const { b } = simpleSession();
    expect(feed(b.doc()).snapshot().diagnostics).toEqual({
      unknownRecordTypes: {},
      parseErrors: 0,
      unavailable: ['request-detail', 'live-state-unfinished-reply'],
    });
  });

  it('gives request parameters but no body, and nothing for an unknown request', () => {
    const { b, a } = simpleSession();
    const parser = feed(b.doc());
    expect(parser.requestDetail(a)).toMatchObject({
      completeness: 'unavailable',
      params: { model: 'free-model-1', provider: 'opencode', agent: 'build', variant: null },
      system: null,
      messages: null,
    });
    expect(parser.requestDetail('msg_nope')).toBeNull();
  });
});

describe('OpenCodeSessionParser: tools and sub-agents', () => {
  it('makes a sub-agent of the child session and joins it to the task call that ran it', () => {
    const { b, child, task } = subagentSession();
    const snap = feed(b.doc()).snapshot();

    expect(checkSnapshot(snap)).toEqual([]);
    const sub = snap.agents.find((x) => x.id === child);
    expect(sub).toMatchObject({
      kind: 'subagent',
      parentId: MAIN_AGENT_ID,
      spawnedByToolCallId: task,
      agentType: 'explore',
      label: 'Find the shears',
      status: 'complete',
      startedAt: at(22),
      counts: { turns: 1, requests: 1, toolCalls: 1 },
    });
    expect(snap.toolCalls.find((t) => t.id === task)?.spawned).toEqual({
      kind: 'agent',
      agentId: child,
    });
    expect(snap.turns.find((t) => t.agentId === child)).toMatchObject({
      origin: 'agent-prompt',
      prompt: 'Look in the shed',
    });
  });

  it('counts the sub-agent in the session totals, once', () => {
    const { b, child } = subagentSession();
    const snap = feed(b.doc()).snapshot();
    expect(snap.session.usage).toMatchObject({
      input: 1350,
      output: 59,
      thinking: 5,
      cacheRead: 1000,
    });
    expect(snap.agents.find((x) => x.id === child)?.usage).toMatchObject({
      input: 400,
      output: 25,
    });
    expect(snap.session.counts).toEqual({ turns: 2, requests: 3, toolCalls: 2, agents: 2 });
  });

  it('shows a tool call with its input, timing and result', () => {
    const { b, ca } = subagentSession();
    const parser = feed(b.doc());
    const snap = parser.snapshot();
    const ls = snap.toolCalls.find((t) => t.name === 'bash');
    expect(ls).toMatchObject({
      requestId: ca,
      input: { command: 'ls' },
      status: 'complete',
      startedAt: at(25),
      endedAt: at(26),
      durationMs: 1000,
      resultPreview: 'shears\n',
      hasFullResult: true,
    });
    expect(parser.toolResult(ls?.id ?? '')).toBe('shears\n');
    expect(parser.toolResult('prt_nope')).toBeUndefined();
  });

  it('ends a request when the model stopped writing, not when its tools finished', () => {
    const { b, a1 } = subagentSession();
    const req = feed(b.doc())
      .snapshot()
      .requests.find((r) => r.id === a1);
    // The task call was made at 22 s and ran for 17 s; the next request starts after it.
    expect(req).toMatchObject({ startedAt: at(21), endedAt: at(22), stopReason: 'tool-calls' });
  });

  it('shows a failed tool call as an error with its message', () => {
    const b = new SessionBuilder();
    const u = b.user(ROOT_ID, 1, text('read it'));
    const a = b.assistant(ROOT_ID, u, 2, {
      completedSec: 4,
      finish: 'tool-calls',
      tokens: tokens(10, 2),
    });
    b.part(a, 2, stepStart());
    b.part(
      a,
      3,
      tool({
        callId: 'c1',
        name: 'read',
        status: 'error',
        input: { filePath: 'x' },
        error: 'File not found: x',
        startSec: 3,
        endSec: 3,
      }),
    );
    b.part(a, 4, stepFinish('tool-calls', tokens(10, 2)));
    const call = feed(b.doc()).snapshot().toolCalls[0];
    expect(call).toMatchObject({
      status: 'error',
      resultPreview: 'File not found: x',
      hasFullResult: true,
    });
  });

  it('nests a sub-agent started by another sub-agent under it', () => {
    const { b, child } = subagentSession();
    const grandchild = b.session({
      parent_id: child,
      title: 'Count blades (@general subagent)',
      agent: 'general',
      createdSec: 30,
    });
    const snap = feed(b.doc()).snapshot();
    expect(snap.agents.find((x) => x.id === grandchild)).toMatchObject({
      parentId: child,
      label: 'Count blades',
    });
    expect(checkSnapshot(snap)).toEqual([]);
  });
});

describe('OpenCodeSessionParser: requests that did not finish', () => {
  function running() {
    const b = new SessionBuilder();
    const u = b.user(ROOT_ID, 1, text('build it'));
    const a = b.assistant(ROOT_ID, u, 2, { completedSec: null });
    b.part(a, 2, stepStart());
    b.part(a, 3, reasoning('', 3));
    const call = b.part(
      a,
      4,
      tool({
        callId: 'c1',
        name: 'bash',
        status: 'running',
        input: { command: 'make' },
        startSec: 4,
      }),
    );
    return { b, u, a, call };
  }

  it('shows an assistant message without completion time as in flight while the session runs', () => {
    const { b, a, call } = running();
    const snap = feed(b.doc(), 'busy').snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    const req = snap.requests[0];
    expect(req).toMatchObject({ id: a, status: 'in-flight', usage: null, endedAt: null });
    // The reasoning part is still empty: nothing to show yet.
    expect(req?.blocks.map((x) => x.kind)).toEqual(['tool-use']);
    expect(snap.toolCalls[0]).toMatchObject({ id: call, status: 'running', endedAt: null });
    expect(snap.turns[0]?.status).toBe('running');
    expect(snap.agents[0]?.status).toBe('running');
  });

  it('calls it interrupted once the session is closed, and says what changed', () => {
    const { b, u, a, call } = running();
    const parser = feed(b.doc(), 'busy');
    const changes = parser.setLive('closed');
    expect(changes.requests).toEqual([a]);
    expect(changes.toolCalls).toEqual([call]);
    expect(changes.turns).toEqual([u]);
    const snap = parser.snapshot();
    expect(snap.requests[0]?.status).toBe('interrupted');
    expect(snap.toolCalls[0]?.status).toBe('unknown');
    expect(snap.turns[0]?.status).toBe('interrupted');
    expect(parser.setLive('closed')).toMatchObject({ requests: [], session: false });
  });

  it('calls a call that completed without a finish reason interrupted', () => {
    // OpenCode 1.19 left exactly this when its retries of an unavailable model were cancelled.
    const b = new SessionBuilder();
    const u = b.user(ROOT_ID, 1, text('hi'));
    b.assistant(ROOT_ID, u, 2, { completedSec: 22, tokens: tokens(0, 0) });
    const snap = feed(b.doc()).snapshot();
    expect(snap.requests[0]).toMatchObject({ status: 'interrupted', blocks: [], endedAt: at(22) });
    expect(snap.turns[0]?.status).toBe('interrupted');
  });

  it('shows an API error with its status, and an abort as an interruption without an error', () => {
    const b = new SessionBuilder();
    const u1 = b.user(ROOT_ID, 1, text('one'));
    b.assistant(ROOT_ID, u1, 2, {
      completedSec: 3,
      error: {
        name: 'APIError',
        data: { message: 'Too many requests', statusCode: 429, isRetryable: true },
      },
    });
    const u2 = b.user(ROOT_ID, 4, text('two'));
    b.assistant(ROOT_ID, u2, 5, {
      completedSec: 6,
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    });
    const [first, second] = feed(b.doc()).snapshot().requests;
    expect(first).toMatchObject({
      status: 'error',
      error: { message: 'Too many requests', status: 429, retryAttempt: null },
    });
    expect(second).toMatchObject({ status: 'interrupted', error: null });
  });
});

describe('OpenCodeSessionParser: steps, usage and compaction', () => {
  it('splits a message with several steps into one request per step, each with its usage', () => {
    const b = new SessionBuilder();
    const u = b.user(ROOT_ID, 1, text('go'));
    // An older build: two model calls in one assistant message; the message keeps the last usage.
    const a = b.assistant(ROOT_ID, u, 2, {
      completedSec: 9,
      finish: 'stop',
      tokens: tokens(70, 7),
    });
    b.part(a, 2, stepStart());
    b.part(
      a,
      3,
      tool({
        callId: 'c1',
        name: 'glob',
        status: 'completed',
        output: 'a.ts',
        startSec: 3,
        endSec: 4,
      }),
    );
    b.part(a, 4, stepFinish('tool-calls', tokens(60, 6)));
    b.part(a, 5, stepStart());
    b.part(a, 6, text('found it', 6, 7));
    b.part(a, 8, stepFinish('stop', tokens(70, 7)));
    const snap = feed(b.doc()).snapshot();

    expect(checkSnapshot(snap)).toEqual([]);
    expect(
      snap.requests.map((r) => [r.id, r.index, r.usage?.input, r.stopReason, r.startedAt]),
    ).toEqual([
      [a, 1, 60, 'tool-calls', at(2)],
      [`${a}:2`, 2, 70, 'stop', at(5)],
    ]);
    expect(snap.session.usage?.input).toBe(130);
    expect(snap.turns[0]?.requestIds).toEqual([a, `${a}:2`]);
  });

  it('takes the usage from the message when no step recorded any', () => {
    const b = new SessionBuilder();
    const u = b.user(ROOT_ID, 1, text('go'));
    const a = b.assistant(ROOT_ID, u, 2, {
      completedSec: 3,
      finish: 'stop',
      tokens: tokens(5, 6, 1),
    });
    b.part(a, 2, text('done', 2, 3));
    expect(feed(b.doc()).snapshot().requests[0]?.usage).toMatchObject({
      input: 5,
      output: 7,
      thinking: 1,
    });
  });

  it('marks the first call after a compaction summary', () => {
    const b = new SessionBuilder();
    const u1 = b.user(ROOT_ID, 1, text('long work'));
    b.assistant(ROOT_ID, u1, 2, { finish: 'stop' });
    const u2 = b.user(ROOT_ID, 3, { type: 'compaction', auto: true });
    const summary = b.assistant(ROOT_ID, u2, 4, { finish: 'stop', summary: true });
    const u3 = b.user(ROOT_ID, 6, text('carry on'));
    const next = b.assistant(ROOT_ID, u3, 7, { finish: 'stop' });
    const snap = feed(b.doc()).snapshot();
    expect(snap.requests.filter((r) => r.compactedBefore).map((r) => r.id)).toEqual([next]);
    expect(snap.requests.find((r) => r.id === summary)?.compactedBefore).toBeUndefined();
    expect(snap.turns.find((t) => t.id === u2)?.origin).toBe('other');
  });

  it('names an injected background-task result a task notification', () => {
    const b = new SessionBuilder();
    const u = b.user(ROOT_ID, 1, {
      type: 'text',
      text: '<task id="ses_x" state="completed">ok</task>',
      synthetic: true,
    });
    b.assistant(ROOT_ID, u, 2, { finish: 'stop' });
    expect(feed(b.doc()).snapshot().turns[0]).toMatchObject({ origin: 'task-notification' });
  });

  it('reads the reasoning effort from the message variant', () => {
    const b = new SessionBuilder();
    const u = b.user(ROOT_ID, 1, text('think hard'));
    b.assistant(ROOT_ID, u, 2, { finish: 'stop', variant: 'max' });
    expect(feed(b.doc()).snapshot().requests[0]?.effort).toBe('max');
  });
});

describe('OpenCodeSessionParser: following a live session', () => {
  it('keeps a client that follows patches equal to a fresh snapshot, step by step', () => {
    const b = new SessionBuilder();
    const steps: { doc: unknown }[] = [{ doc: b.doc() }];
    const u = b.user(ROOT_ID, 1, text('go'));
    steps.push({ doc: b.doc() });
    const a = b.assistant(ROOT_ID, u, 2, { completedSec: null });
    steps.push({ doc: b.doc() });
    b.part(a, 2, stepStart());
    const call = b.part(
      a,
      3,
      tool({ callId: 'c', name: 'bash', status: 'running', input: { command: 'ls' }, startSec: 3 }),
    );
    steps.push({ doc: b.doc() });
    const callRow = b.parts.find((p) => p.id === call);
    if (callRow) {
      callRow.data = JSON.stringify(
        tool({
          callId: 'c',
          name: 'bash',
          status: 'completed',
          input: { command: 'ls' },
          output: 'x',
          startSec: 3,
          endSec: 4,
        }),
      );
    }
    b.part(a, 4, stepFinish('tool-calls', tokens(10, 1)));
    steps.push({ doc: b.doc() });
    const msgRow = b.messages.find((m) => m.id === a);
    if (msgRow)
      msgRow.data = msgRow.data.replace(
        '"time":{"created"',
        '"finish":"tool-calls","time":{"completed":1767225605000,"created"',
      );
    steps.push({ doc: b.doc() });

    const { parser, problems } = replayChecked([...steps, { live: 'closed' }]);
    expect(problems).toEqual([]);
    expect(checkSnapshot(parser.snapshot())).toEqual([]);
    expect(parser.snapshot().requests[0]?.status).toBe('complete');
  });

  it('removes what OpenCode deleted on a revert', () => {
    const { b } = simpleSession();
    const before = b.doc();
    const u2 = b.user(ROOT_ID, 20, text('and then?'));
    const a2 = b.assistant(ROOT_ID, u2, 21, { finish: 'stop' });
    const parser = new OpenCodeSessionParser(makeSource());
    parser.ingestJson(sessionFile, b.doc());

    const changes = parser.ingestJson(sessionFile, before);
    expect(changes.removed).toEqual({ turns: [u2], requests: [a2] });
    expect(parser.snapshot().turns).toHaveLength(1);

    const { problems } = replayChecked([{ doc: b.doc() }, { doc: before }]);
    expect(problems).toEqual([]);
  });

  it('reports nothing when the same document comes again', () => {
    const { b } = simpleSession();
    const parser = feed(b.doc());
    const again = parser.ingestJson(sessionFile, b.doc());
    expect(again).toMatchObject({
      session: false,
      agents: [],
      turns: [],
      requests: [],
      toolCalls: [],
    });
    expect(again.removed).toBeUndefined();
  });
});

describe('OpenCodeSessionParser: rows it cannot read', () => {
  it('counts unreadable rows and unknown types, skips them, and keeps going', () => {
    const { b, a } = simpleSession();
    const doc = b.doc();
    doc.parts.push(
      { ...doc.parts[0], id: 'prt_x1', message_id: a, data: '{"type":' } as never,
      {
        ...doc.parts[0],
        id: 'prt_x2',
        message_id: a,
        data: JSON.stringify({ type: 'hologram' }),
      } as never,
      {
        ...doc.parts[0],
        id: 'prt_x3',
        message_id: a,
        data: JSON.stringify({ type: 'snapshot', snapshot: 'b' }),
      } as never,
    );
    doc.messages.push({
      id: 'msg_bad',
      session_id: ROOT_ID,
      time_created: 1,
      time_updated: 1,
      data: '[',
    });
    doc.sessions.push({ nonsense: true } as never);
    const snap = feed(doc).snapshot();
    expect(snap.diagnostics.parseErrors).toBe(3);
    expect(snap.diagnostics.unknownRecordTypes).toEqual({ 'part:hologram': 1 });
    expect(snap.requests).toHaveLength(1);
    expect(checkSnapshot(snap)).toEqual([]);
  });

  it('keeps what it has when a value is not a session document', () => {
    const { b } = simpleSession();
    const parser = feed(b.doc());
    const changes = parser.ingestJson(sessionFile, ['not', 'a', 'document']);
    expect(changes.diagnostics).toBe(true);
    expect(parser.snapshot().requests).toHaveLength(1);
    expect(parser.snapshot().diagnostics.parseErrors).toBe(1);
  });

  it('still has a main agent when the root session row is gone', () => {
    const parser = feed({ sessions: [], messages: [], parts: [] });
    const snap = parser.snapshot();
    expect(snap.agents.map((x) => x.id)).toEqual([MAIN_AGENT_ID]);
    expect(checkSnapshot(snap)).toEqual([]);
  });
});

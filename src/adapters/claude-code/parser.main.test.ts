import { describe, expect, it } from 'vitest';
import { checkSnapshot } from '../../core/invariants.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import {
  aiTitle,
  apiError,
  apiErrorMessage,
  apiRequest,
  assistantBlocks,
  at,
  autoContinuation,
  compactBoundary,
  customTitle,
  interrupt,
  peerMessage,
  rawRecord,
  SESSION_ID,
  taskNotification,
  toolResult,
  turnDuration,
  userPrompt,
} from './__fixtures__/builders.js';
import {
  mainFile,
  makeSource,
  parseMain,
  replayChecked,
  subagentFile,
} from './__fixtures__/harness.js';
import { ClaudeSessionParser } from './parser.js';

describe('turns', () => {
  it('starts a turn per prompt with a 1-based index and the prompt text', () => {
    const s = parseMain(
      userPrompt({ text: 'first', ts: at(1) }),
      userPrompt({ text: 'second', ts: at(2) }),
    ).snapshot();
    expect(s.turns.map((t) => [t.agentId, t.index, t.prompt, t.origin, t.startedAt])).toEqual([
      [MAIN_AGENT_ID, 1, 'first', 'human', at(1)],
      [MAIN_AGENT_ID, 2, 'second', 'human', at(2)],
    ]);
    expect(s.agents.map((a) => a.id)).toEqual([MAIN_AGENT_ID]);
  });

  it('maps origins: task notification, peer (written as meta), missing → human', () => {
    const s = parseMain(
      taskNotification({ taskId: 't1' }),
      peerMessage({ text: 'hi from peer' }),
      userPrompt({ text: 'old version prompt', origin: null }),
      userPrompt({ text: 'typed in glassbox', origin: 'sdk' }),
      userPrompt({ text: 'from something else', origin: 'scheduler' }),
    ).snapshot();
    // stream-json input (glassbox runs) is recorded as turnOrigin "sdk": a person typed it.
    expect(s.turns.map((t) => t.origin)).toEqual([
      'task-notification',
      'peer',
      'human',
      'human',
      'other',
    ]);
    expect(s.turns[1]?.prompt).toBe('hi from peer');
  });

  it('turn prompts are cleaned of command and context wrappers', () => {
    const s = parseMain(
      userPrompt({
        text: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
        origin: null,
      }),
      userPrompt({ text: '<system-reminder>note</system-reminder>\nfix the bug' }),
      userPrompt({ text: '<artifact-view artifact="a1">a chart</artifact-view>' }),
    ).snapshot();
    expect(s.turns.map((t) => t.prompt)).toEqual(['/model opus', 'fix the bug', '[artifact-view]']);
  });

  it('peer turns carry the message body and the sender session name', () => {
    const s = parseMain(
      peerMessage({ text: 'Task 3 is merged.', name: 'glassbox-7a' }),
      peerMessage({ text: 'From an older version', name: 'pm', bareOrigin: true }),
      peerMessage({ text: 'No name', name: null, from: 'uds:/tmp/a.sock', bareOrigin: true }),
    ).snapshot();
    expect(s.turns.map((t) => [t.prompt, t.sender])).toEqual([
      ['Task 3 is merged.', 'glassbox-7a'],
      ['From an older version', 'pm'],
      ['No name', 'uds:/tmp/a.sock'],
    ]);
  });

  it('task notification turns carry the summary and the task id', () => {
    const s = parseMain(
      taskNotification({ taskId: 'task-9', summary: 'Agent "scan" finished' }),
      userPrompt({ text: 'hi' }),
    ).snapshot();
    expect(s.turns.map((t) => [t.prompt, t.sender])).toEqual([
      ['Agent "scan" finished', 'task-9'],
      ['hi', null],
    ]);
  });

  it('does not start turns for meta, compact summaries, tool results, interrupts or echoes', () => {
    const s = parseMain(
      userPrompt({ text: 'real' }),
      userPrompt({ text: 'caveat', isMeta: true, origin: null }),
      userPrompt({ text: 'summary of before', isCompactSummary: true, origin: null }),
      toolResult({ toolUseId: 'toolu_x' }),
      interrupt(),
      userPrompt({ text: '<local-command-stdout>ok</local-command-stdout>', origin: null }),
      userPrompt({
        text: '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>',
        origin: null,
      }),
    ).snapshot();
    expect(s.turns.map((t) => t.prompt)).toEqual(['real']);
  });

  it('reads prompts written as text blocks', () => {
    const s = parseMain(
      userPrompt({
        contentBlocks: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      }),
    ).snapshot();
    expect(s.turns.map((t) => t.prompt)).toEqual(['look at this']);
  });

  it('skips records whose uuid was already seen (resumed history copies)', () => {
    const s = parseMain(
      userPrompt({ text: 'once', uuid: 'dup-1' }),
      userPrompt({ text: 'once', uuid: 'dup-1' }),
    ).snapshot();
    expect(s.turns).toHaveLength(1);
  });
});

describe('requests', () => {
  const prompt = () => userPrompt({ text: 'go', ts: at(0) });

  it('an api-request alone is one in-flight request without usage', () => {
    const s = parseMain(
      prompt(),
      apiRequest({ id: 'api-1', ts: at(1), model: 'claude-opus-5-5', effort: 'max' }),
    ).snapshot();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({
      id: 'api-1',
      agentId: MAIN_AGENT_ID,
      turnId: s.turns[0]?.id,
      index: 1,
      status: 'in-flight',
      usage: null,
      startedAt: at(1),
      model: 'claude-opus-5-5',
      effort: 'max',
      hasDetail: true,
    });
    expect(s.turns[0]?.requestIds).toEqual(['api-1']);
  });

  it('the in-flight request becomes complete with the same id when its records arrive', () => {
    const p = parseMain(prompt(), apiRequest({ id: 'api-1', ts: at(1) }));
    const ch = p.ingestLines(
      mainFile,
      assistantBlocks({
        requestId: 'req_1',
        requestRef: 'api-1',
        blocks: ['thinking', 'text'],
        blockTs: [at(5), at(6)],
        usage: { output: 120, thinking: 80 },
      }),
    );
    expect(ch.requests).toEqual(['api-1']);
    const s = p.snapshot();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({
      id: 'api-1',
      status: 'complete',
      stopReason: 'end_turn',
      firstBlockAt: at(5),
      endedAt: at(6),
      usage: { output: 120, thinking: 80 },
    });
  });

  it('2.1.302 records split across two ingest calls update one request and end with final usage', () => {
    const lines = assistantBlocks({
      requestId: 'req_1',
      requestRef: 'api-1',
      blocks: ['thinking', 'text', 'tool_use'],
      style: '2.1.302',
      usage: { output: 400, input: 7 },
    });
    const p = parseMain(prompt(), apiRequest({ id: 'api-1', ts: at(1) }), lines.slice(0, 2));
    let s = p.snapshot();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ status: 'in-flight', usage: null });
    expect(s.requests[0]?.blocks).toHaveLength(2);

    p.ingestLines(mainFile, lines.slice(2));
    s = p.snapshot();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ status: 'complete', stopReason: 'tool_use' });
    expect(s.requests[0]?.usage).toMatchObject({ output: 400, input: 7 });
    expect(s.requests[0]?.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool-use']);
  });

  it('keeps the usage with the largest output_tokens whatever the arrival order', () => {
    const lines = assistantBlocks({
      requestId: 'req_1',
      blocks: ['thinking', 'text'],
      style: '2.1.302',
      usage: { output: 400 },
    });
    const s = parseMain(prompt(), [...lines].reverse()).snapshot();
    expect(s.requests[0]?.usage?.output).toBe(400);
    expect(s.requests[0]?.blocks.map((b) => b.kind)).toEqual(['thinking', 'text']);
  });

  it('without api-request records the id is requestId, else message.id', () => {
    const noRef = assistantBlocks({ requestId: 'req_7', blocks: ['text'], version: '2.1.246' });
    const noReqId = JSON.parse(
      assistantBlocks({ messageId: 'msg_only', blocks: ['text'] })[0] as string,
    );
    delete noReqId.requestId;
    const s = parseMain(prompt(), noRef, JSON.stringify(noReqId)).snapshot();
    expect(s.requests.map((r) => [r.id, r.hasDetail])).toEqual([
      ['req_7', false],
      ['msg_only', false],
    ]);
  });

  it('numbers requests within their turn', () => {
    const s = parseMain(
      prompt(),
      assistantBlocks({ requestId: 'r1', blocks: ['tool_use'] }),
      assistantBlocks({ requestId: 'r2', blocks: ['text'] }),
      userPrompt({ text: 'again' }),
      assistantBlocks({ requestId: 'r3', blocks: ['text'] }),
    ).snapshot();
    expect(s.requests.map((r) => [r.id, r.index])).toEqual([
      ['r1', 1],
      ['r2', 2],
      ['r3', 1],
    ]);
    expect(s.turns.map((t) => t.requestIds)).toEqual([['r1', 'r2'], ['r3']]);
  });

  it('without api-request a request starts at the record that triggered it', () => {
    const s = parseMain(
      userPrompt({ text: 'go', ts: at(2) }),
      assistantBlocks({
        requestId: 'r1',
        blocks: [{ type: 'tool_use', id: 'toolu_1' }],
        blockTs: [at(5)],
      }),
      toolResult({ toolUseId: 'toolu_1', ts: at(9) }),
      assistantBlocks({ requestId: 'r2', blocks: ['text'], blockTs: [at(15)] }),
      assistantBlocks({
        requestId: 'r3',
        blocks: [{ type: 'thinking', durationMs: 4000 }],
        blockTs: [at(30)],
      }),
    ).snapshot();
    expect(s.requests.map((r) => [r.id, r.startedAt])).toEqual([
      ['r1', at(2)],
      ['r2', at(9)],
      // The previous record is r2's reply at 15 s; 30 s − 4 s thinking = 26 s is later.
      ['r3', at(15)],
    ]);
  });

  it('with an api-request the start time is still the api-request time', () => {
    const s = parseMain(
      userPrompt({ ts: at(2) }),
      apiRequest({ id: 'api-1', ts: at(3) }),
      assistantBlocks({ requestRef: 'api-1', blocks: ['text'], blockTs: [at(5)] }),
    ).snapshot();
    expect(s.requests[0]?.startedAt).toBe(at(3));
  });

  it('builds blocks from each record: empty thinking is null text, with duration', () => {
    const s = parseMain(
      prompt(),
      assistantBlocks({
        requestId: 'r1',
        blocks: [
          { type: 'thinking', thinking: '', durationMs: 4000 },
          { type: 'thinking', thinking: 'a short summary', durationMs: 900 },
          { type: 'text', text: 'Here you go' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } },
        ],
        blockTs: [at(10), at(11), at(12), at(13)],
      }),
    ).snapshot();
    expect(s.requests[0]?.blocks).toEqual([
      { kind: 'thinking', text: null, durationMs: 4000, at: at(10) },
      { kind: 'thinking', text: 'a short summary', durationMs: 900, at: at(11) },
      { kind: 'text', text: 'Here you go', at: at(12) },
      { kind: 'tool-use', toolCallId: 'toolu_1', at: at(13) },
    ]);
    expect(s.requests[0]?.toolCallIds).toEqual(['toolu_1']);
  });

  it('without api-request a thinking request starts at its trigger or first block minus thinking, whichever is earlier', () => {
    const s = parseMain(
      userPrompt({ text: 'go', ts: at(8) }),
      assistantBlocks({
        requestId: 'r1',
        blocks: [{ type: 'thinking', durationMs: 3000 }, 'text'],
        blockTs: [at(10), at(11)],
      }),
    ).snapshot();
    expect(s.requests[0]?.startedAt).toBe(at(7));
  });
});

describe('tool calls', () => {
  const callBash = (id = 'toolu_1', ts = at(10)) =>
    assistantBlocks({
      requestId: `req-${id}`,
      blocks: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }],
      blockTs: [ts],
    });

  it('a tool_use without result is running', () => {
    const s = parseMain(userPrompt(), callBash()).snapshot();
    expect(s.toolCalls).toEqual([
      expect.objectContaining({
        id: 'toolu_1',
        agentId: MAIN_AGENT_ID,
        requestId: 'req-toolu_1',
        name: 'Bash',
        input: { command: 'ls' },
        status: 'running',
        startedAt: at(10),
        endedAt: null,
        resultPreview: null,
        hasFullResult: false,
      }),
    ]);
  });

  it('a tool_result closes the call with end time, duration and preview', () => {
    const p = parseMain(
      userPrompt(),
      callBash(),
      toolResult({ toolUseId: 'toolu_1', content: 'a.txt\nb.txt', ts: at(12.5) }),
    );
    expect(p.snapshot().toolCalls[0]).toMatchObject({
      status: 'complete',
      endedAt: at(12.5),
      durationMs: 2500,
      resultPreview: 'a.txt\nb.txt',
      hasFullResult: true,
    });
  });

  it('is_error marks the call as error', () => {
    const s = parseMain(
      userPrompt(),
      callBash(),
      toolResult({ toolUseId: 'toolu_1', content: 'exit 1', isError: true }),
    ).snapshot();
    expect(s.toolCalls[0]?.status).toBe('error');
  });

  it('previews at most 500 characters of text blocks, and names images', () => {
    const long = 'x'.repeat(800);
    const s = parseMain(
      userPrompt(),
      callBash('toolu_1'),
      callBash('toolu_2'),
      toolResult({ toolUseId: 'toolu_1', content: long }),
      toolResult({
        toolUseId: 'toolu_2',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      }),
    ).snapshot();
    expect(s.toolCalls[0]?.resultPreview).toHaveLength(500);
    expect(s.toolCalls[1]?.resultPreview).toBe('see\n[image]');
  });

  it('toolResult() returns the full content and the structured result', () => {
    const p = parseMain(
      userPrompt(),
      callBash(),
      toolResult({ toolUseId: 'toolu_1', content: 'full text', toolUseResult: { stdout: 'x' } }),
    );
    expect(p.toolResult('toolu_1')).toEqual({
      content: 'full text',
      toolUseResult: { stdout: 'x' },
    });
    expect(p.toolResult('nope')).toBeUndefined();
  });

  it('a result that arrives before its tool_use still closes the call', () => {
    const s = parseMain(
      userPrompt(),
      toolResult({ toolUseId: 'toolu_1', content: 'early', ts: at(11) }),
      callBash('toolu_1', at(10)),
    ).snapshot();
    expect(s.toolCalls[0]).toMatchObject({ status: 'complete', resultPreview: 'early' });
  });

  it('an unanswered call is unknown once the session is closed or the agent moved on', () => {
    const p = parseMain(userPrompt(), callBash('toolu_1'));
    const ch = p.setLive('closed');
    expect(ch.toolCalls).toEqual(['toolu_1']);
    expect(p.snapshot().toolCalls[0]?.status).toBe('unknown');

    const q = parseMain(userPrompt(), callBash('toolu_1'), callBash('toolu_2'));
    expect(q.snapshot().toolCalls.map((t) => t.status)).toEqual(['unknown', 'running']);
  });
});

describe('request status', () => {
  it('a response cut off by an interrupt marker is interrupted, and so is its turn', () => {
    const s = parseMain(
      userPrompt({ ts: at(0) }),
      apiRequest({ id: 'api-1', ts: at(1) }),
      assistantBlocks({ requestRef: 'api-1', blocks: ['thinking'], stopReason: null }),
      interrupt({ ts: at(9) }),
    ).snapshot();
    expect(s.requests[0]?.status).toBe('interrupted');
    expect(s.turns[0]).toMatchObject({ status: 'interrupted', endedAt: at(9) });
  });

  it('an in-flight request becomes interrupted when the session closes', () => {
    const p = parseMain(userPrompt(), apiRequest({ id: 'api-1', ts: at(1) }));
    expect(p.snapshot().requests[0]?.status).toBe('in-flight');
    const ch = p.setLive('closed');
    expect(ch.requests).toContain('api-1');
    const r = p.snapshot().requests[0];
    expect(r).toMatchObject({ status: 'interrupted', usage: null });
  });

  it('a response written without stop_reason is complete once the agent moves on', () => {
    // Sidechain transcripts of 2.1.282–2.1.304 never record stop_reason.
    const s = parseMain(
      userPrompt(),
      assistantBlocks({ requestId: 'r1', blocks: ['thinking', 'text'], stopReason: null }),
      assistantBlocks({ requestId: 'r2', blocks: ['text'] }),
    ).snapshot();
    expect(s.requests.map((r) => [r.status, r.usage !== null])).toEqual([
      ['complete', true],
      ['complete', true],
    ]);
  });

  it('a response without stop_reason whose tools returned is complete', () => {
    const s = parseMain(
      userPrompt(),
      assistantBlocks({
        requestId: 'r1',
        blocks: [{ type: 'tool_use', id: 'toolu_1' }],
        stopReason: null,
      }),
      toolResult({ toolUseId: 'toolu_1' }),
    ).snapshot();
    expect(s.requests[0]?.status).toBe('complete');
  });

  it('a request re-sent before any reply (queued message) is dropped, not interrupted', () => {
    const s = parseMain(
      userPrompt({ ts: at(0) }),
      assistantBlocks({ requestId: 'r0', blocks: ['text'], blockTs: [at(1)] }),
      apiRequest({ id: 'api-abandoned', ts: at(10) }),
      taskNotification({ taskId: 'bg-1', ts: at(9.8) }),
      apiRequest({ id: 'api-resent', ts: at(10.5) }),
      assistantBlocks({ requestRef: 'api-resent', blocks: ['text'], blockTs: [at(12)] }),
    ).snapshot();
    expect(s.requests.map((r) => [r.id, r.status, r.index])).toEqual([
      ['r0', 'complete', 1],
      ['api-resent', 'complete', 1],
    ]);
    expect(s.turns.map((t) => [t.requestIds, t.status])).toEqual([
      [['r0'], 'complete'],
      [['api-resent'], 'complete'],
    ]);
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('only the last unanswered request is in flight, and it is interrupted once closed', () => {
    const p = parseMain(
      userPrompt(),
      apiRequest({ id: 'api-1', ts: at(1) }),
      apiRequest({ id: 'api-2', ts: at(2) }),
    );
    expect(p.snapshot().requests.map((r) => [r.id, r.status])).toEqual([['api-2', 'in-flight']]);
    p.setLive('closed');
    expect(p.snapshot().requests.map((r) => [r.id, r.status])).toEqual([['api-2', 'interrupted']]);
  });

  it('reports the dropped request as removed in the change set and the patch', () => {
    const p = parseMain(userPrompt(), apiRequest({ id: 'api-1', ts: at(1) }));
    const ch = p.ingestLines(mainFile, [apiRequest({ id: 'api-2', ts: at(2) })]);
    expect(ch.removed).toEqual({ requests: ['api-1'] });
    expect(ch.requests).toEqual(['api-2']);
    expect(ch.turns).toEqual([p.snapshot().turns[0]?.id]);
    const patch = p.patch(ch);
    expect(patch.removed).toEqual({ requests: ['api-1'] });
    expect(patch.requests.map((r) => r.id)).toEqual(['api-2']);
    expect(patch.turns[0]?.requestIds).toEqual(['api-2']);
    expect(p.snapshot().diagnostics.unknownRecordTypes).toEqual({ 'superseded-request': 1 });
    expect(p.requestDetail('api-1')).toBeNull();
  });

  it('keeps superseded requests that failed or were interrupted by the user', () => {
    const s = parseMain(
      userPrompt(),
      apiRequest({ id: 'api-1', ts: at(1) }),
      apiError({ ts: at(2) }),
      apiRequest({ id: 'api-2', ts: at(3) }),
      interrupt({ ts: at(4) }),
      userPrompt({ ts: at(5) }),
      apiRequest({ id: 'api-3', ts: at(6) }),
    ).snapshot();
    expect(s.requests.map((r) => [r.id, r.status])).toEqual([
      ['api-1', 'error'],
      ['api-2', 'interrupted'],
      ['api-3', 'in-flight'],
    ]);
  });

  it('api_error with no later response is an error; a later response completes it', () => {
    const p = parseMain(
      userPrompt(),
      apiRequest({ id: 'api-1', ts: at(1) }),
      apiError({ message: 'Overloaded', status: 529, retryAttempt: 3, ts: at(2) }),
    );
    expect(p.snapshot().requests[0]).toMatchObject({
      status: 'error',
      error: { message: 'Overloaded', status: 529, retryAttempt: 3 },
    });
    p.ingestLines(mainFile, assistantBlocks({ requestRef: 'api-1', blocks: ['text'] }));
    expect(p.snapshot().requests[0]).toMatchObject({ status: 'complete', error: null });
  });

  it('a synthetic API error message fails the unanswered request', () => {
    const s = parseMain(
      userPrompt(),
      apiRequest({ id: 'api-1', ts: at(1) }),
      apiErrorMessage({ text: 'API Error: 500 boom', status: 500 }),
    ).snapshot();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({
      status: 'error',
      usage: null,
      error: { message: 'API Error: 500 boom', status: 500 },
    });
  });

  it('without an unanswered request a synthetic API error is its own failed request', () => {
    const s = parseMain(
      userPrompt(),
      apiErrorMessage({ text: 'API Error: rate limited', status: 429, version: '2.1.250' }),
    ).snapshot();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ status: 'error', usage: null, model: null });
  });
});

describe('turn status', () => {
  it('ends with the final end_turn request', () => {
    const s = parseMain(
      userPrompt({ ts: at(0) }),
      assistantBlocks({ requestId: 'r1', blocks: ['tool_use'], blockTs: [at(2)] }),
      assistantBlocks({ requestId: 'r2', blocks: ['text'], blockTs: [at(4)] }),
    ).snapshot();
    expect(s.turns[0]).toMatchObject({ status: 'complete', endedAt: at(4) });
  });

  it('is running while a request is in flight or a tool runs', () => {
    const inFlight = parseMain(userPrompt(), apiRequest({ id: 'api-1' })).snapshot();
    expect(inFlight.turns[0]).toMatchObject({ status: 'running', endedAt: null });
    const tool = parseMain(
      userPrompt(),
      assistantBlocks({ requestId: 'r1', blocks: ['tool_use'] }),
    ).snapshot();
    expect(tool.turns[0]?.status).toBe('running');
  });

  it('a turn_duration record ends the turn', () => {
    const s = parseMain(
      userPrompt({ ts: at(0) }),
      assistantBlocks({ requestId: 'r1', blocks: ['text'], blockTs: [at(3)] }),
      turnDuration({ ts: at(3.5) }),
    ).snapshot();
    expect(s.turns[0]).toMatchObject({ status: 'complete', endedAt: at(3.5) });
  });

  it('a turn whose last request asked for tools is unknown once the session closes', () => {
    const p = parseMain(
      userPrompt(),
      assistantBlocks({ requestId: 'r1', blocks: [{ type: 'tool_use', id: 'toolu_1' }] }),
      toolResult({ toolUseId: 'toolu_1' }),
    );
    expect(p.snapshot().turns[0]?.status).toBe('running');
    p.setLive('closed');
    expect(p.snapshot().turns[0]?.status).toBe('unknown');
  });

  it('a superseded turn is complete; a prompt with no request is complete unless busy', () => {
    const p = parseMain(
      userPrompt({ text: '/model', ts: at(0) }),
      userPrompt({ text: 'hello', ts: at(1) }),
    );
    expect(p.snapshot().turns.map((t) => t.status)).toEqual(['complete', 'complete']);
    p.setLive('busy');
    expect(p.snapshot().turns.map((t) => t.status)).toEqual(['complete', 'running']);
  });

  it('gives the main agent the status and times of its turns', () => {
    const s = parseMain(
      userPrompt({ ts: at(0) }),
      assistantBlocks({ requestId: 'r1', blocks: ['text'], blockTs: [at(4)] }),
    ).snapshot();
    expect(s.agents[0]).toMatchObject({ status: 'complete', startedAt: at(0), endedAt: at(4) });
  });
});

describe('session summary', () => {
  it('title: latest custom title, else latest AI title, else the first human prompt', () => {
    const prompt = userPrompt({ text: `  fix   the\nbuild ${'y'.repeat(100)}` });
    // Whitespace collapsed; 114 characters fit the 160 a title may have.
    expect(parseMain(prompt).snapshot().session.title).toBe(`fix the build ${'y'.repeat(100)}`);
    expect(
      parseMain(prompt, aiTitle({ title: 'AI one' }), aiTitle({ title: 'AI two' })).snapshot()
        .session.title,
    ).toBe('AI two');
    expect(
      parseMain(
        prompt,
        customTitle({ title: 'Mine' }),
        aiTitle({ title: 'AI later' }),
        customTitle({ title: 'Mine again' }),
      ).snapshot().session.title,
    ).toBe('Mine again');
  });

  it('title falls back to the session name, then cleans slash commands and other inputs', () => {
    const command = userPrompt({
      text: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      origin: null,
    });
    expect(
      parseMain(
        command,
        rawRecord('agent-name', { agentName: 'whitefish-7e' }),
        aiTitle({ title: 'AI' }),
      ).snapshot().session.title,
    ).toBe('whitefish-7e');
    expect(parseMain(command).snapshot().session.title).toBe('/model opus');
    expect(parseMain(peerMessage({ text: 'hello from a peer' })).snapshot().session.title).toBe(
      'hello from a peer',
    );
    expect(
      parseMain(customTitle({ title: '' }), aiTitle({ title: '' })).snapshot().session.title,
    ).toBeNull();
  });

  it('titles a session after its first real prompt, not a local slash command before it', () => {
    const command = (name: string, args = '') =>
      userPrompt({
        text: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>`,
        origin: null,
      });
    const stdout = userPrompt({
      text: '<local-command-stdout>Set effort level to high</local-command-stdout>',
      origin: null,
    });
    const reply = (requestId: string) => assistantBlocks({ requestId, blocks: ['text'] });
    expect(
      parseMain(
        command('/effort'),
        stdout,
        userPrompt({ text: 'fix the login test' }),
        reply('r1'),
      ).snapshot().session.title,
    ).toBe('fix the login test');
    // Answered by the model (a skill, a custom command): it names the session.
    expect(
      parseMain(
        command('/review', 'the parser'),
        reply('r2'),
        userPrompt({ text: 'now fix it' }),
      ).snapshot().session.title,
    ).toBe('/review the parser');
    expect(parseMain(command('/login'), stdout).snapshot().session.title).toBe('/login');
    // A message from another session is the first real input.
    expect(
      parseMain(
        command('/effort'),
        stdout,
        peerMessage({ text: 'T2 assignment' }),
        reply('r3'),
      ).snapshot().session.title,
    ).toBe('T2 assignment');
  });

  it('gives a queued prompt the request Claude Code wrote just before it', () => {
    // On disk: the api-request for the peer message comes before the message itself, though
    // the message is older (2.1.309 queues it). The reply names the api-request.
    const p = parseMain(
      userPrompt({ text: '<command-name>/effort</command-name>', origin: null, ts: at(1) }),
      userPrompt({ text: '<local-command-stdout>done</local-command-stdout>', origin: null }),
      apiRequest({ id: 'api-9', ts: at(31) }),
      peerMessage({ text: 'T4 assignment', ts: at(30) }),
      assistantBlocks({ requestRef: 'api-9', blocks: ['text'], ts: at(33) }),
    );
    const turns = p.snapshot().turns.filter((t) => t.agentId === 'main');
    expect(turns.map((t) => [t.prompt, t.requestIds])).toEqual([
      ['/effort', []],
      ['T4 assignment', ['api-9']],
    ]);
    expect(p.snapshot().requests.find((r) => r.id === 'api-9')).toMatchObject({ index: 1 });
    expect(p.snapshot().session.title).toBe('T4 assignment');
  });

  it('starts a turn of its own when work resumes after a usage limit', () => {
    const p = parseMain(
      userPrompt({ text: 'fix the parser', ts: at(0) }),
      apiRequest({ id: 'api-1', ts: at(1) }),
      assistantBlocks({ requestRef: 'api-1', blocks: ['text'], ts: at(2) }),
      turnDuration({ ts: at(3) }),
      autoContinuation({ ts: at(100) }),
      apiRequest({ id: 'api-2', ts: at(101) }),
      assistantBlocks({
        requestRef: 'api-2',
        blocks: [
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/w/a.ts' } },
        ],
        ts: at(103),
      }),
      toolResult({ toolUseId: 'toolu_1', ts: at(104) }),
      apiRequest({ id: 'api-3', ts: at(105) }),
      assistantBlocks({ requestRef: 'api-3', blocks: ['text'], ts: at(106) }),
      turnDuration({ ts: at(107) }),
    );
    const snap = p.snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.turns.map((t) => [t.index, t.origin, t.requestIds, t.status, t.endedAt])).toEqual([
      [1, 'human', ['api-1'], 'complete', at(3)],
      [2, 'auto-continuation', ['api-2', 'api-3'], 'complete', at(107)],
    ]);
    // Its calls and tools count like any turn's; Claude Code's boilerplate is never the title.
    expect(snap.session.counts).toMatchObject({ turns: 2, requests: 3, toolCalls: 1 });
    expect(snap.session.title).toBe('fix the parser');
  });

  it('gives a person’s prompt the request Claude Code wrote just before it', () => {
    const p = parseMain(
      userPrompt({ text: 'first', ts: at(1) }),
      apiRequest({ id: 'api-1', ts: at(2) }),
      assistantBlocks({ requestRef: 'api-1', blocks: ['text'], ts: at(3) }),
      apiRequest({ id: 'api-2', ts: at(21) }),
      userPrompt({ text: 'second', ts: at(20) }),
      assistantBlocks({ requestRef: 'api-2', blocks: ['text'], ts: at(23) }),
    );
    const snap = p.snapshot();
    expect(snap.turns.map((t) => [t.prompt, t.requestIds])).toEqual([
      ['first', ['api-1']],
      ['second', ['api-2']],
    ]);
    // Numbered within its own turn: "Conversation 2 · call #1".
    expect(snap.requests.find((r) => r.id === 'api-2')).toMatchObject({ index: 1 });
  });

  it('keeps an answered request with its turn when the next prompt follows it on disk', () => {
    const p = parseMain(
      userPrompt({ text: 'first', ts: at(1) }),
      apiRequest({ id: 'api-1', ts: at(30) }),
      assistantBlocks({ requestRef: 'api-1', blocks: ['text'], ts: at(31) }),
      userPrompt({ text: 'second', ts: at(20) }),
    );
    // Its reply is already in: it was the first prompt's, whatever the clocks say.
    expect(p.snapshot().turns.map((t) => t.requestIds)).toEqual([['api-1'], []]);
  });

  it('leaves a request sent before a queued prompt with the turn it was sent for', () => {
    const p = parseMain(
      userPrompt({ text: 'first', ts: at(1) }),
      apiRequest({ id: 'api-1', ts: at(2) }),
      peerMessage({ text: 'queued', ts: at(5) }),
    );
    const turns = p.snapshot().turns.filter((t) => t.agentId === 'main');
    expect(turns.map((t) => t.requestIds)).toEqual([['api-1'], []]);
  });

  it('reads cwd, latest version, main model, start and update times', () => {
    const s = parseMain(
      userPrompt({ ts: at(5), cwd: '/work/other', version: '2.1.300' }),
      assistantBlocks({
        requestId: 'r1',
        blocks: ['text'],
        blockTs: [at(9)],
        model: 'claude-sonnet-5-5',
        version: '2.1.308',
      }),
      userPrompt({ ts: at(7) }),
    ).snapshot().session;
    expect(s).toMatchObject({
      id: `claude-code:${SESSION_ID}`,
      cwd: '/work/other',
      version: '2.1.308',
      model: 'claude-sonnet-5-5',
      startedAt: at(5),
      updatedAt: at(9),
    });
  });

  it('sums usage and counts entities', () => {
    const s = parseMain(
      userPrompt(),
      assistantBlocks({
        requestId: 'r1',
        blocks: [{ type: 'tool_use', id: 'toolu_1' }],
        usage: { output: 10, input: 1, cacheRead: 100, cacheWrite1h: 0 },
      }),
      toolResult({ toolUseId: 'toolu_1' }),
      assistantBlocks({
        requestId: 'r2',
        blocks: ['text'],
        usage: { output: 20, input: 2, cacheRead: 200, cacheWrite1h: 0 },
      }),
    ).snapshot().session;
    expect(s.usage).toMatchObject({ output: 30, input: 3, cacheRead: 300 });
    expect(s.counts).toEqual({ turns: 1, requests: 2, toolCalls: 1, agents: 1 });
  });
});

describe('diagnostics', () => {
  it('counts unknown record types and bad lines, not known unused ones', () => {
    const p = parseMain();
    const ch = p.ingestLines(mainFile, [
      rawRecord('mystery'),
      rawRecord('mystery'),
      rawRecord('permission-mode'),
      '{not json',
    ]);
    expect(ch.diagnostics).toBe(true);
    expect(p.snapshot().diagnostics).toEqual({
      unknownRecordTypes: { mystery: 2 },
      parseErrors: 1,
      unavailable: [],
    });
  });

  it('pre-2.1.300 sessions parse fully but lack request detail and in-flight', () => {
    const s = parseMain(
      userPrompt({ version: '2.1.250' }),
      assistantBlocks({ requestId: 'r1', blocks: ['text'], version: '2.1.250' }),
    ).snapshot();
    expect(s.requests[0]).toMatchObject({ status: 'complete', hasDetail: false });
    expect(s.diagnostics.unavailable).toEqual(['request-detail', 'in-flight']);
  });

  it('sessions with api-request records have nothing unavailable', () => {
    const s = parseMain(
      userPrompt(),
      apiRequest({ id: 'api-1' }),
      assistantBlocks({ requestRef: 'api-1', blocks: ['text'] }),
    ).snapshot();
    expect(s.diagnostics.unavailable).toEqual([]);
  });
});

describe('snapshot and patch', () => {
  const threeTurns = () => [
    userPrompt({ text: 'one', ts: at(0) }),
    apiRequest({ id: 'api-1', ts: at(1) }),
    assistantBlocks({
      requestRef: 'api-1',
      requestId: 'req_1',
      blocks: ['thinking', { type: 'tool_use', id: 'toolu_1' }],
      style: '2.1.302',
      blockTs: [at(3), at(4)],
    }),
    toolResult({ toolUseId: 'toolu_1', ts: at(5) }),
    apiRequest({ id: 'api-2', ts: at(6) }),
    assistantBlocks({
      requestRef: 'api-2',
      requestId: 'req_2',
      blocks: ['text'],
      blockTs: [at(8)],
    }),
    turnDuration({ ts: at(8.2) }),
    userPrompt({ text: 'two', ts: at(10) }),
    apiRequest({ id: 'api-3', ts: at(11) }),
    assistantBlocks({ requestRef: 'api-3', blocks: ['thinking'], stopReason: null }),
    interrupt({ ts: at(14) }),
    taskNotification({ taskId: 'bg-1', ts: at(20) }),
    apiRequest({ id: 'api-4', ts: at(21) }),
    apiError({ ts: at(22) }),
    apiRequest({ id: 'api-5', ts: at(25) }),
  ];

  it('a three-turn session passes the core invariants', () => {
    const s = parseMain(...threeTurns()).snapshot();
    expect(s.turns).toHaveLength(3);
    expect(s.requests.map((r) => r.status)).toEqual([
      'complete',
      'complete',
      'interrupted',
      'error',
      'in-flight',
    ]);
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('patch materialises exactly the changed entities', () => {
    const p = parseMain(userPrompt(), apiRequest({ id: 'api-1' }));
    const ch = p.ingestLines(
      mainFile,
      assistantBlocks({ requestRef: 'api-1', blocks: [{ type: 'tool_use', id: 'toolu_1' }] }),
    );
    const patch = p.patch(ch);
    expect(patch.requests.map((r) => [r.id, r.status])).toEqual([['api-1', 'complete']]);
    expect(patch.toolCalls.map((t) => t.id)).toEqual(['toolu_1']);
    expect(patch.agents.map((a) => a.id)).toEqual([MAIN_AGENT_ID]);
    expect(patch.session.usage?.output).toBe(50);
    expect(patch.diagnostics).toBeNull();
  });
});

describe('compaction and probes', () => {
  it('marks the first request after a compact boundary', () => {
    const s = parseMain(
      userPrompt(),
      assistantBlocks({ requestId: 'r1', blocks: ['text'] }),
      compactBoundary(),
      userPrompt({ text: 'summary of earlier work', isCompactSummary: true, origin: null }),
      assistantBlocks({ requestId: 'r2', blocks: ['text'] }),
      assistantBlocks({ requestId: 'r3', blocks: ['text'] }),
    ).snapshot();
    expect(s.requests.map((r) => [r.id, r.compactedBefore ?? false])).toEqual([
      ['r1', false],
      ['r2', true],
      ['r3', false],
    ]);
  });

  it('a compact summary alone also marks the next request', () => {
    const s = parseMain(
      userPrompt({ text: 'summary', isCompactSummary: true, origin: null }),
      apiRequest({ id: 'api-1' }),
    ).snapshot();
    expect(s.requests[0]?.compactedBefore).toBe(true);
  });

  it('tags the session as a probe from its custom title', () => {
    const s = parseMain(userPrompt({ text: '/usage' }), customTitle({ title: 'ClaudeBar Probe' }));
    expect(s.snapshot().session.tags).toEqual(['probe']);
    expect(parseMain(userPrompt()).snapshot().session.tags).toBeUndefined();
  });
});

describe('malformed times', () => {
  it('a thinking block with a bad or missing timestamp does not break the snapshot', () => {
    const [bad] = assistantBlocks({
      requestId: 'r1',
      blocks: [{ type: 'thinking', durationMs: 3000 }],
      blockTs: ['not-a-date'],
    });
    const missing = JSON.parse(
      assistantBlocks({
        requestId: 'r2',
        blocks: [{ type: 'thinking', durationMs: 3000 }],
      })[0] as string,
    );
    delete missing.timestamp;
    const p = parseMain(bad as string, JSON.stringify(missing));
    expect(() => p.snapshot()).not.toThrow();
    // Unparsable times are treated as missing: every exposed time is null or valid ISO.
    const s = p.snapshot();
    const times = [
      s.session.startedAt,
      s.session.updatedAt,
      ...s.requests.flatMap((r) => [r.startedAt, r.endedAt, ...r.blocks.map((b) => b.at)]),
    ];
    for (const t of times) if (t !== null) expect(Number.isNaN(Date.parse(t))).toBe(false);
  });
});

describe('idle sessions', () => {
  const pending = () => [userPrompt({ ts: at(0) }), apiRequest({ id: 'api-1', ts: at(1) })];

  it('a main request with no reply is interrupted once the session goes idle', () => {
    const p = parseMain(...pending());
    p.setLive('busy');
    expect(p.snapshot().requests[0]?.status).toBe('in-flight');
    const ch = p.setLive('idle');
    expect(ch.requests).toContain('api-1');
    const s = p.snapshot();
    expect(s.requests[0]?.status).toBe('interrupted');
    expect(s.turns[0]?.status).toBe('interrupted');
    expect(s.agents[0]?.status).not.toBe('running');
  });

  it('a request that starts after the idle was observed stays in flight (registry lag)', () => {
    const p = parseMain(userPrompt({ ts: at(0) }));
    p.setLive('idle');
    p.ingestLines(mainFile, [apiRequest({ id: 'api-1', ts: at(5) })]);
    expect(p.snapshot().requests[0]?.status).toBe('in-flight');
    p.setLive('busy');
    expect(p.snapshot().requests[0]?.status).toBe('in-flight');
  });

  it('final records that land after the idle complete the request', () => {
    const p = parseMain(...pending());
    p.setLive('busy');
    p.setLive('idle');
    p.ingestLines(
      mainFile,
      assistantBlocks({ requestRef: 'api-1', blocks: ['text'], blockTs: [at(4)] }),
    );
    const s = p.snapshot();
    expect(s.requests[0]?.status).toBe('complete');
    expect(s.turns[0]?.status).toBe('complete');
  });

  it('going busy again restores in-flight (the status is derived, not stored)', () => {
    const p = parseMain(...pending());
    p.setLive('idle');
    expect(p.snapshot().requests[0]?.status).toBe('interrupted');
    p.setLive('busy');
    expect(p.snapshot().requests[0]?.status).toBe('in-flight');
  });

  it('sub-agent and workflow-agent requests keep running while the main agent is idle', () => {
    const p = new ClaudeSessionParser(makeSource());
    p.ingestLines(mainFile, pending());
    p.ingestLines(subagentFile('a1'), [
      userPrompt({ agentId: 'a1', ts: at(2) }),
      apiRequest({ id: 'api-a', agentId: 'a1', ts: at(3) }),
    ]);
    p.setLive('idle');
    const s = p.snapshot();
    expect(s.requests.map((r) => [r.id, r.status])).toEqual([
      ['api-1', 'interrupted'],
      ['api-a', 'in-flight'],
    ]);
  });

  it('patches stay in step through busy → idle → late records', () => {
    const { problems } = replayChecked([
      { live: 'busy' },
      { file: mainFile, lines: pending() },
      { live: 'idle' },
      { file: mainFile, lines: [apiRequest({ id: 'api-2', ts: at(9) })] },
      {
        file: mainFile,
        lines: assistantBlocks({ requestRef: 'api-2', blocks: ['text'], blockTs: [at(10)] }),
      },
      { live: 'busy' },
      { live: 'idle' },
    ]);
    expect(problems).toEqual([]);
  });
});

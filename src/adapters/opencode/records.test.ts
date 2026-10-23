import { describe, expect, it } from 'vitest';
import { ms, ROOT_ID, SessionBuilder, tokens, tool } from './__fixtures__/builders.js';
import {
  asDocument,
  mapTokens,
  parseMessageRow,
  parsePartRow,
  parseSessionRow,
  toIso,
} from './records.js';

const messageRow = (data: unknown) => ({
  id: 'msg_1',
  session_id: ROOT_ID,
  time_created: ms(5),
  time_updated: ms(6),
  data: typeof data === 'string' ? data : JSON.stringify(data),
});

const partRow = (data: unknown) => ({
  id: 'prt_1',
  message_id: 'msg_1',
  session_id: ROOT_ID,
  time_created: ms(7),
  time_updated: ms(7),
  data: typeof data === 'string' ? data : JSON.stringify(data),
});

describe('mapTokens', () => {
  it('counts reasoning as output, as glassbox does; OpenCode keeps them apart', () => {
    expect(mapTokens(tokens(11435, 51, 49, 300, 20))).toEqual({
      input: 11435,
      cacheRead: 300,
      cacheWrite: 20,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 100,
      thinking: 49,
      webSearch: 0,
      webFetch: 0,
    });
  });

  it('reads missing fields as zero and a non-object as nothing', () => {
    expect(mapTokens({ input: 3 })).toMatchObject({ input: 3, output: 0, cacheRead: 0 });
    expect(mapTokens(null)).toBeNull();
    expect(mapTokens([1, 2])).toBeNull();
  });
});

describe('toIso', () => {
  it('reads epoch milliseconds and rejects anything else', () => {
    expect(toIso(ms(1))).toBe('2026-01-01T00:00:01.000Z');
    expect(toIso('2026-01-01')).toBeNull();
    expect(toIso(9e15)).toBeNull();
  });
});

describe('parseSessionRow', () => {
  const base = new SessionBuilder().sessions[0];

  it('reads title, place, agent, version and the model id', () => {
    expect(parseSessionRow(base)).toEqual({
      id: ROOT_ID,
      parentId: null,
      title: 'Garden chores',
      label: 'Garden chores',
      directory: '/home/user/garden',
      version: '1.19.4',
      agent: 'build',
      model: 'free-model-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedMs: ms(0),
    });
  });

  it('treats the placeholder title as no title yet', () => {
    for (const title of [
      'New session - 2026-10-23T14:53:51.390Z',
      'Child session - 2026-10-23T14:53:51.390Z',
    ])
      expect(parseSessionRow({ ...base, title })?.title).toBeNull();
  });

  it('labels a sub-agent session without the "(@agent subagent)" suffix', () => {
    const info = parseSessionRow({
      ...base,
      parent_id: ROOT_ID,
      title: 'Find the shears (@explore subagent)',
    });
    expect(info).toMatchObject({
      title: 'Find the shears (@explore subagent)',
      label: 'Find the shears',
    });
  });

  it('survives a torn model column and rejects a row without an id', () => {
    expect(parseSessionRow({ ...base, model: '{"id":' })?.model).toBeNull();
    expect(parseSessionRow({ ...base, id: '' })).toBeNull();
    expect(parseSessionRow('nope')).toBeNull();
  });
});

describe('parseMessageRow', () => {
  it('reads a user message', () => {
    expect(parseMessageRow(messageRow({ role: 'user', time: { created: ms(4) } }))).toEqual({
      kind: 'user',
      id: 'msg_1',
      sessionId: ROOT_ID,
      createdMs: ms(4),
    });
  });

  it('reads an assistant message: model, variant, finish, tokens and times', () => {
    const rec = parseMessageRow(
      messageRow({
        role: 'assistant',
        parentID: 'msg_0',
        modelID: 'm1',
        providerID: 'opencode',
        agent: 'build',
        variant: 'high',
        finish: 'stop',
        tokens: tokens(10, 5, 2),
        time: { created: ms(5), completed: ms(9) },
      }),
    );
    expect(rec).toMatchObject({
      kind: 'assistant',
      parentId: 'msg_0',
      model: 'm1',
      provider: 'opencode',
      agent: 'build',
      variant: 'high',
      finish: 'stop',
      createdMs: ms(5),
      completedMs: ms(9),
      summary: false,
      error: null,
    });
    expect(rec.kind === 'assistant' && rec.tokens).toMatchObject({
      input: 10,
      output: 7,
      thinking: 2,
    });
  });

  it('calls the "default" variant no effort, and an abort an interruption', () => {
    const rec = parseMessageRow(
      messageRow({
        role: 'assistant',
        variant: 'default',
        time: { created: ms(5) },
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      }),
    );
    expect(rec).toMatchObject({ variant: null, completedMs: null });
    expect(rec.kind === 'assistant' && rec.error).toEqual({
      name: 'MessageAbortedError',
      message: 'Aborted',
      status: null,
      aborted: true,
    });
  });

  it('reads an API error with its HTTP status', () => {
    const rec = parseMessageRow(
      messageRow({
        role: 'assistant',
        time: { created: ms(5), completed: ms(6) },
        error: {
          name: 'APIError',
          data: { message: 'Rate limited', statusCode: 429, isRetryable: true },
        },
      }),
    );
    expect(rec.kind === 'assistant' && rec.error).toMatchObject({
      message: 'Rate limited',
      status: 429,
      aborted: false,
    });
  });

  it('counts an unknown role as an unknown record and bad JSON as invalid', () => {
    expect(parseMessageRow(messageRow({ role: 'system' }))).toEqual({
      kind: 'other',
      type: 'message:system',
      known: false,
    });
    expect(parseMessageRow(messageRow('{"role":'))).toEqual({ kind: 'invalid' });
  });
});

describe('parsePartRow', () => {
  it('reads text, reasoning, step boundaries and their usage', () => {
    expect(
      parsePartRow(partRow({ type: 'text', text: 'hi', synthetic: true, time: { start: ms(1) } })),
    ).toMatchObject({ kind: 'text', text: 'hi', synthetic: true, startMs: ms(1), endMs: null });
    expect(
      parsePartRow(partRow({ type: 'reasoning', text: 'hm', time: { start: 1, end: 3 } })),
    ).toMatchObject({
      kind: 'reasoning',
      startMs: 1,
      endMs: 3,
    });
    expect(parsePartRow(partRow({ type: 'step-start' }))).toMatchObject({ kind: 'step-start' });
    const finish = parsePartRow(
      partRow({ type: 'step-finish', reason: 'tool-calls', tokens: tokens(1, 2) }),
    );
    expect(finish).toMatchObject({ kind: 'step-finish', reason: 'tool-calls' });
    expect(finish.kind === 'step-finish' && finish.tokens?.output).toBe(2);
  });

  it('reads a tool call with its state, timing and the sub-agent session it runs', () => {
    const rec = parsePartRow(
      partRow(
        tool({
          callId: 'call_1',
          name: 'task',
          status: 'completed',
          input: { description: 'Look around' },
          output: 'done',
          startSec: 2,
          endSec: 9,
          childSessionId: 'ses_child',
        }),
      ),
    );
    expect(rec).toMatchObject({
      kind: 'tool',
      id: 'prt_1',
      messageId: 'msg_1',
      callId: 'call_1',
      tool: 'task',
      status: 'completed',
      input: { description: 'Look around' },
      output: 'done',
      error: null,
      startMs: ms(2),
      endMs: ms(9),
      childSessionId: 'ses_child',
    });
  });

  it('shows the raw argument text of a pending call, and the error of a failed one', () => {
    expect(
      parsePartRow(
        // OpenCode's pending state: an empty input next to the raw argument text so far.
        partRow({
          type: 'tool',
          tool: 'read',
          state: { status: 'pending', input: {}, raw: '{"fi' },
        }),
      ),
    ).toMatchObject({ status: 'pending', input: '{"fi' });
    expect(
      parsePartRow(partRow({ type: 'tool', tool: 'ls', state: { status: 'running', input: {} } })),
    ).toMatchObject({ input: {} });
    expect(
      parsePartRow(
        partRow(tool({ callId: 'c', name: 'read', status: 'error', error: 'File not found' })),
      ),
    ).toMatchObject({ status: 'error', error: 'File not found', output: null });
  });

  it('knows the parts it has no view for, and flags the rest', () => {
    for (const type of ['file', 'agent', 'snapshot', 'patch', 'retry'])
      expect(parsePartRow(partRow({ type }))).toMatchObject({ kind: 'other', known: true });
    expect(parsePartRow(partRow({ type: 'hologram' }))).toMatchObject({
      kind: 'other',
      type: 'part:hologram',
      known: false,
    });
    expect(parsePartRow(partRow('not json'))).toMatchObject({ kind: 'invalid', id: 'prt_1' });
  });
});

describe('asDocument', () => {
  it('accepts the three row lists and nothing else', () => {
    expect(asDocument({ sessions: [], messages: [], parts: [] })).not.toBeNull();
    expect(asDocument({ sessions: [], messages: [] })).toBeNull();
    expect(asDocument([])).toBeNull();
  });
});

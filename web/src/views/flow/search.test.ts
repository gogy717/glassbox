import { describe, expect, it } from 'vitest';
import type { ModelRequest, ResponseBlock, ToolCall, Turn } from '../../../../src/core/model.js';
import type { OpenSession } from '../../data/store';
import { demoOpen } from '../../test/demo';
import { searchable, searchSession } from './search';

const AT = '2026-10-23T09:00:00.000Z';

function turn(id: string, index: number, prompt: string, agentId = 'main'): Turn {
  return {
    id,
    agentId,
    index,
    origin: 'human',
    prompt,
    startedAt: `2026-10-23T09:0${index}:00.000Z`,
    endedAt: null,
    status: 'complete',
    requestIds: [],
  };
}

function request(
  id: string,
  turnId: string,
  index: number,
  text: string | null,
  toolCallIds: string[] = [],
  agentId = 'main',
): ModelRequest {
  const blocks: ResponseBlock[] = text === null ? [] : [{ kind: 'text', text, at: AT }];
  for (const toolCallId of toolCallIds) blocks.push({ kind: 'tool-use', toolCallId, at: AT });
  return {
    id,
    agentId,
    turnId,
    index,
    model: 'claude-opus-4-1',
    effort: null,
    startedAt: AT,
    firstBlockAt: AT,
    endedAt: AT,
    status: 'complete',
    stopReason: 'end_turn',
    usage: null,
    blocks,
    toolCallIds,
    hasDetail: false,
    error: null,
  };
}

function tool(
  id: string,
  requestId: string,
  name: string,
  input: unknown,
  resultPreview: string | null,
  agentId = 'main',
): ToolCall {
  return {
    id,
    agentId,
    requestId,
    name,
    input,
    status: 'complete',
    startedAt: AT,
    endedAt: AT,
    durationMs: 1200,
    resultPreview,
    hasFullResult: true,
    spawned: null,
  };
}

/**
 * Two prompts of the main agent and one of a sub-agent: a flaky login test fixed (a call that
 * reads and runs, then a final reply), and an RSS feed added.
 */
function session(): OpenSession {
  const turns = [
    turn('t1', 1, 'Fix the flaky login test'),
    turn('t2', 2, 'Now add an RSS feed'),
    turn('s1', 1, 'Find every login helper', 'sub'),
  ];
  const requests = [
    request('r1', 't1', 1, 'Let me look at the login spec first.', ['tu1']),
    request('r2', 't1', 2, 'The test waited a fixed 5 s.\n\nIt now waits for the button.'),
    request('r3', 't2', 1, null, ['tu2']),
    request('r4', 't2', 2, 'Added feed.xml'),
    request('rs', 's1', 1, null, ['tus'], 'sub'),
  ];
  const tools = [
    tool(
      'tu1',
      'r1',
      'Bash',
      { command: 'npm test -- login.spec.ts', description: 'Run the spec' },
      'FAIL login.spec.ts\n  ✕ signs in (5012 ms)',
    ),
    tool('tu2', 'r3', 'Write', { file_path: 'feed.xml', content: 'rss 2.0' }, 'File created'),
    tool('tus', 'rs', 'Grep', { pattern: 'login' }, 'src/login.ts', 'sub'),
  ];
  return {
    ...demoOpen(),
    turns: new Map(turns.map((t) => [t.id, t])),
    requests: new Map(requests.map((r) => [r.id, r])),
    toolCalls: new Map(tools.map((t) => [t.id, t])),
  };
}

/** What a reader sees of each group: its prompt's id, and each hit as kind, tool and snippet. */
const seen = (open: OpenSession, query: string, agentId = 'main') =>
  searchSession(open, agentId, query).map((g) => ({
    turn: g.turn.id,
    hits: g.hits.map((h) => [h.kind, h.tool, `${h.before}[${h.match}]${h.after}`]),
  }));

describe('searchable', () => {
  it('is two characters or more, once the spaces around them are gone', () => {
    expect(['', '  ', 'l', ' l ', '😀'].map(searchable)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(['lo', ' l o ', '😀😀', '错误'].map(searchable)).toEqual([true, true, true, true]);
  });
});

describe('searchSession', () => {
  it('finds a prompt, a reply, a tool’s input and its result, each typed and in page order', () => {
    expect(seen(session(), 'login')).toEqual([
      {
        turn: 't1',
        hits: [
          ['prompt', null, 'Fix the flaky [login] test'],
          ['reply', null, 'Let me look at the [login] spec first.'],
          ['tool', 'Bash', 'npm test -- [login].spec.ts'],
          ['result', 'Bash', 'FAIL [login].spec.ts ✕ signs in (5012 ms)'],
        ],
      },
    ]);
  });

  it('says where each hit is: the prompt, the call’s response, or the call’s tool card', () => {
    const [group] = searchSession(session(), 'main', 'login');
    expect(group?.hits.map((h) => [h.requestId, h.card])).toEqual([
      [null, null],
      ['r1', 'response'],
      ['r1', 'tool:tu1'],
      ['r1', 'tool:tu1'],
    ]);
  });

  it('groups hits by prompt, in the order of the prompts, leaving out prompts without one', () => {
    expect(seen(session(), 'feed')).toEqual([
      {
        turn: 't2',
        hits: [
          ['prompt', null, 'Now add an RSS [feed]'],
          ['tool', 'Write', '[feed].xml'],
          ['reply', null, 'Added [feed].xml'],
        ],
      },
    ]);
    expect(seen(session(), 'the').map((g) => [g.turn, g.hits.length])).toEqual([['t1', 4]]);
    expect(seen(session(), 'e').length).toBe(0);
    // "waited", then a prompt, an input, a result and a reply of the second prompt.
    expect(seen(session(), 'ed').map((g) => [g.turn, g.hits.length])).toEqual([
      ['t1', 1],
      ['t2', 4],
    ]);
  });

  it('matches an input’s raw JSON where its one-line summary does not', () => {
    expect(seen(session(), '2.0')).toEqual([
      { turn: 't2', hits: [['tool', 'Write', '{"file_path":"feed.xml","content":"rss [2.0]"}']] },
    ]);
    expect(seen(session(), 'run the spec')[0]?.hits).toEqual([
      ['tool', 'Bash', '…m test -- login.spec.ts","description":"[Run the spec]"}'],
    ]);
  });

  it('reads an input’s strings as written: a quote, a line break or a backslash hides nothing', () => {
    const open = session();
    // Its one-line summary is the file's name: the edit's text is in its JSON alone.
    const edit = { old_string: 'import x from "react";\n\tconst a = 1;', file_path: 'a.ts' };
    const write = { file_path: 'x.txt', content: 'C:\\temp\\new' };
    open.toolCalls = new Map(open.toolCalls)
      .set('tu2', tool('tu2', 'r3', 'Edit', edit, 'Edited'))
      .set('tu1', tool('tu1', 'r1', 'Write', write, 'Written'));
    expect(seen(open, 'from "react"')[0]?.hits).toEqual([
      ['tool', 'Edit', '{"old_string":"import x [from "react"]; const a = 1;","file_path":"a.ts"}'],
    ]);
    expect(seen(open, '"react"; const')[0]?.hits).toHaveLength(1);
    // A backslash is a backslash: "\n" in the file's text is not a line break.
    expect(seen(open, 'C:\\temp\\new')[0]?.hits).toEqual([
      ['tool', 'Write', '{"file_path":"x.txt","content":"[C:\\temp\\new]"}'],
    ]);
  });

  it('cuts the context 40 characters either side of the first match, on one line', () => {
    const open = session();
    const long = `${'a'.repeat(50)}\n\nneedle in it\n${'b'.repeat(50)}`;
    open.requests = new Map(open.requests).set('r2', request('r2', 't1', 2, long));
    expect(seen(open, 'needle')[0]?.hits).toEqual([
      ['reply', null, `…${'a'.repeat(39)} [needle] in it ${'b'.repeat(33)}…`],
    ]);
    // By character, so an emoji is never cut in two.
    open.requests = new Map(open.requests).set(
      'r2',
      request('r2', 't1', 2, `${'😀'.repeat(45)}needle${'😀'.repeat(45)}`),
    );
    expect(seen(open, 'needle')[0]?.hits).toEqual([
      ['reply', null, `…${'😀'.repeat(40)}[needle]${'😀'.repeat(40)}…`],
    ]);
  });

  it('ignores case, the spaces around the words and how the text broke its lines', () => {
    expect(seen(session(), '  LOGIN SPEC ')).toEqual([
      { turn: 't1', hits: [['reply', null, 'Let me look at the [login spec] first.']] },
    ]);
    expect(seen(session(), 'fixed 5 s. it now')[0]?.hits).toEqual([
      ['reply', null, 'The test waited a [fixed 5 s. It now] waits for the button.'],
    ]);
  });

  it('searches nothing for a query under two characters', () => {
    const open = session();
    open.turns = new Map(open.turns).set('t2', turn('t2', 2, 'Now add an RSS feed 😀'));
    for (const query of ['', ' ', 'l', ' t ', '😀'])
      expect(searchSession(open, 'main', query)).toEqual([]);
    expect(seen(open, '😀😀')).toEqual([]);
    expect(seen(open, 'd 😀')).toEqual([
      { turn: 't2', hits: [['prompt', null, 'Now add an RSS fee[d 😀]']] },
    ]);
  });

  it('takes the words as written, never as a pattern', () => {
    expect(seen(session(), '(5012 ms)')).toEqual([
      { turn: 't1', hits: [['result', 'Bash', 'FAIL login.spec.ts ✕ signs in [(5012 ms)]']] },
    ]);
    expect(searchSession(session(), 'main', '[unclosed')).toEqual([]);
    expect(searchSession(session(), 'main', 'spec.t.')).toEqual([]);
  });

  it('answers a new query over the same session afresh', () => {
    const open = session();
    expect(seen(open, 'login').map((g) => g.turn)).toEqual(['t1']);
    expect(seen(open, 'feed').map((g) => g.turn)).toEqual(['t2']);
    expect(seen(open, 'login').map((g) => g.turn)).toEqual(['t1']);
  });

  it('finds nothing when nothing matches', () => {
    expect(searchSession(session(), 'main', 'nothing like this')).toEqual([]);
  });

  it('keeps to the agent it is asked about', () => {
    expect(seen(session(), 'helper')).toEqual([]);
    expect(seen(session(), 'login', 'sub')).toEqual([
      {
        turn: 's1',
        hits: [
          ['prompt', null, 'Find every [login] helper'],
          ['tool', 'Grep', '[login]'],
          ['result', 'Grep', 'src/[login].ts'],
        ],
      },
    ]);
  });

  it('finds what changed since the last search, with the same words', () => {
    const open = session();
    expect(searchSession(open, 'main', 'passed')).toEqual([]);
    const tu1 = open.toolCalls.get('tu1') as ToolCall;
    open.toolCalls = new Map(open.toolCalls).set('tu1', { ...tu1, resultPreview: '1 passed' });
    expect(seen(open, 'passed')).toEqual([
      { turn: 't1', hits: [['result', 'Bash', '1 [passed]']] },
    ]);
  });

  it('survives an input nested too deep to serialise', () => {
    let deep: unknown = 'login';
    for (let i = 0; i < 200_000; i++) deep = { deep };
    const open = session();
    open.toolCalls = new Map(open.toolCalls).set(
      'tu2',
      tool('tu2', 'r3', 'Write', deep, 'File created'),
    );
    expect(() => searchSession(open, 'main', 'login')).not.toThrow();
  });
});

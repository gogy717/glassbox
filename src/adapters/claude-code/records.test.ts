import { describe, expect, it } from 'vitest';
import {
  apiError,
  apiRequest,
  assistantBlocks,
  interrupt,
  rawRecord,
  toolResult,
  turnDuration,
  userPrompt,
} from './__fixtures__/builders.js';
import {
  cleanPrompt,
  cleanTurnPrompt,
  mapUsage,
  parseRecord,
  pickTitle,
  shortTitle,
  TITLE_MAX,
} from './records.js';

describe('parseRecord', () => {
  it('returns invalid for lines that are not a JSON object', () => {
    expect(parseRecord('{"type":"user",')).toEqual({ kind: 'invalid' });
    expect(parseRecord('42')).toEqual({ kind: 'invalid' });
    expect(parseRecord('')).toEqual({ kind: 'invalid' });
  });

  it('returns other with the type name for unknown record types', () => {
    expect(parseRecord(rawRecord('brand-new-thing'))).toEqual({
      kind: 'other',
      type: 'brand-new-thing',
      known: false,
    });
  });

  it('marks known-but-unused record types as known', () => {
    expect(parseRecord(rawRecord('permission-mode'))).toMatchObject({ kind: 'other', known: true });
    expect(parseRecord(rawRecord('file-history-snapshot'))).toMatchObject({ known: true });
  });

  it('reads an auto-continuation from turnOrigin alone, as task notifications are', () => {
    const line = JSON.stringify({
      type: 'user',
      isMeta: true,
      turnOrigin: 'auto_continuation',
      message: { role: 'user', content: 'Your claude.ai usage limit has reset.' },
    });
    expect(parseRecord(line)).toMatchObject({ kind: 'user', origin: 'auto-continuation' });
  });

  it('reads agent-name records', () => {
    expect(parseRecord(rawRecord('agent-name', { agentName: 'whitefish-7e' }))).toEqual({
      kind: 'agent-name',
      title: 'whitefish-7e',
    });
  });

  it('never throws on wrong field types', () => {
    const r = parseRecord(JSON.stringify({ type: 'assistant', message: 7, timestamp: {} }));
    expect(r).toMatchObject({ kind: 'assistant', blocks: [], usage: null, ts: null });
  });

  it('reads a human prompt', () => {
    const r = parseRecord(userPrompt({ text: 'hello', uuid: 'u1', ts: '2026-01-01T00:00:00Z' }));
    expect(r).toMatchObject({
      kind: 'user',
      uuid: 'u1',
      ts: '2026-01-01T00:00:00Z',
      text: 'hello',
      origin: 'human',
      isMeta: false,
      toolResults: [],
      interrupt: false,
    });
  });

  it('reads tool results with their structured result', () => {
    const r = parseRecord(
      toolResult({ toolUseId: 'toolu_1', content: 'boom', isError: true, toolUseResult: { a: 1 } }),
    );
    expect(r).toMatchObject({
      kind: 'user',
      toolResults: [{ toolUseId: 'toolu_1', content: 'boom', isError: true }],
      toolUseResult: { a: 1 },
    });
  });

  it('recognises interrupt markers', () => {
    expect(parseRecord(interrupt())).toMatchObject({ kind: 'user', interrupt: true });
    expect(parseRecord(interrupt({ forToolUse: true }))).toMatchObject({ interrupt: true });
  });

  it('reads one assistant block record', () => {
    const [l] = assistantBlocks({
      requestId: 'req_9',
      requestRef: 'api-9',
      blocks: [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: '/x' } }],
      usage: { output: 77 },
    });
    expect(parseRecord(l as string)).toMatchObject({
      kind: 'assistant',
      requestId: 'req_9',
      messageId: 'msg_req_9',
      requestRef: 'api-9',
      apiBlockIndex: 0,
      stopReason: 'tool_use',
      model: 'claude-opus-5-5',
      effort: 'max',
      blocks: [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: '/x' } }],
      usage: { output: 77 },
      outputTokens: 77,
    });
  });

  it('reads an api-request', () => {
    const r = parseRecord(
      apiRequest({ id: 'api-1', base: 'api-0', keep: 3, tail: ['h1'], effort: 'xhigh' }),
    );
    expect(r).toMatchObject({
      kind: 'api-request',
      id: 'api-1',
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      base: 'api-0',
      keep: 3,
      tail: ['h1'],
      shapeHash: 'shape-1',
    });
  });

  it('reads system subtypes', () => {
    expect(parseRecord(turnDuration({ durationMs: 1234 }))).toMatchObject({
      kind: 'system',
      subtype: 'turn_duration',
      durationMs: 1234,
    });
    expect(
      parseRecord(apiError({ message: 'Overloaded', status: 529, retryAttempt: 2 })),
    ).toMatchObject({
      kind: 'system',
      subtype: 'api_error',
      error: { message: 'Overloaded', status: 529, retryAttempt: 2 },
    });
  });
});

describe('mapUsage', () => {
  it('maps every field', () => {
    expect(
      mapUsage({
        input_tokens: 1,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 7,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 },
        output_tokens: 5,
        output_tokens_details: { thinking_tokens: 6 },
        server_tool_use: { web_search_requests: 8, web_fetch_requests: 9 },
      }),
    ).toEqual({
      input: 1,
      cacheRead: 2,
      cacheWrite: 7,
      cacheWrite5m: 3,
      cacheWrite1h: 4,
      output: 5,
      thinking: 6,
      webSearch: 8,
      webFetch: 9,
    });
  });

  it('treats missing fields, including cache_creation, as 0', () => {
    expect(mapUsage({ input_tokens: 1, cache_creation_input_tokens: 5, output_tokens: 2 })).toEqual(
      {
        input: 1,
        cacheRead: 0,
        cacheWrite: 5,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 2,
        thinking: 0,
        webSearch: 0,
        webFetch: 0,
      },
    );
    expect(mapUsage(null).output).toBe(0);
    expect(mapUsage({ output_tokens: 'x' }).output).toBe(0);
  });
});

describe('cleanPrompt', () => {
  it.each([
    [
      '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      '/model opus',
    ],
    ['<command-message>clear</command-message>\n<command-name>/clear</command-name>', '/clear'],
    ['<local-command-stdout>Set model to Opus</local-command-stdout>', null],
    ['<bash-input>ls -la</bash-input>', '!ls -la'],
    ['  fix   the\nbuild  ', 'fix the build'],
    [
      '<cross-session-message from="peer-1" mode="x">Status:\n all green</cross-session-message>',
      'Status: all green',
    ],
    [
      '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent "scan" finished</summary>\n</task-notification>',
      'Agent "scan" finished',
    ],
    ['<system-reminder>internal</system-reminder>', null],
    ['', null],
    ['   ', null],
  ])('%j → %j', (input, expected) => {
    expect(cleanPrompt(input)).toBe(expected);
  });

  it('keeps a title of up to 160 characters whole', () => {
    expect(TITLE_MAX).toBe(160);
    for (const n of [80, 160]) expect(cleanPrompt('y'.repeat(n))).toBe('y'.repeat(n));
  });

  it('cuts a longer title at a word boundary, with an ellipsis', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const title = cleanPrompt(words) ?? '';
    expect([...title].length).toBeLessThanOrEqual(160);
    expect(title).toMatch(/ word\d+…$/);
    expect(words.startsWith(title.slice(0, -1))).toBe(true);
    expect(words[title.length - 1]).toBe(' ');
  });

  it('cuts text with no spaces between characters, with an ellipsis', () => {
    const cjk = '修复登录测试里偶发的超时问题'.repeat(20);
    const title = cleanPrompt(cjk) ?? '';
    expect([...title]).toHaveLength(160);
    expect(title.endsWith('…')).toBe(true);
    expect(cjk.startsWith(title.slice(0, -1))).toBe(true);
    expect(cleanPrompt('y'.repeat(200))).toBe(`${'y'.repeat(159)}…`);
  });

  it('never splits a character: a surrogate pair, an emoji sequence', () => {
    const family = '👨‍👩‍👧';
    for (const s of ['😀'.repeat(200), `${'y'.repeat(157)}${family}${'y'.repeat(9)}`]) {
      const title = shortTitle(s);
      expect([...title].length).toBeLessThanOrEqual(160);
      expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|\u200D…$/);
      expect(s.startsWith(title.slice(0, -1))).toBe(true);
    }
    // The family (five code points) does not fit before the 159th: it is left out whole.
    expect(shortTitle(`${'y'.repeat(157)}${family}${'y'.repeat(9)}`)).toBe(`${'y'.repeat(157)}…`);
  });
});

describe('pickTitle', () => {
  const all = {
    customTitle: 'Custom',
    agentName: 'whitefish-7e',
    aiTitle: 'AI',
    firstHuman: '/model opus',
    firstAny: 'peer text',
  };
  it('prefers custom title, then agent name, AI title, first human, first input of any origin', () => {
    expect(pickTitle(all)).toBe('Custom');
    expect(pickTitle({ ...all, customTitle: '' })).toBe('whitefish-7e');
    expect(pickTitle({ ...all, customTitle: null, agentName: '  ' })).toBe('AI');
    expect(pickTitle({ ...all, customTitle: null, agentName: null, aiTitle: '' })).toBe(
      '/model opus',
    );
    expect(
      pickTitle({
        customTitle: null,
        agentName: null,
        aiTitle: null,
        firstHuman: null,
        firstAny: 'peer text',
      }),
    ).toBe('peer text');
    expect(
      pickTitle({ customTitle: '', agentName: '', aiTitle: '', firstHuman: null, firstAny: null }),
    ).toBeNull();
  });
});

describe('cleanTurnPrompt', () => {
  it.each([
    [
      '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      '/model opus',
    ],
    ['<bash-input>git status</bash-input><bash-stdout>clean</bash-stdout>', '!git status'],
    ['<system-reminder>internal note</system-reminder>\nfix the bug', 'fix the bug'],
    [
      '<fork-boilerplate>You are a fork.</fork-boilerplate>\n\nDo the forked task',
      'Do the forked task',
    ],
    [
      '<artifact-view-context artifact="a1">Viewing a chart</artifact-view-context>\nwhat about this?',
      'what about this?',
    ],
    ['<artifact-view artifact="a1">a chart</artifact-view>', '[artifact-view]'],
    ['<artifact-view artifact="a1" />', '[artifact-view]'],
    ['<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>', '[bash-stdout]'],
    [
      '<pasted_content id="p1">line one\nline two</pasted_content id="p1">\nsummarise this',
      'line one\nline two\nsummarise this',
    ],
    ['first line\n\n  second line  ', 'first line\n\n  second line'],
    ['compare <div> and <span> please', 'compare <div> and <span> please'],
  ])('%j → %j', (input, expected) => {
    expect(cleanTurnPrompt(input)).toBe(expected);
  });
});

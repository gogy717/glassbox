import { describe, expect, it } from 'vitest';
import {
  base64Bytes,
  messageText,
  readMessages,
  readParams,
  readSystem,
  readTools,
  shownRole,
  splitFences,
} from './read';

describe('readMessages', () => {
  it('reads Anthropic Messages, block by block', () => {
    const [user, assistant, results] =
      readMessages([
        { role: 'user', content: 'Fix the bug' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Look first', signature: 'sig' },
            { type: 'redacted_thinking', data: 'xx' },
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'text', text: 'On it.' },
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' }, caller: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'a.ts\nb.ts', is_error: false },
            {
              type: 'tool_result',
              tool_use_id: 'tu_2',
              is_error: true,
              content: [
                { type: 'text', text: 'boom' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                },
                { type: 'tool_reference', tool_name: 'SendMessage' },
              ],
            },
          ],
        },
      ]) ?? [];
    expect(user).toEqual({
      role: 'user',
      time: null,
      blocks: [{ kind: 'text', text: 'Fix the bug' }],
    });
    expect(assistant?.blocks).toEqual([
      { kind: 'thinking', text: 'Look first' },
      { kind: 'thinking', text: null },
      // Claude Code keeps the block but not its text.
      { kind: 'thinking', text: null },
      { kind: 'text', text: 'On it.' },
      { kind: 'tool-use', name: 'Bash', id: 'tu_1', input: { command: 'ls' } },
    ]);
    expect(results?.blocks).toEqual([
      {
        kind: 'tool-result',
        toolUseId: 'tu_1',
        isError: false,
        content: [{ kind: 'text', text: 'a.ts\nb.ts' }],
      },
      {
        kind: 'tool-result',
        toolUseId: 'tu_2',
        isError: true,
        content: [
          { kind: 'text', text: 'boom' },
          { kind: 'media', what: 'image', mediaType: 'image/png', bytes: 3 },
          { kind: 'tool-ref', name: 'SendMessage', added: false },
        ],
      },
    ]);
    // Anthropic sends tool results as the user; shown as the tool speaking.
    expect(results && shownRole(results)).toBe('tool');
    expect(user && shownRole(user)).toBe('user');
  });

  it('reads Claude Code’s system messages and tools added mid-conversation', () => {
    const [sys, added] =
      readMessages([
        { role: 'system', content: [{ type: 'text', text: 'hook context' }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_addition',
              tool: { type: 'tool_definition', definition: { name: 'mcp__docs__batch' } },
            },
          ],
        },
      ]) ?? [];
    expect(sys?.role).toBe('system');
    expect(added?.blocks).toEqual([{ kind: 'tool-ref', name: 'mcp__docs__batch', added: true }]);
  });

  it('reads Grok’s messages: calls by name only, tool results by id only', () => {
    const [user, assistant, tool] =
      readMessages([
        { role: 'user', content: 'list files' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'run_command' }] },
        { role: 'tool', toolCallId: 'call_1' },
      ]) ?? [];
    expect(user?.blocks).toEqual([{ kind: 'text', text: 'list files' }]);
    expect(assistant?.blocks).toEqual([
      { kind: 'tool-use', name: 'run_command', id: 'call_1', input: undefined },
    ]);
    expect(tool?.blocks).toEqual([
      { kind: 'tool-result', toolUseId: 'call_1', content: null, isError: false },
    ]);
  });

  it('reads OpenAI chat and Responses items, arguments parsed from their JSON text', () => {
    const msgs = readMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.ts' },
      {
        type: 'function_call',
        name: 'apply_patch',
        call_id: 'c2',
        arguments: '{"input":"*** Begin"}',
      },
      { type: 'function_call_output', call_id: 'c2', output: 'Done' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan it' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
    ]);
    expect(msgs?.map((m) => [m.role, m.blocks])).toEqual([
      ['assistant', [{ kind: 'tool-use', name: 'shell', id: 'c1', input: { cmd: 'ls' } }]],
      [
        'tool',
        [
          {
            kind: 'tool-result',
            toolUseId: 'c1',
            isError: false,
            content: [{ kind: 'text', text: 'a.ts' }],
          },
        ],
      ],
      [
        'assistant',
        [{ kind: 'tool-use', name: 'apply_patch', id: 'c2', input: { input: '*** Begin' } }],
      ],
      [
        'tool',
        [
          {
            kind: 'tool-result',
            toolUseId: 'c2',
            isError: false,
            content: [{ kind: 'text', text: 'Done' }],
          },
        ],
      ],
      ['assistant', [{ kind: 'thinking', text: 'Plan it' }]],
      ['user', [{ kind: 'text', text: 'go' }]],
    ]);
  });

  it('keeps what it does not know as raw blocks, and a section that is not a list as null', () => {
    const [m, odd, bare] =
      readMessages([{ role: 'user', content: [{ type: 'mystery', x: 1 }] }, 42, { foo: 'bar' }]) ??
      [];
    expect(m?.blocks).toEqual([{ kind: 'raw', type: 'mystery', value: { type: 'mystery', x: 1 } }]);
    expect(odd).toEqual({
      role: '?',
      time: null,
      blocks: [{ kind: 'raw', type: 'number', value: 42 }],
    });
    expect(bare?.blocks[0]).toMatchObject({ kind: 'raw', type: 'object' });
    expect(readMessages({ messages: [] })).toBeNull();
    expect(readMessages('hello')).toBeNull();
  });

  it('keeps a message’s time when the format records one', () => {
    const [m] =
      readMessages([{ role: 'user', content: 'hi', timestamp: '2026-10-24T01:00:00Z' }]) ?? [];
    expect(m?.time).toBe('2026-10-24T01:00:00Z');
  });
});

describe('readSystem', () => {
  it('reads text blocks (Claude Code), a string (Codex, Grok) and a string list (oh-my-pi)', () => {
    expect(
      readSystem([
        { type: 'text', text: 'a', cache_control: {} },
        { type: 'text', text: 'b' },
      ]),
    ).toEqual(['a', 'b']);
    expect(readSystem('You are Codex')).toEqual(['You are Codex']);
    expect(readSystem(['one', 'two'])).toEqual(['one', 'two']);
  });

  it('gives up on anything else, so the JSON is shown', () => {
    expect(readSystem([{ type: 'image' }])).toBeNull();
    expect(readSystem({ text: 'x' })).toBeNull();
  });
});

describe('readTools', () => {
  it('reads Anthropic, OpenAI and bare-name tool lists', () => {
    expect(
      readTools([
        { name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } },
        { type: 'advisor_20260301', name: 'advisor', model: 'm' },
        { type: 'function', function: { name: 'shell', description: 'Run', parameters: { a: 1 } } },
        { type: 'function', name: 'exec', parameters: { b: 2 } },
        'read',
      ]),
    ).toEqual([
      { name: 'Bash', description: 'Run a command', schema: { type: 'object' }, type: null },
      { name: 'advisor', description: null, schema: null, type: 'advisor_20260301' },
      { name: 'shell', description: 'Run', schema: { a: 1 }, type: null },
      { name: 'exec', description: null, schema: { b: 2 }, type: null },
      { name: 'read', description: null, schema: null, type: null },
    ]);
    expect(readTools({ tools: [] })).toBeNull();
  });
});

describe('readParams', () => {
  it('lists an object’s fields; anything else is shown as JSON', () => {
    expect(readParams({ model: 'm', max_tokens: 10 })).toEqual([
      ['model', 'm'],
      ['max_tokens', 10],
    ]);
    expect(readParams(null)).toEqual([]);
    expect(readParams([1])).toBeNull();
  });
});

describe('splitFences', () => {
  it('cuts fenced code out of text, with its language', () => {
    expect(splitFences('Before\n```ts\nconst a = 1;\nconst b = 2;\n```\nAfter')).toEqual([
      { kind: 'prose', text: 'Before', lang: null },
      { kind: 'code', text: 'const a = 1;\nconst b = 2;', lang: 'ts' },
      { kind: 'prose', text: 'After', lang: null },
    ]);
  });

  it('runs an unclosed fence to the end, and leaves text without fences whole', () => {
    expect(splitFences('x\n~~~\nopen')).toEqual([
      { kind: 'prose', text: 'x', lang: null },
      { kind: 'code', text: 'open', lang: null },
    ]);
    expect(splitFences('plain\ntext')).toEqual([
      { kind: 'prose', text: 'plain\ntext', lang: null },
    ]);
  });
});

describe('helpers', () => {
  it('sizes base64 without decoding it', () => {
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(base64Bytes('AA==')).toBe(1);
  });

  it('gives a message as plain text for copying', () => {
    const [m] =
      readMessages([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Run it' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      ]) ?? [];
    expect(m && messageText(m)).toBe('Run it\n\nBash {\n  "command": "ls"\n}');
  });
});

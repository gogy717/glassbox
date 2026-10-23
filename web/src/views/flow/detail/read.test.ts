import { describe, expect, it } from 'vitest';
import { clipSegments } from '../../../lib/fences';
import {
  base64Bytes,
  type Entry,
  isGap,
  type Message,
  messageText,
  readMessages as readEntries,
  readParams,
  readSystem,
  readTools,
  shownRole,
  splitFences,
} from './read';

/** The messages of a list that holds no gaps. */
const readMessages = (v: unknown) => readEntries(v) as Message[] | null;

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

  it('reads the messages Claude Code could not reconstruct as gaps of their size', () => {
    // As src/adapters/claude-code/request-detail.ts writes them: the earlier messages of a
    // request it does not have, then one message whose hash it cannot resolve.
    const entries = readEntries([
      { unresolved: 'base:req_0123', messages: 120 },
      { role: 'user', content: 'next' },
      { unresolved: 'a3f1c9e0' },
      { role: 'assistant', content: 'done' },
    ]) as Entry[];
    expect(entries.map((e) => (isGap(e) ? `gap ${e.gap}` : e.role))).toEqual([
      'gap 120',
      'user',
      'gap 1',
      'assistant',
    ]);
    // Anything odd in the count is one message.
    expect(readEntries([{ unresolved: 'base:x', messages: -3 }])).toEqual([{ gap: 1 }]);
    expect(readEntries([{ unresolved: 'base:x', messages: 'many' }])).toEqual([{ gap: 1 }]);
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
    // Not a list of named tools: shown as JSON instead.
    expect(readTools(['read', 42])).toBeNull();
    expect(readTools([{ description: 'no name' }])).toBeNull();
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

  it('keeps a fence that never closes as text, and text without fences whole', () => {
    expect(splitFences('x\n~~~~~~\nnot code')).toEqual([
      { kind: 'prose', text: 'x\n~~~~~~\nnot code', lang: null },
    ]);
    expect(splitFences('a\n```ts\nconst a = 1;\n```\nb\n```\nopen')).toEqual([
      { kind: 'prose', text: 'a', lang: null },
      { kind: 'code', text: 'const a = 1;', lang: 'ts' },
      { kind: 'prose', text: 'b\n```\nopen', lang: null },
    ]);
    expect(splitFences('plain\ntext')).toEqual([
      { kind: 'prose', text: 'plain\ntext', lang: null },
    ]);
  });

  it('follows CommonMark: no backticks after a backtick fence, closing at least as long', () => {
    expect(splitFences('```js```\nstill text')).toEqual([
      { kind: 'prose', text: '```js```\nstill text', lang: null },
    ]);
    expect(splitFences('````md\n```\ninner\n```\n````')).toEqual([
      { kind: 'code', text: '```\ninner\n```', lang: 'md' },
    ]);
    expect(splitFences('~~~ py extra words\nx = 1\n~~~')).toEqual([
      { kind: 'code', text: 'x = 1', lang: 'py' },
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

describe('fences inside list items', () => {
  const steps = '1. Write it:\n\n   ```python\n   def f():\n       return 1\n   ```\n\n2. Run';

  it('takes the fence’s indentation off its code, keeping the code’s own', () => {
    expect(splitFences(steps)).toEqual([
      { kind: 'prose', text: '1. Write it:\n', lang: null },
      { kind: 'code', text: 'def f():\n    return 1', lang: 'python' },
      { kind: 'prose', text: '\n2. Run', lang: null },
    ]);
  });

  it('leaves indented fences in the text when asked, for a markdown renderer to nest', () => {
    expect(splitFences(steps, 0)).toEqual([{ kind: 'prose', text: steps, lang: null }]);
  });

  it('gives back an unclosed indented fence exactly as written', () => {
    const open = 'Intro\n   ```yaml\n   key:\n     nested: 1';
    expect(splitFences(open)).toEqual([{ kind: 'prose', text: open, lang: null }]);
  });
});

describe('clipSegments', () => {
  const limits = { prose: 100, code: 300, codeClip: 200 };

  it('counts code apart from prose, so a long first block does not hide the prose', () => {
    const code = 'x'.repeat(500);
    const { parts, cut } = clipSegments(`\`\`\`\n${code}\n\`\`\`\nAfter the code.`, limits);
    expect(parts.map((p) => p.kind)).toEqual(['code', 'prose']);
    expect(parts[0]?.text).toBe(code);
    expect(cut).toBe(false);
  });

  it('stops at the code budget, each block counted as much as it shows', () => {
    const block = (c: string) => `\`\`\`\n${c.repeat(500)}\n\`\`\``;
    const { parts, cut } = clipSegments([block('a'), block('b'), block('c')].join('\n'), limits);
    expect(parts.map((p) => p.text[0])).toEqual(['a', 'b']);
    expect(cut).toBe(true);
  });

  it('cuts prose at the last line break before the limit, or keeps a surrogate pair whole', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} of the text`).join('\n');
    const [cutText] = clipSegments(lines, limits).parts;
    expect(cutText?.text.endsWith('of the text')).toBe(true);
    expect(cutText?.text.length).toBeLessThanOrEqual(100);
    const emoji = `${'a'.repeat(99)}😀tail`;
    expect(clipSegments(emoji, limits).parts[0]?.text).toBe('a'.repeat(99));
  });
});

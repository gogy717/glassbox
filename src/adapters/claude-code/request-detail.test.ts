import { describe, expect, it } from 'vitest';
import {
  apiRequest,
  apiRequestBlob,
  apiRequestShape,
  assistantBlocks,
  toolResult,
  userPrompt,
} from './__fixtures__/builders.js';
import { mainFile, parseMain } from './__fixtures__/harness.js';
import { hashMessage, stableStringify } from './request-detail.js';

describe('stableStringify', () => {
  it('is compact JSON with recursively sorted keys', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 'x' }], e: null, u: undefined })).toBe(
      '{"a":[{"c":"x","d":2}],"b":1,"e":null}',
    );
  });

  it('hashes with sha256 over that string', () => {
    // sha256('{"a":1}')
    expect(hashMessage({ a: 1 })).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
  });
});

describe('requestDetail', () => {
  const userMsg = { role: 'user', content: 'Please list the files.' };
  const toolMsg = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }],
  };
  const assistantMsg = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig-fixture' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'ls' },
        caller: { type: 'direct' },
      },
    ],
  };

  const chain = () => [
    apiRequestShape({
      shapeHash: 'shape-1',
      system: [{ type: 'text', text: 'You are a fixture.' }],
      tools: [{ name: 'Bash' }],
    }),
    userPrompt({ text: 'Please list the files.' }),
    apiRequest({ id: 'api-1', keep: 0, tail: [hashMessage(userMsg)] }),
    assistantBlocks({
      requestRef: 'api-1',
      requestId: 'req_1',
      blocks: [
        'thinking',
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ],
      style: '2.1.302',
    }),
    apiRequestBlob({ hash: hashMessage(toolMsg), message: toolMsg }),
    toolResult({ toolUseId: 'toolu_1', content: 'a.txt' }),
    apiRequest({
      id: 'api-2',
      base: 'api-1',
      keep: 1,
      tail: [hashMessage(assistantMsg), hashMessage(toolMsg)],
    }),
    assistantBlocks({ requestRef: 'api-2', requestId: 'req_2', blocks: ['text'] }),
    apiRequest({ id: 'api-3', base: 'api-2', keep: 3, tail: ['f'.repeat(64)] }),
  ];

  it('rebuilds messages from base, keep and resolved tail hashes', () => {
    const p = parseMain(...chain());
    const d1 = p.requestDetail('api-1');
    expect(d1).toEqual({
      requestId: 'api-1',
      completeness: 'full',
      notes: [],
      params: expect.objectContaining({ model: 'claude-opus-5-5' }),
      system: [{ type: 'text', text: 'You are a fixture.' }],
      tools: [{ name: 'Bash' }],
      messages: [userMsg],
    });
    expect(p.requestDetail('api-2')).toMatchObject({
      completeness: 'full',
      messages: [userMsg, assistantMsg, toolMsg],
    });
  });

  it('marks unresolved hashes with a placeholder and partial completeness', () => {
    const d = parseMain(...chain()).requestDetail('api-3');
    expect(d?.completeness).toBe('partial');
    expect(d?.messages).toEqual([userMsg, assistantMsg, toolMsg, { unresolved: 'f'.repeat(64) }]);
    expect(d?.notes).toEqual(['1 message could not be reconstructed from the transcript']);
  });

  it('resolves merged assistant content only once all of its records arrived', () => {
    const lines = chain();
    const p = parseMain(...lines.slice(0, 3));
    // The first of the two assistant records arrives in a separate ingest call.
    const split = lines[3] as string[];
    p.ingestLines(mainFile, split.slice(0, 1));
    p.ingestLines(mainFile, split.slice(1));
    p.ingestLines(mainFile, lines.slice(4).flat());
    expect(p.requestDetail('api-2')?.completeness).toBe('full');
  });

  it('resolves single assistant records and merged runs of user records', () => {
    const single = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] };
    const merged = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_9', content: 'one' },
        { type: 'text', text: 'and also this' },
      ],
    };
    const p = parseMain(
      apiRequestShape(),
      userPrompt({ text: 'go' }),
      assistantBlocks({ requestId: 'r1', blocks: [{ type: 'text', text: 'Done.' }] }),
      toolResult({ toolUseId: 'toolu_9', content: 'one' }),
      userPrompt({ text: 'and also this', origin: null }),
      assistantBlocks({ requestId: 'r2', blocks: ['text'] }),
      apiRequest({ id: 'api-x', tail: [hashMessage(single), hashMessage(merged)] }),
    );
    expect(p.requestDetail('api-x')).toMatchObject({
      completeness: 'full',
      messages: [single, merged],
    });
  });

  it('a missing shape leaves system and tools null and the detail partial', () => {
    const d = parseMain(userPrompt(), apiRequest({ id: 'api-1', shapeHash: 'nope' })).requestDetail(
      'api-1',
    );
    expect(d).toMatchObject({
      completeness: 'partial',
      system: null,
      tools: null,
      messages: [],
      notes: ['The system prompt and tool definitions were not recorded'],
    });
  });

  it('says how many messages could not be reconstructed, and when the base request is missing', () => {
    const p = parseMain(
      apiRequestShape(),
      apiRequest({
        id: 'api-2',
        base: 'api-gone',
        keep: 1,
        tail: ['d'.repeat(64), 'e'.repeat(64)],
      }),
    );
    expect(p.requestDetail('api-2')?.notes).toEqual([
      '2 messages could not be reconstructed from the transcript',
      'The request this one builds on is missing from the transcript, so its first messages could not be reconstructed',
    ]);
  });

  it('requests from versions without api-request records are unavailable', () => {
    const p = parseMain(userPrompt(), assistantBlocks({ requestId: 'r1', blocks: ['text'] }));
    expect(p.requestDetail('r1')).toEqual({
      requestId: 'r1',
      completeness: 'unavailable',
      notes: ['This Claude Code version did not record the request'],
      params: null,
      system: null,
      tools: null,
      messages: null,
    });
    expect(p.requestDetail('nope')).toBeNull();
  });
});

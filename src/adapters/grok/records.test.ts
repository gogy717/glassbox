import { describe, expect, it } from 'vitest';
import { sideUpdate } from './__fixtures__/builders.js';
import {
  mapGrokUsage,
  parseChatLine,
  parseEventLine,
  parseSummary,
  parseToolDefinitions,
  parseUpdateLine,
  parseUsage,
  toIso,
} from './records.js';

const line = (value: unknown) => JSON.stringify(value);

describe('mapGrokUsage', () => {
  it('treats inputTokens as the whole prompt and keeps the uncached slice', () => {
    // totalTokens = inputTokens + outputTokens on disk, and cachedReadTokens never
    // exceeds inputTokens, so cache tokens are already inside inputTokens.
    expect(
      mapGrokUsage({
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
        cachedReadTokens: 800,
        cacheCreationTokens: 10,
        reasoningTokens: 20,
      }),
    ).toEqual({
      input: 190,
      cacheRead: 800,
      cacheWrite: 10,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 50,
      thinking: 20,
      webSearch: 0,
      webFetch: 0,
    });
  });

  it('keeps the raw input when cache fields would drive it negative', () => {
    expect(mapGrokUsage({ inputTokens: 10, cachedReadTokens: 40 })?.input).toBe(10);
  });

  it('returns null when the value is not a usage object', () => {
    expect(mapGrokUsage(null)).toBeNull();
    expect(mapGrokUsage([])).toBeNull();
    expect(mapGrokUsage('nope')).toBeNull();
  });
});

describe('parseUpdateLine', () => {
  it('reads a user prompt chunk', () => {
    const rec = parseUpdateLine(
      line({
        timestamp: 1_796_000_000,
        method: 'session/update',
        params: {
          sessionId: 's',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Plan the garden' },
            _meta: { modelId: 'grok-4.7', promptIndex: 1 },
          },
          _meta: { eventId: 'e1' },
        },
      }),
    );
    expect(rec).toMatchObject({
      kind: 'user-message',
      text: 'Plan the garden',
      promptIndex: 1,
      modelId: 'grok-4.7',
      ts: new Date(1_796_000_000 * 1000).toISOString(),
    });
  });

  it('reads thought and message chunks with the prompt and stream they belong to', () => {
    const base = {
      timestamp: 1_796_000_001_000,
      method: 'session/update',
      params: {
        _meta: { promptId: 'prompt-1', streamStartMs: 1_796_000_000_500 },
      },
    };
    const thought = parseUpdateLine(
      line({
        ...base,
        params: {
          ...base.params,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'beds first' },
          },
        },
      }),
    );
    const message = parseUpdateLine(
      line({
        ...base,
        params: {
          ...base.params,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: [{ type: 'text', text: 'Done.' }],
          },
        },
      }),
    );
    expect(thought).toMatchObject({
      kind: 'thought',
      text: 'beds first',
      promptId: 'prompt-1',
      streamStartMs: 1_796_000_000_500,
    });
    expect(message).toMatchObject({ kind: 'message', text: 'Done.', promptId: 'prompt-1' });
  });

  it('reads a tool call and its completed update', () => {
    const call = parseUpdateLine(
      line({
        timestamp: 1_796_000_000,
        method: 'session/update',
        params: {
          _meta: {
            promptId: 'prompt-1',
            streamStartMs: 100,
            updateParams: { status: 'Pending' },
          },
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'read_file',
            rawInput: { target_file: 'notes.txt' },
            _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read' } },
          },
        },
      }),
    );
    const done = parseUpdateLine(
      line({
        timestamp: 1_796_000_002,
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: 'completed',
            rawOutput: { type: 'text', text: 'mint' },
            content: [{ type: 'content', content: 'mint' }],
          },
        },
      }),
    );
    expect(call).toMatchObject({
      kind: 'tool-call',
      toolCallId: 'call-1',
      name: 'read_file',
      input: { target_file: 'notes.txt' },
      status: 'Pending',
      promptId: 'prompt-1',
      streamStartMs: 100,
    });
    expect(done).toMatchObject({
      kind: 'tool-update',
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { type: 'text', text: 'mint' },
    });
  });

  it('reads turn usage without splitting it across model calls', () => {
    const rec = parseUpdateLine(
      line({
        timestamp: 1_796_000_010,
        method: '_x.ai/session/update',
        params: {
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'prompt-1',
            stop_reason: 'end_turn',
            usage: {
              inputTokens: 500,
              outputTokens: 20,
              cachedReadTokens: 400,
              cacheCreationTokens: 0,
              reasoningTokens: 5,
              modelCalls: 2,
            },
          },
        },
      }),
    );
    expect(rec).toMatchObject({
      kind: 'turn-completed',
      promptId: 'prompt-1',
      stopReason: 'end_turn',
      modelCalls: 2,
      usage: { input: 100, cacheRead: 400, output: 20, thinking: 5 },
    });
  });

  it('marks compaction and ignores known side channels', () => {
    expect(
      parseUpdateLine(
        line({
          timestamp: 1_796_000_000,
          method: '_x.ai/session/update',
          params: { update: { sessionUpdate: 'auto_compact_completed' } },
        }),
      ),
    ).toMatchObject({ kind: 'compaction', phase: 'completed' });
    expect(
      parseUpdateLine(
        line({
          method: '_x.ai/session/update',
          params: { update: { sessionUpdate: 'hook_execution' } },
        }),
      ),
    ).toMatchObject({ kind: 'other', type: 'hook_execution', known: true });
  });

  it('counts an unknown session update and rejects a broken line', () => {
    expect(
      parseUpdateLine(
        line({ method: 'session/update', params: { update: { sessionUpdate: 'widget' } } }),
      ),
    ).toMatchObject({ kind: 'other', type: 'widget', known: false });
    expect(parseUpdateLine('{')).toEqual({ kind: 'invalid' });
    expect(parseUpdateLine('')).toEqual({ kind: 'invalid' });
  });
});

describe('parseEventLine', () => {
  it('reads turn, loop, and tool boundaries', () => {
    expect(
      parseEventLine(
        line({
          ts: '2026-01-01T00:00:00.000Z',
          type: 'turn_started',
          turn_number: 0,
          model_id: 'grok-4.7',
        }),
      ),
    ).toMatchObject({
      kind: 'event',
      type: 'turn_started',
      turnNumber: 0,
      modelId: 'grok-4.7',
      known: true,
    });
    expect(
      parseEventLine(line({ ts: '2026-01-01T00:00:01.000Z', type: 'loop_started', loop_index: 2 })),
    ).toMatchObject({
      kind: 'event',
      type: 'loop_started',
      loopIndex: 2,
      known: true,
    });
    expect(
      parseEventLine(
        line({
          ts: '2026-01-01T00:00:02.000Z',
          type: 'tool_completed',
          tool_call_id: 'call-1',
          duration_ms: 40,
          outcome: 'error',
        }),
      ),
    ).toMatchObject({
      kind: 'event',
      type: 'tool_completed',
      toolCallId: 'call-1',
      durationMs: 40,
      outcome: 'error',
    });
    expect(
      parseEventLine(
        line({ ts: '2026-01-01T00:00:03.000Z', type: 'turn_ended', outcome: 'cancelled' }),
      ),
    ).toMatchObject({ kind: 'event', type: 'turn_ended', outcome: 'cancelled', known: true });
    expect(
      parseEventLine(line({ ts: '2026-01-01T00:00:01.500Z', type: 'first_token' })),
    ).toMatchObject({
      kind: 'event',
      type: 'first_token',
      ts: '2026-01-01T00:00:01.500Z',
      known: true,
    });
  });

  it('treats phase and mcp traces as known noise and unknown types as not', () => {
    expect(
      parseEventLine(
        line({ ts: '2026-01-01T00:00:00.000Z', type: 'phase_changed', phase: 'waiting_for_model' }),
      ),
    ).toMatchObject({
      kind: 'other',
      type: 'phase_changed',
      known: true,
    });
    expect(parseEventLine(line({ type: 'mcp_server_connected' }))).toMatchObject({
      kind: 'other',
      known: true,
    });
    expect(parseEventLine(line({ type: 'snack_time' }))).toMatchObject({
      kind: 'other',
      type: 'snack_time',
      known: false,
    });
    expect(parseEventLine('not json')).toEqual({ kind: 'invalid' });
  });
});

describe('parseChatLine', () => {
  it('keeps system text, human prompts, and synthetic reminders apart', () => {
    expect(parseChatLine(line({ type: 'system', content: 'You are a gardener.' }))).toMatchObject({
      kind: 'system',
      text: 'You are a gardener.',
    });
    expect(
      parseChatLine(
        line({ type: 'user', content: [{ type: 'text', text: 'hi' }], prompt_index: 0 }),
      ),
    ).toMatchObject({ kind: 'user', text: 'hi', promptIndex: 0, synthetic: null });
    expect(
      parseChatLine(
        line({
          type: 'user',
          content: [{ type: 'text', text: 'remember' }],
          synthetic_reason: 'system_reminder',
        }),
      ),
    ).toMatchObject({ kind: 'user', synthetic: 'system_reminder', text: 'remember' });
  });

  it('uses reasoning summary text and parses tool-call arguments', () => {
    const reasoning = parseChatLine(
      line({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'check the soil' }],
        encrypted_content: 'secret-blob',
        status: 'completed',
      }),
    );
    expect(reasoning).toMatchObject({ kind: 'reasoning', text: 'check the soil' });
    expect(JSON.stringify(reasoning)).not.toContain('secret-blob');
    expect(
      parseChatLine(
        line({
          type: 'assistant',
          content: 'Listing.',
          model_id: 'grok-4.7-build',
          reasoning_effort: 'xhigh',
          tool_calls: [{ id: 'call-1', name: 'list_dir', arguments: '{"path":"."}' }],
        }),
      ),
    ).toMatchObject({
      kind: 'assistant',
      text: 'Listing.',
      modelId: 'grok-4.7-build',
      effort: 'xhigh',
      toolCalls: [{ id: 'call-1', name: 'list_dir', input: { path: '.' } }],
    });
    expect(
      parseChatLine(line({ type: 'tool_result', tool_call_id: 'call-1', content: 'notes.txt' })),
    ).toMatchObject({
      kind: 'tool-result',
      toolCallId: 'call-1',
      content: 'notes.txt',
    });
  });
});

describe('parseSummary and parseUsage', () => {
  it('prefers a generated title and ignores a blank summary', () => {
    expect(
      parseSummary({
        info: { id: 'sid', cwd: '/work/garden' },
        generated_title: 'Garden plan',
        session_summary: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:05:00.000Z',
        current_model_id: 'grok-4.7',
        reasoning_effort: 'xhigh',
      }),
    ).toMatchObject({
      id: 'sid',
      cwd: '/work/garden',
      title: 'Garden plan',
      model: 'grok-4.7',
      effort: 'xhigh',
    });
    expect(parseSummary({ info: { id: 'sid' }, session_summary: '   ' }).title).toBeNull();
    expect(parseSummary({ session_summary: 'Fallback title' }).title).toBe('Fallback title');
  });

  it('reads one usage row per finished user turn', () => {
    const usage = parseUsage({
      session: {
        inputTokens: 10,
        outputTokens: 1,
        cachedReadTokens: 0,
        reasoningTokens: 0,
        modelCalls: 1,
      },
      turns: [
        {
          turnNumber: 2,
          endedAt: '2026-01-01T00:01:00.000Z',
          inputTokens: 10,
          outputTokens: 1,
          cachedReadTokens: 4,
          cacheCreationTokens: 0,
          reasoningTokens: 1,
          modelCalls: 3,
          primaryModelId: 'grok-4.7-build',
        },
      ],
    });
    expect(usage.turns).toEqual([
      {
        turnNumber: 2,
        endedAt: '2026-01-01T00:01:00.000Z',
        modelCalls: 3,
        model: 'grok-4.7-build',
        usage: {
          input: 6,
          cacheRead: 4,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 1,
          thinking: 1,
          webSearch: 0,
          webFetch: 0,
        },
      },
    ]);
  });

  it('reads an OpenAI-style tool definition list and ignores anything else', () => {
    expect(parseToolDefinitions([{ type: 'function', function: { name: 'list_dir' } }])).toEqual([
      { type: 'function', function: { name: 'list_dir' } },
    ]);
    expect(parseToolDefinitions({ tools: [] })).toBeNull();
    expect(parseSummary(null).id).toBeNull();
    expect(parseUsage(null).turns).toEqual([]);
  });
});

describe('toIso', () => {
  it('reads unix seconds, unix milliseconds and ISO strings', () => {
    expect(toIso(1_767_225_600)).toBe('2026-01-01T00:00:00.000Z');
    expect(toIso(1_767_225_600_500)).toBe('2026-01-01T00:00:00.500Z');
    expect(toIso('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null for anything that is not a representable time, never throws', () => {
    for (const v of [1e300, 8.7e15, -1e300, Number.NaN, 'not a date', '', null, {}, 42])
      expect(toIso(v)).toBeNull();
  });
});

describe('known but unmodelled updates', () => {
  it('ACP plan updates are known, not counted as unknown', () => {
    expect(parseUpdateLine(sideUpdate('plan'))).toEqual({
      kind: 'other',
      type: 'plan',
      known: true,
    });
  });
});

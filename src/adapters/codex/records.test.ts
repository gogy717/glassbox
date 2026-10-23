import { describe, expect, it } from 'vitest';
import { mapCodexUsage, parseRolloutLine, toIso } from './records.js';

describe('mapCodexUsage', () => {
  it('splits cached input out of input_tokens and keeps reasoning inside output', () => {
    // input_tokens includes cached_input_tokens.
    expect(
      mapCodexUsage({
        input_tokens: 100,
        cached_input_tokens: 40,
        cache_write_input_tokens: 0,
        output_tokens: 10,
        reasoning_output_tokens: 4,
        total_tokens: 110,
      }),
    ).toEqual({
      input: 60,
      cacheRead: 40,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 10,
      thinking: 4,
      webSearch: 0,
      webFetch: 0,
    });
  });

  it('keeps a raw input total when cached input is larger than input', () => {
    expect(mapCodexUsage({ input_tokens: 3, cached_input_tokens: 9 })?.input).toBe(3);
  });

  it('returns null when the object has no usage numbers', () => {
    expect(mapCodexUsage(null)).toBeNull();
    expect(mapCodexUsage({})).toBeNull();
    expect(mapCodexUsage({ total_tokens: 10 })).toBeNull();
  });
});

describe('parseRolloutLine', () => {
  it('reads a session header without keeping the encrypted or instruction blobs as model text', () => {
    const rec = parseRolloutLine(
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        ordinal: 0,
        type: 'session_meta',
        payload: {
          id: '11111111-1111-4111-8111-111111111111',
          session_id: '11111111-1111-4111-8111-111111111111',
          timestamp: '2026-01-01T00:00:01.000Z',
          cwd: '/work/garden',
          cli_version: '0.153.4',
          parent_thread_id: 'parent-thread',
          base_instructions: { text: 'system prompt', provenance: 'built-in' },
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'parent-thread',
                agent_path: 'explore',
                agent_nickname: 'Scout',
                agent_role: null,
                depth: 1,
              },
            },
          },
        },
      }),
    );
    expect(rec).toMatchObject({
      kind: 'session-meta',
      id: '11111111-1111-4111-8111-111111111111',
      cwd: '/work/garden',
      version: '0.153.4',
      parentThreadId: 'parent-thread',
      agentType: 'explore',
      label: 'Scout',
      system: 'system prompt',
      startedAt: '2026-01-01T00:00:01.000Z',
    });
  });

  it('names a guardian child from source.subagent.other', () => {
    const rec = parseRolloutLine(
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        ordinal: 0,
        type: 'session_meta',
        payload: {
          id: '22222222-2222-4222-8222-222222222222',
          cwd: '/work/garden',
          source: { subagent: { other: 'guardian' } },
        },
      }),
    );
    expect(rec).toMatchObject({ kind: 'session-meta', agentType: 'guardian', label: 'guardian' });
  });

  it('maps a per-response usage record and ignores cumulative totals', () => {
    const rec = parseRolloutLine(
      JSON.stringify({
        timestamp: '2026-01-01T00:00:05.000Z',
        ordinal: 9,
        type: 'token_usage_record',
        payload: {
          response_id: 'resp_test',
          turn_id: 'turn-1',
          usage: {
            input_tokens: 10,
            cached_input_tokens: 4,
            output_tokens: 3,
            reasoning_output_tokens: 1,
          },
          turn_token_usage: { input_tokens: 999, output_tokens: 999 },
          thread_token_usage: { input_tokens: 999, output_tokens: 999 },
        },
      }),
    );
    expect(rec).toMatchObject({
      kind: 'usage',
      responseId: 'resp_test',
      turnId: 'turn-1',
      ordinal: 9,
      usage: { input: 6, cacheRead: 4, output: 3, thinking: 1 },
    });
  });

  it('uses the reasoning summary and drops encrypted_content', () => {
    const withSummary = parseRolloutLine(
      JSON.stringify({
        timestamp: '2026-01-01T00:00:02.000Z',
        ordinal: 3,
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'check the beds' }],
          encrypted_content: 'do-not-keep',
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
        },
      }),
    );
    const encryptedOnly = parseRolloutLine(
      JSON.stringify({
        timestamp: '2026-01-01T00:00:03.000Z',
        ordinal: 4,
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [],
          encrypted_content: 'do-not-keep',
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
        },
      }),
    );
    expect(withSummary).toMatchObject({
      kind: 'reasoning',
      text: 'check the beds',
      turnId: 'turn-1',
    });
    expect(encryptedOnly).toMatchObject({ kind: 'reasoning', text: null });
    expect(JSON.stringify(encryptedOnly)).not.toContain('do-not-keep');
  });

  it('counts an unknown record type and a bad line', () => {
    expect(parseRolloutLine('not-json')).toEqual({ kind: 'invalid' });
    expect(parseRolloutLine('')).toEqual({ kind: 'invalid' });
    expect(parseRolloutLine(JSON.stringify({ type: 'snack_time', payload: {} }))).toMatchObject({
      kind: 'unknown',
      type: 'snack_time',
    });
    expect(
      parseRolloutLine(
        JSON.stringify({ type: 'response_item', payload: { type: 'mystery_item' }, ordinal: 1 }),
      ),
    ).toMatchObject({ kind: 'unknown', type: 'response_item:mystery_item' });
  });

  it('reads turn boundaries, call settings, and a token_count fallback', () => {
    expect(
      parseRolloutLine(
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.500Z',
          ordinal: 2,
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-1',
            started_at: 1767225600,
            turn_attribution: { turn_trigger: 'composer' },
          },
        }),
      ),
    ).toMatchObject({
      kind: 'task-started',
      turnId: 'turn-1',
      trigger: 'composer',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(
      parseRolloutLine(
        JSON.stringify({
          timestamp: '2026-01-01T00:00:09.000Z',
          ordinal: 12,
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            completed_at: 1767225610,
            error: { message: 'rate limited', codex_error_info: 'usage_limit' },
          },
        }),
      ),
    ).toMatchObject({
      kind: 'task-complete',
      turnId: 'turn-1',
      errorMessage: 'rate limited',
    });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'event_msg',
          ordinal: 4,
          payload: { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' },
        }),
      ),
    ).toMatchObject({ kind: 'turn-aborted', turnId: 'turn-1' });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'turn_context',
          ordinal: 3,
          payload: { turn_id: 'turn-1', model: 'gpt-5.6-sol', effort: 'high' },
        }),
      ),
    ).toMatchObject({ kind: 'turn-context', model: 'gpt-5.6-sol', effort: 'high' });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'event_msg',
          ordinal: 8,
          timestamp: '2026-01-01T00:00:08.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 8,
                cached_input_tokens: 2,
                output_tokens: 1,
                reasoning_output_tokens: 1,
              },
              total_token_usage: { input_tokens: 800, output_tokens: 80 },
            },
          },
        }),
      ),
    ).toMatchObject({
      kind: 'token-count',
      ordinal: 8,
      usage: { input: 6, cacheRead: 2, output: 1, thinking: 1 },
    });
  });

  it('separates user text, assistant text, and tool calls from their outputs', () => {
    expect(
      parseRolloutLine(
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02.000Z',
          ordinal: 5,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Draw a bed' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
          },
        }),
      ),
    ).toMatchObject({ kind: 'user-text', text: 'Draw a bed', turnId: 'turn-1' });
    expect(
      parseRolloutLine(
        JSON.stringify({
          timestamp: '2026-01-01T00:00:04.000Z',
          ordinal: 6,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'Mint along the path.' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
          },
        }),
      ),
    ).toMatchObject({ kind: 'assistant-text', text: 'Mint along the path.' });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'response_item',
          ordinal: 7,
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'injected' }],
          },
        }),
      ),
    ).toMatchObject({ kind: 'developer-text' });
    expect(
      parseRolloutLine(
        JSON.stringify({
          timestamp: '2026-01-01T00:00:05.000Z',
          ordinal: 8,
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'call_exec',
            input: 'ls beds',
            status: 'completed',
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
          },
        }),
      ),
    ).toMatchObject({ kind: 'tool-call', callId: 'call_exec', name: 'exec', input: 'ls beds' });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'response_item',
          ordinal: 9,
          payload: {
            type: 'function_call',
            name: 'spawn_agent',
            namespace: 'collaboration',
            call_id: 'call_spawn',
            arguments: JSON.stringify({ task_name: 'scout' }),
          },
        }),
      ),
    ).toMatchObject({
      kind: 'tool-call',
      callId: 'call_spawn',
      name: 'spawn_agent',
      input: { task_name: 'scout' },
    });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'response_item',
          ordinal: 12,
          payload: {
            type: 'web_search_call',
            id: 'ws_call_1',
            status: 'completed',
            action: { type: 'search', query: 'thyme', queries: ['thyme'] },
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
          },
        }),
      ),
    ).toMatchObject({
      kind: 'tool-call',
      callId: 'ws_call_1',
      name: 'web_search',
      turnId: 'turn-1',
      input: { type: 'search', query: 'thyme', queries: ['thyme'] },
      status: 'completed',
    });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'response_item',
          ordinal: 10,
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'call_exec',
            output: [{ type: 'output_text', text: 'herb.txt' }],
          },
        }),
      ),
    ).toMatchObject({ kind: 'tool-output', callId: 'call_exec' });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'response_item',
          ordinal: 11,
          payload: {
            type: 'agent_message',
            content: [{ type: 'output_text', text: 'asking the scout' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
          },
        }),
      ),
    ).toMatchObject({ kind: 'agent-message', text: 'asking the scout', turnId: 'turn-1' });
  });

  it('reads item timing, a user message, and a sub-agent spawn link', () => {
    expect(
      parseRolloutLine(
        JSON.stringify({
          timestamp: '2026-01-01T00:00:06.000Z',
          ordinal: 11,
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            started_at_ms: 1_767_225_600_000,
            completed_at_ms: 1_767_225_600_040,
            item: {
              type: 'CommandExecution',
              id: 'exec-1',
              status: 'failed',
              exit_code: 1,
              aggregated_output: 'missing',
              duration: { secs: 0, nanos: 40_000_000 },
            },
          },
        }),
      ),
    ).toMatchObject({
      kind: 'item',
      itemType: 'CommandExecution',
      itemId: 'exec-1',
      status: 'failed',
      durationMs: 40,
      outputText: 'missing',
      known: true,
    });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'event_msg',
          ordinal: 2,
          payload: {
            type: 'item_completed',
            item: {
              type: 'UserMessage',
              id: 'um-1',
              content: [{ type: 'text', text: 'Draw a bed' }],
            },
          },
        }),
      ),
    ).toMatchObject({ kind: 'item', itemType: 'UserMessage', text: 'Draw a bed', known: true });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'event_msg',
          ordinal: 14,
          payload: {
            type: 'item_completed',
            item: {
              type: 'SubAgentActivity',
              id: 'call_spawn',
              kind: 'started',
              agent_thread_id: '22222222-2222-4222-8222-222222222222',
              agent_path: 'explore',
            },
          },
        }),
      ),
    ).toMatchObject({
      kind: 'item',
      itemType: 'SubAgentActivity',
      itemId: 'call_spawn',
      activityKind: 'started',
      agentThreadId: '22222222-2222-4222-8222-222222222222',
      agentPath: 'explore',
    });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'event_msg',
          ordinal: 15,
          payload: { type: 'item_completed', item: { type: 'WeirdItem', id: 'x' } },
        }),
      ),
    ).toMatchObject({ kind: 'item', itemType: 'WeirdItem', known: false });
  });

  it('keeps tool lists and compaction, and skips records that have no model entity', () => {
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'world_state',
          ordinal: 1,
          payload: { state: { top_level_tools: [{ name: 'exec' }], tools: [{ name: 'other' }] } },
        }),
      ),
    ).toMatchObject({ kind: 'tools', tools: [{ name: 'exec' }] });
    expect(
      parseRolloutLine(
        JSON.stringify({
          type: 'world_state',
          ordinal: 2,
          payload: { state: { tools: [{ name: 'exec' }] } },
        }),
      ),
    ).toMatchObject({ kind: 'tools', tools: [{ name: 'exec' }] });
    expect(
      parseRolloutLine(
        JSON.stringify({ type: 'compacted', ordinal: 20, payload: { replacement_history: [] } }),
      ),
    ).toMatchObject({
      kind: 'compacted',
      ordinal: 20,
    });
    expect(
      parseRolloutLine(
        JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied' } }),
      ),
    ).toEqual({ kind: 'skip', type: 'event_msg:thread_settings_applied' });
    expect(
      parseRolloutLine(JSON.stringify({ type: 'inter_agent_communication_metadata', payload: {} })),
    ).toEqual({ kind: 'skip', type: 'inter_agent_communication_metadata' });
  });
});

describe('toIso', () => {
  it('returns null for anything that is not a representable time, never throws', () => {
    for (const v of [1e300, 8.7e15, -1e300, Number.NaN, 'not a date', '', null, {}])
      expect(toIso(v)).toBeNull();
    expect(toIso(1_767_225_600)).toBe('2026-01-01T00:00:00.000Z');
  });
});

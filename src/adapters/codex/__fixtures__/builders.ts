/** Synthetic Codex rollout lines. Nothing here is copied from a real transcript. */

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const CHILD_ID = '22222222-2222-4222-8222-222222222222';
export const TURN_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TURN_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CWD = '/work/garden';

/** ISO time `sec` seconds after 2026-01-01T00:00:00Z. */
export function at(sec: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();
}

export function unix(sec: number): number {
  return Math.floor(Date.parse(at(sec)) / 1000);
}

export function ms(sec: number): number {
  return Date.parse(at(sec));
}

export function line(type: string, ordinal: number, sec: number, payload: unknown): string {
  return JSON.stringify({ timestamp: at(sec), ordinal, type, payload });
}

export function sessionMeta(over: Record<string, unknown> = {}): string {
  return line('session_meta', 0, 0, {
    id: SESSION_ID,
    session_id: SESSION_ID,
    timestamp: at(0),
    cwd: CWD,
    cli_version: '0.153.4',
    base_instructions: { text: 'You tend a garden.' },
    ...over,
  });
}

export function usage(o: {
  ordinal: number;
  sec: number;
  responseId: string;
  turnId: string;
  input: number;
  cached?: number;
  output: number;
  reasoning?: number;
}): string {
  const cached = o.cached ?? 0;
  const reasoning = o.reasoning ?? 0;
  return line('token_usage_record', o.ordinal, o.sec, {
    response_id: o.responseId,
    turn_id: o.turnId,
    usage: {
      input_tokens: o.input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: o.output,
      reasoning_output_tokens: reasoning,
      total_tokens: o.input + o.output,
    },
    // Cumulative totals must not be added on top of `usage`.
    thread_token_usage: {
      input_tokens: 9999,
      cached_input_tokens: 0,
      output_tokens: 9999,
      reasoning_output_tokens: 0,
      total_tokens: 19998,
    },
  });
}

/**
 * `total` is the thread's cumulative total_tokens. By default it follows the call's own usage,
 * so an identical repeat also repeats the total, as a rebroadcast does.
 */
export function tokenCount(
  ordinal: number,
  sec: number,
  input: number,
  cached: number,
  output: number,
  reasoning: number,
  total = input + output,
): string {
  return line('event_msg', ordinal, sec, {
    type: 'token_count',
    info: {
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      },
      total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total },
    },
  });
}

/** A two-response turn with reasoning, a tool, usage records and noise lines. */
export function gardenSession(): string[] {
  return [
    sessionMeta(),
    line('turn_context', 1, 1, { turn_id: TURN_1, model: 'gpt-5.6-sol', effort: 'high' }),
    line('event_msg', 2, 1, {
      type: 'task_started',
      turn_id: TURN_1,
      started_at: unix(1),
      turn_attribution: { turn_trigger: 'composer' },
    }),
    line('response_item', 3, 1, {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'injected context' }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
    }),
    line('response_item', 4, 2, {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Draw a garden plan' }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
    }),
    line('event_msg', 5, 2, {
      type: 'item_completed',
      item: {
        type: 'UserMessage',
        id: 'um-1',
        content: [{ type: 'text', text: 'Draw a garden plan' }],
      },
    }),
    line('response_item', 6, 3, {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'sketch the beds' }],
      encrypted_content: 'ciphertext-sentinel',
      internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
    }),
    line('event_msg', 7, 3, {
      type: 'item_completed',
      started_at_ms: ms(3),
      completed_at_ms: ms(3) + 500,
      item: { type: 'Reasoning', id: 'rs_1', raw_content: [], summary_text: [] },
    }),
    line('response_item', 8, 4, {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: "I'll look around." }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
    }),
    line('event_msg', 9, 4, {
      type: 'item_completed',
      item: {
        type: 'AgentMessage',
        id: 'msg_1',
        content: [{ type: 'text', text: 'ui echo should not duplicate' }],
      },
    }),
    line('response_item', 10, 5, {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call_exec',
      input: 'ls beds',
      internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
    }),
    line('event_msg', 11, 5, {
      type: 'item_completed',
      started_at_ms: ms(5),
      completed_at_ms: ms(5) + 40,
      item: {
        type: 'CommandExecution',
        id: 'exec-1',
        status: 'completed',
        aggregated_output: 'herb.txt',
      },
    }),
    line('response_item', 12, 6, {
      type: 'custom_tool_call_output',
      call_id: 'call_exec',
      output: 'herb.txt',
      internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
    }),
    usage({
      ordinal: 13,
      sec: 7,
      responseId: 'resp_1',
      turnId: TURN_1,
      input: 100,
      cached: 40,
      output: 10,
      reasoning: 4,
    }),
    line('response_item', 14, 8, {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'ciphertext-sentinel',
      internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
    }),
    line('response_item', 15, 9, {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Plant mint along the path.' }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN_1 },
    }),
    usage({
      ordinal: 16,
      sec: 10,
      responseId: 'resp_2',
      turnId: TURN_1,
      input: 50,
      cached: 50,
      output: 5,
      reasoning: 5,
    }),
    line('event_msg', 17, 10, {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 50,
          cached_input_tokens: 50,
          output_tokens: 5,
          reasoning_output_tokens: 5,
        },
        total_token_usage: { input_tokens: 9999, output_tokens: 9999 },
      },
    }),
    line('event_msg', 18, 11, { type: 'task_complete', turn_id: TURN_1, completed_at: unix(11) }),
    line('world_state', 19, 11, { state: { top_level_tools: [{ name: 'exec' }] } }),
    '{',
    JSON.stringify({ type: 'snack_time', payload: {} }),
  ];
}

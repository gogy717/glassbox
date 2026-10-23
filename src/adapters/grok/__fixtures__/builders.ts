/** Synthetic Grok session records. Nothing here is copied from a real transcript. */

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const CWD = '/work/garden';
export const PROMPT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const PROMPT_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** ISO time `sec` seconds after 2026-01-01T00:00:00Z. */
export function at(sec: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();
}

export function unix(sec: number): number {
  return Math.floor(Date.parse(at(sec)) / 1000);
}

export function event(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: at(0), type, ...fields });
}

export function userChunk(o: {
  text: string;
  promptIndex: number;
  atSec?: number;
  model?: string;
}): string {
  return JSON.stringify({
    timestamp: unix(o.atSec ?? 0),
    method: 'session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: o.text },
        _meta: { modelId: o.model ?? 'grok-4.7', promptIndex: o.promptIndex },
      },
    },
  });
}

export function modelChunk(o: {
  kind: 'thought' | 'message';
  text: string;
  promptId: string;
  streamAtSec: number;
  atSec?: number;
}): string {
  return JSON.stringify({
    timestamp: unix(o.atSec ?? o.streamAtSec),
    method: 'session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: o.kind === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: o.text },
      },
      _meta: { promptId: o.promptId, streamStartMs: Date.parse(at(o.streamAtSec)) },
    },
  });
}

export function toolCall(o: {
  id: string;
  name: string;
  input: unknown;
  promptId: string;
  streamAtSec: number;
  atSec?: number;
}): string {
  return JSON.stringify({
    timestamp: unix(o.atSec ?? o.streamAtSec),
    method: 'session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: o.id,
        title: o.name,
        rawInput: o.input,
        _meta: { 'x.ai/tool': { name: o.name, kind: 'read' } },
      },
      _meta: {
        promptId: o.promptId,
        streamStartMs: Date.parse(at(o.streamAtSec)),
        updateParams: { status: 'Pending' },
      },
    },
  });
}

export function toolUpdate(o: {
  id: string;
  status?: string;
  output?: unknown;
  atSec?: number;
  promptId?: string;
  streamAtSec?: number;
}): string {
  return JSON.stringify({
    timestamp: unix(o.atSec ?? 0),
    method: 'session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: o.id,
        ...(o.status ? { status: o.status } : {}),
        ...(o.output !== undefined ? { rawOutput: o.output } : {}),
      },
      _meta: {
        ...(o.promptId ? { promptId: o.promptId } : {}),
        ...(o.streamAtSec != null ? { streamStartMs: Date.parse(at(o.streamAtSec)) } : {}),
      },
    },
  });
}

export function turnCompleted(o: {
  promptId: string;
  stopReason?: string;
  atSec?: number;
  usage?: Record<string, number>;
}): string {
  return JSON.stringify({
    timestamp: unix(o.atSec ?? 0),
    method: '_x.ai/session/update',
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: o.promptId,
        stop_reason: o.stopReason ?? 'end_turn',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
          modelCalls: 1,
          ...o.usage,
        },
      },
    },
  });
}

export function compaction(
  phase: 'auto_compact_started' | 'compaction_checkpoint' | 'auto_compact_completed',
  atSec: number,
): string {
  return JSON.stringify({
    timestamp: unix(atSec),
    method: '_x.ai/session/update',
    params: { sessionId: SESSION_ID, update: { sessionUpdate: phase } },
  });
}

export function sideUpdate(sessionUpdate: string): string {
  return JSON.stringify({
    timestamp: unix(0),
    method: '_x.ai/session/update',
    params: { sessionId: SESSION_ID, update: { sessionUpdate } },
  });
}

export function chat(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...fields });
}

export function summaryDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    info: { id: SESSION_ID, cwd: CWD },
    generated_title: 'Garden plan',
    session_summary: '',
    created_at: at(0),
    updated_at: at(30),
    current_model_id: 'grok-4.7',
    reasoning_effort: 'xhigh',
    ...over,
  };
}

export function usageDoc(
  turns: { turnNumber: number; atSec: number; usage: Record<string, number> }[],
): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    turns: turns.map((turn) => ({
      turnNumber: turn.turnNumber,
      endedAt: at(turn.atSec),
      primaryModelId: 'grok-4.7-build',
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      modelCalls: 1,
      ...turn.usage,
    })),
  };
}

export const TOOL_DEFS = [
  { type: 'function', function: { name: 'list_dir', description: 'List a directory' } },
];

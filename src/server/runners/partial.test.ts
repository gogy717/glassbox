import { describe, expect, it } from 'vitest';
import type { LivePartial } from '../../shared/runs.js';
import { applyStreamEvent } from './partial.js';

const T0 = '2026-10-23T10:00:00.000Z';
const T1 = '2026-10-23T10:00:01.000Z';

const start = { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } };
const blockStart = (index: number, content_block: object) => ({
  type: 'content_block_start',
  index,
  content_block,
});
const delta = (index: number, d: object) => ({ type: 'content_block_delta', index, delta: d });

function feed(events: unknown[], now = T0): LivePartial | null {
  let p: LivePartial | null = null;
  for (const ev of events) p = applyStreamEvent(p, ev, now);
  return p;
}

describe('applyStreamEvent', () => {
  it('message_start opens an empty partial', () => {
    expect(applyStreamEvent(null, start, T0)).toEqual({
      messageId: 'msg_1',
      startedAt: T0,
      thinking: '',
      thinkingTokens: null,
      text: '',
      toolUses: [],
    });
  });

  it('accumulates text deltas', () => {
    const p = feed([
      start,
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'Hel' }),
      delta(0, { type: 'text_delta', text: 'lo' }),
      { type: 'content_block_stop', index: 0 },
    ]);
    expect(p?.text).toBe('Hello');
  });

  it('separates consecutive text blocks', () => {
    const p = feed([
      start,
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'One.' }),
      blockStart(1, { type: 'text', text: '' }),
      delta(1, { type: 'text_delta', text: 'Two.' }),
    ]);
    expect(p?.text).toBe('One.\n\nTwo.');
  });

  it('keeps thinking text when there is any, and the running token estimate', () => {
    const p = feed([
      start,
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: '', estimated_tokens: 50 }),
      delta(0, { type: 'thinking_delta', thinking: 'Plan: ', estimated_tokens: 80 }),
      delta(0, { type: 'signature_delta', signature: 'sig' }),
    ]);
    expect(p).toMatchObject({ thinking: 'Plan: ', thinkingTokens: 80 });
  });

  it('accumulates tool inputs per tool use, in block order', () => {
    const p = feed([
      start,
      blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '' }),
      delta(0, { type: 'input_json_delta', partial_json: '{"command":' }),
      delta(0, { type: 'input_json_delta', partial_json: '"ls"}' }),
      { type: 'content_block_stop', index: 0 },
      blockStart(1, { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }),
      delta(1, { type: 'input_json_delta', partial_json: '{"file_path":"/a"}' }),
    ]);
    expect(p?.toolUses).toEqual([
      { id: 'toolu_1', name: 'Bash', inputJson: '{"command":"ls"}' },
      { id: 'toolu_2', name: 'Read', inputJson: '{"file_path":"/a"}' },
    ]);
  });

  it('message_stop clears the partial', () => {
    expect(feed([start, { type: 'message_stop' }])).toBeNull();
  });

  it('a new message_start replaces the previous partial', () => {
    const p = feed([
      start,
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'old' }),
    ]);
    const next = applyStreamEvent(p, { type: 'message_start', message: { id: 'msg_2' } }, T1);
    expect(next).toMatchObject({ messageId: 'msg_2', startedAt: T1, text: '' });
  });

  it('ignores unknown, malformed and orphan events without mutating its input', () => {
    const p = feed([start, blockStart(0, { type: 'text', text: '' })]);
    const before = JSON.stringify(p);
    for (const ev of [
      null,
      42,
      { type: 'brand_new_event' },
      delta(0, { type: 'mystery_delta' }),
      delta(5, { type: 'input_json_delta', partial_json: 'x' }),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ])
      expect(applyStreamEvent(p, ev, T0)).toEqual(p);
    expect(JSON.stringify(p)).toBe(before);
    expect(applyStreamEvent(null, delta(0, { type: 'text_delta', text: 'x' }), T0)).toBeNull();
  });
});

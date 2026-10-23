/**
 * Folds Claude Code's `stream_event` messages (raw API stream events) into the assistant
 * message currently streaming. Pure: never mutates its input, ignores what it does not know.
 */
import type { IsoTime } from '../../core/model.js';
import type { LivePartial } from '../../shared/runs.js';

type Block = { kind: 'text' } | { kind: 'thinking' } | { kind: 'tool_use'; tool: number };

/** Content-block index → block, per partial. Kept outside the partial so its shape stays the contract's. */
const blocks = new WeakMap<LivePartial, Map<number, Block>>();

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown) => (typeof v === 'string' ? v : null);

function next(p: LivePartial, change: Partial<LivePartial>, map?: Map<number, Block>): LivePartial {
  const out = { ...p, ...change };
  blocks.set(out, map ?? blocks.get(p) ?? new Map());
  return out;
}

export function applyStreamEvent(
  partial: LivePartial | null,
  ev: unknown,
  now: IsoTime,
): LivePartial | null {
  const e = obj(ev);
  if (!e) return partial;
  switch (e.type) {
    case 'message_start': {
      const fresh: LivePartial = {
        messageId: str(obj(e.message)?.id) ?? '',
        startedAt: now,
        thinking: '',
        thinkingTokens: null,
        text: '',
        toolUses: [],
      };
      blocks.set(fresh, new Map());
      return fresh;
    }
    case 'message_stop':
      return null;
    case 'content_block_start': {
      const block = obj(e.content_block);
      if (!partial || !block || typeof e.index !== 'number') return partial;
      const map = new Map(blocks.get(partial));
      if (block.type === 'text') {
        map.set(e.index, { kind: 'text' });
        // Several text blocks in one message read as paragraphs.
        return next(partial, { text: partial.text ? `${partial.text}\n\n` : '' }, map);
      }
      if (block.type === 'thinking') {
        map.set(e.index, { kind: 'thinking' });
        return next(partial, {}, map);
      }
      if (block.type === 'tool_use') {
        map.set(e.index, { kind: 'tool_use', tool: partial.toolUses.length });
        const tool = { id: str(block.id) ?? '', name: str(block.name) ?? '', inputJson: '' };
        return next(partial, { toolUses: [...partial.toolUses, tool] }, map);
      }
      return partial;
    }
    case 'content_block_delta': {
      const d = obj(e.delta);
      if (!partial || !d || typeof e.index !== 'number') return partial;
      const block = blocks.get(partial)?.get(e.index);
      if (!block) return partial;
      if (d.type === 'text_delta' && block.kind === 'text')
        return next(partial, { text: partial.text + (str(d.text) ?? '') });
      if (d.type === 'thinking_delta' && block.kind === 'thinking') {
        const tokens = typeof d.estimated_tokens === 'number' ? d.estimated_tokens : null;
        return next(partial, {
          thinking: partial.thinking + (str(d.thinking) ?? ''),
          thinkingTokens: tokens ?? partial.thinkingTokens,
        });
      }
      if (d.type === 'input_json_delta' && block.kind === 'tool_use') {
        const toolUses = partial.toolUses.map((t, i) =>
          i === block.tool ? { ...t, inputJson: t.inputJson + (str(d.partial_json) ?? '') } : t,
        );
        return next(partial, { toolUses });
      }
      return partial;
    }
    default:
      return partial;
  }
}

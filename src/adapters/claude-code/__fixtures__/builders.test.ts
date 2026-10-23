import { describe, expect, it } from 'vitest';
import { assistantBlocks } from './builders.js';

const parse = (lines: string[]) => lines.map((l) => JSON.parse(l));

describe('assistantBlocks', () => {
  it('2.1.302 style: one record per block, only the last carries final usage', () => {
    const records = parse(
      assistantBlocks({
        requestId: 'req_1',
        blocks: ['thinking', 'text', 'tool_use'],
        style: '2.1.302',
        usage: { output: 300 },
      }),
    );
    expect(records).toHaveLength(3);
    expect(new Set(records.map((r) => r.requestId))).toEqual(new Set(['req_1']));
    expect(new Set(records.map((r) => r.message.id)).size).toBe(1);
    expect(records.map((r) => r.apiBlockIndex)).toEqual([0, 1, 2]);
    expect(records.map((r) => r.message.stop_reason)).toEqual([null, null, 'tool_use']);
    expect(records[2].message.usage.output_tokens).toBe(300);
    expect(records[0].message.usage.output_tokens).toBeLessThan(300);
    expect(records[1].message.usage.output_tokens).toBeLessThan(300);
  });

  it('2.1.308 style: every record carries the identical final usage', () => {
    const records = parse(
      assistantBlocks({
        requestId: 'req_2',
        blocks: ['thinking', 'text', 'tool_use'],
        style: '2.1.308',
        usage: { output: 300 },
      }),
    );
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.apiBlockIndex)).toEqual([0, 1, 2]);
    expect(records.map((r) => r.message.stop_reason)).toEqual(['tool_use', 'tool_use', 'tool_use']);
    for (const r of records) expect(r.message.usage).toEqual(records[2].message.usage);
    expect(records[0].message.usage.output_tokens).toBe(300);
  });
});

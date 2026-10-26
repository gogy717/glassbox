import { describe, expect, it } from 'vitest';
import { requestBill } from '../../shared/context-bill.js';
import type { ModelRequest, RequestDetail } from '../model.js';
import { createDemoSideSnapshots, createDemoSnapshot } from './demo.js';
import { demoRequestDetail } from './demo-detail.js';

const NOW = new Date('2026-10-23T10:00:00.000Z');
const snap = createDemoSnapshot(NOW);
const detailOf = (id: string) => demoRequestDetail(snap, id) as RequestDetail;
const request = (id: string) => snap.requests.find((r) => r.id === id) as ModelRequest;

type Msg = { role: string; content: unknown };
const blocks = (m: Msg) => (Array.isArray(m.content) ? (m.content as { type: string }[]) : []);

describe('demoRequestDetail', () => {
  it('sends the agent’s conversation up to the request: prompt, replies, calls, results', () => {
    const messages = detailOf('req_m3').messages as Msg[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(messages[0]?.content).toBe('Busy sessions should be listed first in the sidebar');
    expect(blocks(messages[1] as Msg).map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    // The last message answers the ten calls of the request before.
    const results = blocks(messages[4] as Msg) as { type: string; tool_use_id: string }[];
    expect(results.map((b) => b.tool_use_id)).toEqual(request('req_m2').toolCallIds);
    expect(results.every((b) => b.type === 'tool_result')).toBe(true);
  });

  it('ends a prompt’s first request with the prompt, after the turns before it', () => {
    const messages = detailOf('req_m4').messages as Msg[];
    expect(messages).toHaveLength(7);
    expect(String(messages.at(-1)?.content)).toMatch(/^Research how a live viewer/);
  });

  it('gives a sub-agent its own conversation', () => {
    const messages = detailOf('req_s2').messages as Msg[];
    expect(String(messages[0]?.content)).toMatch(/^Map the record types/);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('is complete and made up: a system prompt and the tools the demo calls', () => {
    const d = detailOf('req_m1');
    expect(d).toMatchObject({ requestId: 'req_m1', completeness: 'full', notes: [] });
    expect(JSON.stringify(d.system)).toContain('(demo)');
    const names = (d.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['Bash', 'Read', 'Edit', 'Write', 'Agent']));
    expect(demoRequestDetail(snap, 'nope')).toBeNull();
  });

  it('weighs as a session does: the prompt and tools first, file reads above their previews', () => {
    const first = requestBill(request('req_m1'), detailOf('req_m1'));
    if (first.status !== 'ok') throw new Error('no bill');
    const fixed = first.parts
      .filter((p) => p.kind === 'system' || p.kind === 'tool')
      .reduce((s, p) => s + p.tokens, 0);
    expect(fixed / first.total).toBeGreaterThan(0.8);

    const later = requestBill(request('req_m3'), detailOf('req_m3'));
    if (later.status !== 'ok') throw new Error('no bill');
    const results = later.parts.filter((p) => p.kind === 'result');
    const biggest = results.reduce((a, b) => (b.tokens > a.tokens ? b : a));
    expect(biggest).toMatchObject({ tool: 'Read', target: 'store.ts' });
  });

  it('serves every session the demo lists', () => {
    for (const side of createDemoSideSnapshots(NOW)) {
      const req = side.requests[0] as ModelRequest;
      expect(demoRequestDetail(side, req.id)?.messages?.length).toBeGreaterThan(0);
    }
  });
});

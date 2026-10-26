import { describe, expect, it } from 'vitest';
import type { ModelRequest, RequestDetail, TokenUsage } from '../core/model.js';
import { emptyUsage } from '../core/usage.js';
import {
  ContextLedger,
  type ContextPart,
  MEDIA_TOKENS,
  requestBill,
  textTokens,
} from './context-bill.js';

/** A finished request that reported `input`, `cacheRead` and `cacheWrite`. */
function request(
  split: { input?: number; cacheRead?: number; cacheWrite?: number } | null,
  over: Partial<ModelRequest> = {},
): ModelRequest {
  const usage: TokenUsage | null = split
    ? { ...emptyUsage(), input: 0, cacheRead: 0, cacheWrite: 0, ...split, output: 50 }
    : null;
  return {
    id: 'r1',
    agentId: 'main',
    turnId: 'turn1',
    index: 1,
    model: 'claude-opus-5-5',
    effort: null,
    startedAt: '2026-10-23T09:00:00.000Z',
    firstBlockAt: null,
    endedAt: split ? '2026-10-23T09:00:05.000Z' : null,
    status: split ? 'complete' : 'in-flight',
    stopReason: null,
    usage,
    blocks: [],
    toolCallIds: [],
    hasDetail: true,
    error: null,
    ...over,
  };
}

function detail(over: Partial<RequestDetail>): RequestDetail {
  return {
    requestId: 'r1',
    completeness: 'full',
    notes: [],
    params: null,
    // An empty prompt weighs nothing; null would say it was not recorded.
    system: '',
    tools: [],
    messages: [],
    ...over,
  };
}

const text = (n: number, c = 'x') => c.repeat(n);
const user = (content: unknown) => ({ role: 'user', content });
const assistant = (content: unknown) => ({ role: 'assistant', content });
const result = (id: string, content: unknown) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
});

function ok(bill: ReturnType<typeof requestBill>) {
  if (bill.status !== 'ok') throw new Error(`no bill: ${bill.reason}`);
  return bill;
}

const byKind = (parts: ContextPart[], kind: ContextPart['kind']) =>
  parts.filter((p) => p.kind === kind);

describe('textTokens', () => {
  it('counts four characters of text or code to a token, a CJK character as one', () => {
    expect(textTokens(text(400))).toBe(100);
    expect(textTokens('上下文')).toBe(3);
    expect(textTokens(`${text(8)}上下文`)).toBe(5);
    expect(textTokens('')).toBe(0);
  });
});

describe('requestBill', () => {
  it('spreads the reported input, cache reads and writes over the parts by their weight', () => {
    const bill = ok(
      requestBill(
        request({ input: 10, cacheRead: 1_000, cacheWrite: 590 }),
        detail({
          system: [{ type: 'text', text: text(400) }],
          messages: [
            user(text(400, 'p')),
            assistant([{ type: 'text', text: text(200, 'r') }]),
            user([result('tu9', text(3_200))]),
          ],
        }),
      ),
    );
    expect(bill.measured).toBe(true);
    expect(bill.total).toBe(1_600);
    expect(bill.parts.map((p) => [p.kind, p.weight])).toEqual([
      ['system', 100],
      ['user', 100],
      ['reply', 50],
      ['result', 800],
    ]);
    // 1,600 over 1,050 of weight.
    const scale = 1_600 / 1_050;
    for (const p of bill.parts) expect(p.tokens).toBeCloseTo(p.weight * scale, 6);
    expect(bill.parts.reduce((s, p) => s + p.tokens, 0)).toBeCloseTo(1_600, 6);
  });

  it('splits each part into cache reads, writes and input by where it sits: tools, system, messages', () => {
    const bill = ok(
      requestBill(
        request({ cacheRead: 600, cacheWrite: 300, input: 100 }),
        detail({
          system: text(400),
          messages: [user(text(400, 'p')), user([result('tu9', text(3_200))])],
        }),
      ),
    );
    expect(bill.usage).toEqual({ cacheRead: 600, cacheWrite: 300, input: 100 });
    expect(bill.parts.map((p) => [p.kind, p.split])).toEqual([
      ['system', { cacheRead: 100, cacheWrite: 0, input: 0 }],
      ['user', { cacheRead: 100, cacheWrite: 0, input: 0 }],
      ['result', { cacheRead: 400, cacheWrite: 300, input: 100 }],
    ]);
  });

  it('weighs one part per tool definition, sent first, and names it', () => {
    const tools = [
      { name: 'Bash', description: text(300), input_schema: { type: 'object' } },
      { name: 'Read', description: text(100) },
    ];
    const bill = ok(
      requestBill(request({ input: 1_000 }), detail({ tools, messages: [user('hi')] })),
    );
    const defs = byKind(bill.parts, 'tool');
    expect(bill.parts.slice(0, 2)).toEqual(defs);
    expect(defs.map((p) => [p.key, p.tool, p.weight])).toEqual([
      ['tool:Bash', 'Bash', textTokens(JSON.stringify(tools[0]))],
      ['tool:Read', 'Read', textTokens(JSON.stringify(tools[1]))],
    ]);
  });

  it('names a tool result by the call it answers: the tool, what it worked on, its file', () => {
    const bill = ok(
      requestBill(
        request({ input: 1_000 }),
        detail({
          messages: [
            user('Fix the sort'),
            assistant([
              { type: 'text', text: 'Reading it first.' },
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/w/src/a.ts' } },
            ]),
            user([result('tu1', [{ type: 'text', text: text(800) }])]),
          ],
        }),
      ),
    );
    const call = byKind(bill.parts, 'call')[0] as ContextPart;
    expect(call).toMatchObject({
      key: 'call:tu1',
      tool: 'Read',
      callId: 'tu1',
      target: 'a.ts',
      path: '/w/src/a.ts',
    });
    expect(call.weight).toBeCloseTo(
      textTokens('Read') + textTokens(JSON.stringify({ file_path: '/w/src/a.ts' })),
      6,
    );
    expect(byKind(bill.parts, 'result')[0]).toMatchObject({
      key: 'result:tu1',
      tool: 'Read',
      callId: 'tu1',
      target: 'a.ts',
      path: '/w/src/a.ts',
      weight: 200,
    });
    // The reply's own text is a part of its own, apart from its call.
    expect(byKind(bill.parts, 'reply')[0]).toMatchObject({
      text: 'Reading it first.',
      role: 'assistant',
    });
    expect(byKind(bill.parts, 'user')[0]).toMatchObject({ text: 'Fix the sort', role: 'user' });
  });

  it('marks what the request added: the parts of its last message', () => {
    const bill = ok(
      requestBill(
        request({ input: 100 }),
        detail({
          messages: [
            user('first'),
            assistant('ok'),
            user([result('tu1', 'done'), { type: 'text', text: 'and then' }]),
          ],
        }),
      ),
    );
    expect(bill.parts.filter((p) => p.last).map((p) => p.kind)).toEqual(['result', 'user']);
  });

  it('counts CJK text at a token a character, so Chinese weighs what it costs', () => {
    const bill = ok(
      requestBill(
        request({ input: 600 }),
        detail({ messages: [user('上下文'.repeat(100)), assistant(text(1_200))] }),
      ),
    );
    expect(bill.parts.map((p) => p.tokens)).toEqual([300, 300]);
  });

  it('weighs an image or a document at a fixed share, whatever its bytes', () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: text(400_000, 'A') },
    };
    const bill = ok(requestBill(request({ input: 1_000 }), detail({ messages: [user([image])] })));
    expect(bill.parts[0]?.weight).toBe(MEDIA_TOKENS);
  });

  it('weighs thinking kept only as its signature by the signature', () => {
    const bill = ok(
      requestBill(
        request({ input: 1_000 }),
        detail({
          messages: [
            user('go'),
            assistant([{ type: 'thinking', thinking: '', signature: text(5_336, 'S') }]),
          ],
        }),
      ),
    );
    // 5,336 base64 characters hold 4,002 bytes: about 1,000 tokens of thinking.
    expect(byKind(bill.parts, 'reply')[0]?.weight).toBeCloseTo(1_000.5, 6);
  });

  it('keys a message by what it holds, so the same message is the same part in every request', () => {
    const messages = [user('Fix the sort'), assistant('Done.'), user('Fix the sort')];
    const a = ok(requestBill(request({ input: 100 }), detail({ messages })));
    const b = ok(
      requestBill(
        request({ input: 100 }),
        detail({ messages: JSON.parse(JSON.stringify(messages)) as unknown[] }),
      ),
    );
    expect(a.parts.map((p) => p.key)).toEqual(b.parts.map((p) => p.key));
    // Two messages alike in one request stay two parts.
    const [first, , second] = a.parts;
    expect(first?.key).not.toBe(second?.key);
  });

  it('gives what was not reconstructed the rest of the total, the known parts their own weight', () => {
    const bill = ok(
      requestBill(
        request({ cacheRead: 2_000 }),
        detail({
          completeness: 'partial',
          system: text(400),
          messages: [
            { unresolved: 'base:r0', messages: 4 },
            user(text(1_600)),
            { unresolved: 'abc' },
          ],
        }),
      ),
    );
    expect(bill.parts.map((p) => [p.kind, p.tokens])).toEqual([
      ['system', 100],
      ['gap', 1_500],
      ['user', 400],
    ]);
    expect(byKind(bill.parts, 'gap')[0]?.missing).toEqual({
      messages: 5,
      system: false,
      tools: false,
    });
  });

  it('scales the known parts down when they outweigh the total, leaving the gap none', () => {
    const bill = ok(
      requestBill(
        request({ input: 250 }),
        detail({ system: text(400), messages: [{ unresolved: 'abc' }, user(text(1_600))] }),
      ),
    );
    expect(bill.parts.map((p) => [p.kind, p.tokens])).toEqual([
      ['system', 50],
      ['gap', 0],
      ['user', 200],
    ]);
  });

  it('counts a system prompt and tools not recorded as not reconstructed', () => {
    const bill = ok(
      requestBill(
        request({ cacheRead: 1_000 }),
        detail({ completeness: 'partial', system: null, tools: null, messages: [user(text(400))] }),
      ),
    );
    expect(bill.parts.map((p) => [p.kind, p.tokens])).toEqual([
      ['gap', 900],
      ['user', 100],
    ]);
    expect(bill.parts[0]?.missing).toEqual({ messages: 0, system: true, tools: true });
  });

  it('weighs a request still in flight by its characters alone', () => {
    const bill = ok(requestBill(request(null), detail({ messages: [user(text(400))] })));
    expect(bill).toMatchObject({ measured: false, total: 100, usage: null });
    expect(bill.parts[0]).toMatchObject({ tokens: 100, split: null });
  });

  it('reads the formats other agents record: a tool message answering a call by id', () => {
    const bill = ok(
      requestBill(
        request({ input: 100 }),
        detail({
          messages: [
            { role: 'user', content: 'list files' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'shell' }] },
            { role: 'tool', toolCallId: 'c1', content: 'a.ts\nb.ts' },
          ],
        }),
      ),
    );
    expect(byKind(bill.parts, 'result')[0]).toMatchObject({ callId: 'c1', tool: 'shell' });
  });

  it('is not available, with the reason, when the request body was not recorded', () => {
    const r = request({ input: 100 });
    expect(requestBill({ ...r, hasDetail: false }, null)).toEqual({
      status: 'unavailable',
      reason: 'not-recorded',
    });
    expect(requestBill(r, null)).toEqual({ status: 'unavailable', reason: 'not-recorded' });
    expect(
      requestBill(r, detail({ completeness: 'unavailable', messages: null, tools: null })),
    ).toEqual({ status: 'unavailable', reason: 'not-recorded' });
    // Codex and oh-my-pi keep a system prompt and tools, never the messages of a call.
    expect(
      requestBill(r, detail({ completeness: 'partial', system: 'You are…', messages: null })),
    ).toEqual({ status: 'unavailable', reason: 'no-messages' });
    expect(requestBill(r, detail({ messages: [] }))).toEqual({
      status: 'unavailable',
      reason: 'empty',
    });
  });
});

// ── The bill of an agent's requests ───────────────────────────────────────────────────────

/** An agent's conversation as it grows: each request sends what the one before did, and more. */
function conversation() {
  const messages: unknown[] = [];
  let n = 0;
  const req = (cacheRead: number, over: Partial<ModelRequest> = {}) =>
    request({ cacheRead }, { id: `r${++n}`, ...over });
  return {
    messages,
    say: (...more: unknown[]) => messages.push(...more),
    read: (id: string, path: string, chars: number) =>
      messages.push(
        assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }]),
        user([result(id, text(chars))]),
      ),
    /** The request sent now: the system prompt, one tool, the messages so far. */
    send: (cacheRead: number, over: Partial<ModelRequest> = {}) => ({
      request: req(cacheRead, over),
      detail: detail({
        system: text(4_000),
        tools: [{ name: 'Bash', description: text(400) }],
        messages: [...messages],
      }),
    }),
  };
}

function ledger(entries: { request: ModelRequest; detail: RequestDetail | null }[], cwd = '/w') {
  const l = new ContextLedger('main', cwd);
  for (const e of entries) l.add(e.request, e.detail);
  return l.bill();
}

describe('ContextLedger', () => {
  it('counts each tool result in every request that carried it, at its share of each', () => {
    const c = conversation();
    c.say(user('Fix the sort'));
    const first = c.send(2_000);
    c.say(
      assistant([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }]),
      user([result('tu1', text(8_000))]),
    );
    const sent = [first, c.send(4_000), c.send(4_100), c.send(4_200)];
    const bill = ledger(sent);
    expect(bill).toMatchObject({ requests: 4, read: 4, unavailable: null });
    const item = bill.items.find((i) => i.key === 'result:tu1');
    expect(item).toMatchObject({ kind: 'result', tool: 'Bash', target: 'npm test', requests: 3 });
    // As each request's own bill spreads it.
    const each = sent.slice(1).map((e) => {
      const b = requestBill(e.request, e.detail);
      return b.status === 'ok' ? (b.parts.find((p) => p.key === 'result:tu1')?.tokens ?? 0) : 0;
    });
    expect(item?.tokens).toBeCloseTo(
      each.reduce((a, b) => a + b, 0),
      6,
    );
    // Carried later, it is read from the cache.
    expect(item?.split.cacheRead).toBeCloseTo(item?.tokens ?? 0, 6);
  });

  it('gathers the reads of one file, however its path was written', () => {
    const c = conversation();
    c.say(user('Look at a.ts'));
    const sent = [];
    for (let i = 1; i <= 5; i++) {
      c.read(`tu${i}`, i % 2 ? '/w/src/a.ts' : 'src/a.ts', 2_000);
      sent.push(c.send(3_000 + i * 600));
    }
    const bill = ledger(sent);
    const file = bill.items.find((i) => i.kind === 'file');
    expect(file).toMatchObject({
      key: 'file:/w/src/a.ts',
      path: '/w/src/a.ts',
      reads: 5,
      requests: 5,
      callId: 'tu5',
    });
    // The calls and results of the reads are in it, none of them an item of its own.
    expect(bill.items.filter((i) => i.kind === 'result' || i.kind === 'call')).toEqual([]);
    expect(bill.advice).toEqual({ kind: 'rereads', files: 1, reads: 5 });
  });

  it('says what the system prompt and tools cost, every request', () => {
    const c = conversation();
    c.say(user('hi'));
    const bill = ledger([c.send(2_000), c.send(2_000), c.send(2_000)]);
    // 1,000 of the system prompt, the tool's JSON, two of "hi": all of 2,000.
    const tool = textTokens(JSON.stringify({ name: 'Bash', description: text(400) }));
    const weight = 1_000 + tool + 0.5;
    expect(bill.fixed?.requests).toBe(3);
    expect(bill.fixed?.perRequest).toBeCloseTo(((1_000 + tool) / weight) * 2_000, 6);
    expect(bill.fixed?.system).toBeCloseTo((1_000 / weight) * 2_000, 6);
    expect(bill.fixed?.toolCount).toBe(1);
    expect(bill.fixed?.tokens).toBeCloseTo((bill.fixed?.perRequest ?? 0) * 3, 6);
    expect(bill.tokens).toBe(6_000);
    expect(bill.advice).toMatchObject({ kind: 'fixed' });
  });

  it('says what a compaction dropped: the parts before it, gone after, the largest first', () => {
    const c = conversation();
    c.say(user('Fix the sort'));
    c.read('tu1', '/w/a.ts', 4_000);
    c.say(
      assistant([{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'npm test' } }]),
      user([result('tu2', text(12_000))]),
    );
    const before = c.send(6_000);
    c.messages.splice(0);
    c.say(user('This session is being continued. Summary: the sort is fixed.'));
    const after = c.send(1_500, { compactedBefore: true });
    const bill = ledger([before, after]);
    expect(bill.compactions).toHaveLength(1);
    const drop = bill.compactions[0];
    expect(drop).toMatchObject({ requestId: 'r2', beforeId: 'r1', dropped: 5 });
    expect(drop?.largest.map((p) => [p.kind, p.tool, p.target])).toEqual([
      ['result', 'Bash', 'npm test'],
      ['result', 'Read', 'a.ts'],
      ['call', 'Read', 'a.ts'],
    ]);
    const parts = requestBill(before.request, before.detail);
    if (parts.status !== 'ok') throw new Error('no bill');
    const gone = parts.parts.filter((p) => p.kind !== 'system' && p.kind !== 'tool');
    expect(drop?.tokens).toBeCloseTo(
      gone.reduce((s, p) => s + p.tokens, 0),
      6,
    );
  });

  it('names one item that held much of the context', () => {
    const c = conversation();
    c.say(user('go'));
    c.say(
      assistant([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat big.log' } }]),
      user([result('tu1', text(80_000))]),
    );
    const bill = ledger([c.send(25_000), c.send(25_100)]);
    expect(bill.advice).toMatchObject({ kind: 'carried', item: { key: 'result:tu1' } });
    expect(bill.items[0]?.key).toBe('result:tu1');
  });

  it('skips a request not finished, and says why none could be read', () => {
    const c = conversation();
    c.say(user('go'));
    const live = c.send(0);
    expect(
      ledger([{ request: { ...live.request, usage: null }, detail: live.detail }]),
    ).toMatchObject({
      requests: 1,
      read: 0,
      items: [],
      fixed: null,
    });
    expect(
      ledger([{ request: { ...live.request, hasDetail: false }, detail: null }]),
    ).toMatchObject({ read: 0, unavailable: 'not-recorded' });
    expect(
      ledger([
        {
          request: request({ input: 100 }),
          detail: detail({ system: 'You are…', messages: null }),
        },
      ]),
    ).toMatchObject({ read: 0, unavailable: 'no-messages', advice: null });
  });

  it('keeps the costliest items, largest first', () => {
    const c = conversation();
    c.say(user('go'));
    for (let i = 1; i <= 30; i++)
      c.say(
        assistant([
          { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `step ${i}` } },
        ]),
        user([result(`t${i}`, text(400 * i))]),
      );
    const bill = ledger([c.send(90_000)]);
    expect(bill.items).toHaveLength(12);
    expect(bill.items[0]?.key).toBe('result:t30');
    const tokens = bill.items.map((i) => i.tokens);
    expect([...tokens].sort((a, b) => b - a)).toEqual(tokens);
  });
});

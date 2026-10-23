import { describe, expect, it } from 'vitest';
import { checkSnapshot } from '../../core/invariants.js';
import { emptyUsage } from '../../core/usage.js';
import {
  at,
  chat,
  compaction,
  event,
  modelChunk,
  PROMPT_1,
  PROMPT_2,
  sideUpdate,
  summaryDoc,
  TOOL_DEFS,
  toolCall,
  toolUpdate,
  turnCompleted,
  usageDoc,
  userChunk,
} from './__fixtures__/builders.js';
import {
  chatFile,
  eventsFile,
  type Feed,
  feed,
  makeSource,
  summaryFile,
  updatesFile,
  usageFile,
} from './__fixtures__/harness.js';
import { GrokSessionParser } from './parser.js';

const TURN_1_USAGE = {
  inputTokens: 1000,
  outputTokens: 40,
  cachedReadTokens: 800,
  cacheCreationTokens: 10,
  reasoningTokens: 15,
  modelCalls: 2,
};
const TURN_2_USAGE = {
  inputTokens: 100,
  outputTokens: 8,
  cachedReadTokens: 40,
  cacheCreationTokens: 0,
  reasoningTokens: 3,
  modelCalls: 1,
};

function garden(): Feed {
  return {
    events: [
      event('turn_started', { ts: at(0), turn_number: 0, model_id: 'grok-4.7' }),
      event('loop_started', { ts: at(1), loop_index: 0 }),
      event('first_token', { ts: at(2) }),
      event('phase_changed', { ts: at(3), phase: 'tool_execution' }),
      event('tool_completed', {
        ts: at(5),
        tool_call_id: 'call-list',
        duration_ms: 40,
        outcome: 'success',
      }),
      event('loop_started', { ts: at(6), loop_index: 1 }),
      event('first_token', { ts: at(7) }),
      event('turn_ended', { ts: at(10), outcome: 'completed' }),
      event('snack_time', { ts: at(11) }),
      event('turn_started', { ts: at(20), turn_number: 1, model_id: 'grok-4.7' }),
      event('loop_started', { ts: at(21), loop_index: 0 }),
      event('first_token', { ts: at(22) }),
      event('turn_ended', { ts: at(30), outcome: 'completed' }),
      '{',
    ],
    updates: [
      userChunk({ text: 'Draw a garden plan', promptIndex: 0, atSec: 0 }),
      modelChunk({
        kind: 'thought',
        text: 'sketch ',
        promptId: PROMPT_1,
        streamAtSec: 1,
        atSec: 2,
      }),
      modelChunk({
        kind: 'thought',
        text: 'the beds',
        promptId: PROMPT_1,
        streamAtSec: 1,
        atSec: 3,
      }),
      modelChunk({
        kind: 'message',
        text: "I'll look around.",
        promptId: PROMPT_1,
        streamAtSec: 1,
        atSec: 4,
      }),
      toolCall({
        id: 'call-list',
        name: 'list_dir',
        input: { path: '.' },
        promptId: PROMPT_1,
        streamAtSec: 1,
        atSec: 4,
      }),
      toolUpdate({
        id: 'call-list',
        status: 'completed',
        output: { type: 'text', text: 'notes.txt' },
        atSec: 5,
      }),
      modelChunk({
        kind: 'thought',
        text: 'notes are enough',
        promptId: PROMPT_1,
        streamAtSec: 6,
        atSec: 7,
      }),
      modelChunk({
        kind: 'message',
        text: 'Plant mint along the path.',
        promptId: PROMPT_1,
        streamAtSec: 6,
        atSec: 8,
      }),
      turnCompleted({ promptId: PROMPT_1, atSec: 10, usage: TURN_1_USAGE }),
      sideUpdate('hook_execution'),
      userChunk({ text: 'Add herbs', promptIndex: 1, atSec: 20 }),
      modelChunk({
        kind: 'thought',
        text: 'basil',
        promptId: PROMPT_2,
        streamAtSec: 21,
        atSec: 22,
      }),
      modelChunk({
        kind: 'message',
        text: 'Basil goes in the corner.',
        promptId: PROMPT_2,
        streamAtSec: 21,
        atSec: 23,
      }),
      turnCompleted({ promptId: PROMPT_2, atSec: 30, usage: TURN_2_USAGE }),
    ],
    chat: [
      chat('system', { content: 'You are a gardener.' }),
      chat('user', {
        content: [{ type: 'text', text: 'Remember the rules' }],
        synthetic_reason: 'system_reminder',
      }),
      chat('user', { content: [{ type: 'text', text: 'Draw a garden plan' }], prompt_index: 0 }),
    ],
    summary: summaryDoc(),
    usage: usageDoc([
      { turnNumber: 1, atSec: 10, usage: TURN_1_USAGE },
      { turnNumber: 2, atSec: 30, usage: TURN_2_USAGE },
    ]),
    tools: TOOL_DEFS,
  };
}

describe('GrokSessionParser', () => {
  it('maps two user turns and puts each turn’s usage on its last model call', () => {
    const snap = feed(garden()).snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.session).toMatchObject({
      id: 'grok:11111111-1111-4111-8111-111111111111',
      agent: 'grok',
      title: 'Garden plan',
      cwd: '/work/garden',
      project: 'garden',
      model: 'grok-4.7',
      version: '1.0.67',
      live: 'busy',
    });
    expect(
      snap.turns.map((t) => ({
        id: t.id,
        index: t.index,
        origin: t.origin,
        prompt: t.prompt,
        status: t.status,
      })),
    ).toEqual([
      { id: 'turn:1', index: 1, origin: 'human', prompt: 'Draw a garden plan', status: 'complete' },
      { id: 'turn:2', index: 2, origin: 'human', prompt: 'Add herbs', status: 'complete' },
    ]);
    expect(snap.requests.map((r) => r.id)).toEqual(['t0:0', 't0:1', 't1:0']);
    const [first, second, third] = snap.requests;
    expect(first).toMatchObject({
      index: 1,
      turnId: 'turn:1',
      model: 'grok-4.7',
      effort: 'xhigh',
      status: 'complete',
      usage: null,
      stopReason: null,
      firstBlockAt: at(2),
      startedAt: at(1),
      endedAt: at(6),
    });
    expect(
      first?.blocks.map((b) =>
        b.kind === 'tool-use' ? b : { kind: b.kind, text: 'text' in b ? b.text : null },
      ),
    ).toEqual([
      { kind: 'thinking', text: 'sketch the beds' },
      { kind: 'text', text: "I'll look around." },
      expect.objectContaining({ kind: 'tool-use', toolCallId: 'call-list' }),
    ]);
    expect(second).toMatchObject({
      index: 2,
      status: 'complete',
      stopReason: 'end_turn',
      usage: { input: 190, cacheRead: 800, cacheWrite: 10, output: 40, thinking: 15 },
    });
    expect(second?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'thinking', text: 'notes are enough' }),
        expect.objectContaining({ kind: 'text', text: 'Plant mint along the path.' }),
      ]),
    );
    expect(third?.usage).toMatchObject({ input: 60, cacheRead: 40, output: 8, thinking: 3 });
    expect(snap.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call-list',
        name: 'list_dir',
        input: { path: '.' },
        status: 'complete',
        requestId: 't0:0',
        durationMs: 40,
        resultPreview: 'notes.txt',
        hasFullResult: true,
        spawned: null,
      }),
    ]);
    expect(feed(garden()).toolResult('call-list')).toEqual({ type: 'text', text: 'notes.txt' });
    expect(snap.workflows).toEqual([]);
    expect(snap.agents.map((a) => a.id)).toEqual(['main']);
    expect(snap.session.usage).toEqual(snap.agents[0]?.usage);
    expect(snap.session.counts).toEqual({ turns: 2, requests: 3, toolCalls: 1, agents: 1 });
    expect(snap.diagnostics.unavailable).toEqual(['per-request-usage', 'subagents']);
    expect(snap.diagnostics.parseErrors).toBe(1);
    expect(snap.diagnostics.unknownRecordTypes).toEqual({ snack_time: 1 });
  });

  it('joins the same calls when updates are read before events', () => {
    const spec = garden();
    const forward = feed(spec).snapshot();
    const backward = feed(spec, 'busy', [
      'updates',
      'usage',
      'events',
      'summary',
      'chat',
      'tools',
    ]).snapshot();
    expect(backward.requests.map((r) => ({ id: r.id, usage: r.usage, status: r.status }))).toEqual(
      forward.requests.map((r) => ({ id: r.id, usage: r.usage, status: r.status })),
    );
    expect(
      backward.toolCalls.map((t) => ({
        id: t.id,
        requestId: t.requestId,
        status: t.status,
        durationMs: t.durationMs,
      })),
    ).toEqual(
      forward.toolCalls.map((t) => ({
        id: t.id,
        requestId: t.requestId,
        status: t.status,
        durationMs: t.durationMs,
      })),
    );
    expect(checkSnapshot(backward)).toEqual([]);
  });

  it('keeps an open loop in flight and refuses to attach usage', () => {
    const parser = feed(
      {
        events: [
          event('turn_started', { ts: at(0), turn_number: 0, model_id: 'grok-4.7' }),
          event('loop_started', { ts: at(1), loop_index: 0 }),
        ],
        updates: [
          userChunk({ text: 'Still thinking', promptIndex: 0 }),
          modelChunk({ kind: 'thought', text: 'not yet', promptId: PROMPT_1, streamAtSec: 1 }),
          toolCall({
            id: 'call-open',
            name: 'read_file',
            input: { target_file: 'a.txt' },
            promptId: PROMPT_1,
            streamAtSec: 1,
          }),
        ],
      },
      'busy',
    );
    const snap = parser.snapshot();
    expect(snap.requests[0]).toMatchObject({ id: 't0:0', status: 'in-flight', usage: null });
    expect(snap.turns[0]).toMatchObject({ status: 'running' });
    expect(snap.toolCalls[0]).toMatchObject({ status: 'running' });
    expect(checkSnapshot(snap)).toEqual([]);
    const changes = parser.setLive('closed');
    expect(changes.requests).toContain('t0:0');
    const closed = parser.snapshot();
    expect(closed.requests[0]?.status).toBe('interrupted');
    expect(closed.toolCalls[0]?.status).toBe('unknown');
    expect(closed.session.live).toBe('closed');
    expect(checkSnapshot(closed)).toEqual([]);
  });

  it('marks a cancelled turn interrupted and still counts its usage once', () => {
    const snap = feed(
      {
        events: [
          event('turn_started', { ts: at(0), turn_number: 0, model_id: 'grok-4.7' }),
          event('loop_started', { ts: at(1), loop_index: 0 }),
          event('loop_started', { ts: at(4), loop_index: 1 }),
          event('tool_completed', {
            ts: at(3),
            tool_call_id: 'call-done',
            duration_ms: 10,
            outcome: 'success',
          }),
          event('turn_ended', { ts: at(6), outcome: 'cancelled' }),
        ],
        updates: [
          userChunk({ text: 'Stop halfway', promptIndex: 0 }),
          toolCall({
            id: 'call-done',
            name: 'list_dir',
            input: {},
            promptId: PROMPT_1,
            streamAtSec: 1,
            atSec: 2,
          }),
          toolUpdate({ id: 'call-done', status: 'completed', output: 'ok', atSec: 3 }),
          toolCall({
            id: 'call-hang',
            name: 'read_file',
            input: {},
            promptId: PROMPT_1,
            streamAtSec: 4,
            atSec: 5,
          }),
          turnCompleted({
            promptId: PROMPT_1,
            stopReason: 'cancelled',
            atSec: 6,
            usage: {
              inputTokens: 50,
              cachedReadTokens: 20,
              outputTokens: 4,
              reasoningTokens: 1,
              modelCalls: 2,
            },
          }),
        ],
      },
      'closed',
    ).snapshot();
    expect(snap.turns[0]).toMatchObject({ status: 'interrupted' });
    expect(snap.requests.map((r) => ({ id: r.id, status: r.status, usage: r.usage }))).toEqual([
      { id: 't0:0', status: 'complete', usage: null },
      {
        id: 't0:1',
        status: 'interrupted',
        usage: expect.objectContaining({ input: 30, cacheRead: 20, output: 4, thinking: 1 }),
      },
    ]);
    expect(snap.toolCalls.map((t) => ({ id: t.id, status: t.status }))).toEqual([
      { id: 'call-done', status: 'complete' },
      { id: 'call-hang', status: 'unknown' },
    ]);
    expect(checkSnapshot(snap)).toEqual([]);
  });

  it('flags the first model call after compaction', () => {
    const snap = feed({
      events: [
        event('turn_started', { ts: at(0), turn_number: 0, model_id: 'grok-4.7' }),
        event('loop_started', { ts: at(1), loop_index: 0 }),
        event('loop_started', { ts: at(6), loop_index: 1 }),
        event('turn_ended', { ts: at(8), outcome: 'completed' }),
      ],
      updates: [
        userChunk({ text: 'Go on', promptIndex: 0 }),
        compaction('auto_compact_completed', 4),
        turnCompleted({
          promptId: PROMPT_1,
          atSec: 8,
          usage: { inputTokens: 5, outputTokens: 1, modelCalls: 2 },
        }),
      ],
    }).snapshot();
    expect(
      snap.requests.map((r) => ({ id: r.id, compactedBefore: r.compactedBefore ?? false })),
    ).toEqual([
      { id: 't0:0', compactedBefore: false },
      { id: 't0:1', compactedBefore: true },
    ]);
  });

  it('fills thinking and text from chat history, matched by tool calls and exact gaps', () => {
    const loops = (n: number) => [
      event('turn_started', { ts: at(0), turn_number: 0, model_id: 'grok-4.7' }),
      ...Array.from({ length: n }, (_, i) =>
        event('loop_started', { ts: at(1 + i * 2), loop_index: i }),
      ),
      event('turn_ended', { ts: at(20), outcome: 'completed' }),
    ];
    const reasoning = (text: string) =>
      chat('reasoning', {
        summary: text ? [{ type: 'summary_text', text }] : [],
        encrypted_content: 'x',
      });
    const snap = feed({
      events: loops(3),
      updates: [
        toolCall({
          id: 'c1',
          name: 'grep',
          input: {},
          promptId: PROMPT_1,
          streamAtSec: 1,
          atSec: 2,
        }),
      ],
      chat: [
        chat('user', { content: [{ type: 'text', text: 'go' }], prompt_index: 0 }),
        reasoning('Look first.'),
        chat('assistant', {
          content: '',
          tool_calls: [{ id: 'c1', name: 'grep', arguments: '{}' }],
        }),
        reasoning(''),
        chat('assistant', { content: 'Middle answer.' }),
        reasoning('Wrap up.'),
        chat('assistant', { content: 'Final answer.' }),
      ],
    }).snapshot();
    const shown = snap.requests.map((r) => [
      r.blocks.find((b) => b.kind === 'thinking')?.text ?? null,
      r.blocks.find((b) => b.kind === 'text')?.text ?? null,
    ]);
    // The empty reasoning row keeps its place: loop 1 shows no thinking, not loop 0's.
    expect(shown).toEqual([
      ['Look first.', null],
      [null, 'Middle answer.'],
      ['Wrap up.', 'Final answer.'],
    ]);
  });

  it('shows nothing from chat history where rows and model calls do not line up', () => {
    // Two chat loops for three model calls (e.g. history rewritten by compaction).
    const snap = feed({
      events: [
        event('turn_started', { ts: at(0), turn_number: 0 }),
        event('loop_started', { ts: at(1), loop_index: 0 }),
        event('loop_started', { ts: at(3), loop_index: 1 }),
        event('loop_started', { ts: at(5), loop_index: 2 }),
        event('turn_ended', { ts: at(9), outcome: 'completed' }),
      ],
      chat: [
        chat('reasoning', { summary: [{ text: 'A' }] }),
        chat('assistant', { content: 'one' }),
        chat('reasoning', { summary: [{ text: 'B' }] }),
        chat('assistant', { content: 'two' }),
      ],
    }).snapshot();
    expect(snap.requests.map((r) => r.blocks)).toEqual([[], [], []]);
  });

  it('a tool-call anchor still places its own loop when the history before it was compacted', () => {
    const snap = feed({
      events: [
        event('turn_started', { ts: at(0), turn_number: 0 }),
        ...[0, 1, 2, 3].map((i) => event('loop_started', { ts: at(1 + i * 2), loop_index: i })),
        event('turn_ended', { ts: at(20), outcome: 'completed' }),
      ],
      updates: [
        toolCall({
          id: 'c3',
          name: 'grep',
          input: {},
          promptId: PROMPT_1,
          streamAtSec: 5,
          atSec: 6,
        }),
      ],
      chat: [
        // Only the tail survives: loops 2 (tool c3) and 3.
        chat('reasoning', { summary: [{ text: 'Search.' }] }),
        chat('assistant', {
          content: '',
          tool_calls: [{ id: 'c3', name: 'grep', arguments: '{}' }],
        }),
        chat('reasoning', { summary: [{ text: 'Done.' }] }),
        chat('assistant', { content: 'All set.' }),
      ],
    }).snapshot();
    expect(
      snap.requests.map((r) => r.blocks.find((b) => b.kind === 'thinking')?.text ?? null),
    ).toEqual([null, null, 'Search.', 'Done.']);
  });

  it('reports request detail only for the latest call, and only from records we actually have', () => {
    const parser = feed(garden());
    expect(parser.requestDetail('missing')).toBeNull();
    expect(parser.requestDetail('t0:0')).toMatchObject({
      completeness: 'unavailable',
      system: null,
      tools: null,
      messages: null,
    });
    const latest = parser.requestDetail('t1:0');
    expect(latest).toMatchObject({
      requestId: 't1:0',
      completeness: 'partial',
      system: 'You are a gardener.',
      tools: TOOL_DEFS,
      params: { model: 'grok-4.7', reasoningEffort: 'xhigh' },
    });
    expect(latest?.notes.join(' ')).toMatch(/turn/i);
    expect(JSON.stringify(latest)).not.toContain('Remember the rules');
    expect(parser.snapshot().requests.map((r) => r.hasDetail)).toEqual([false, false, true]);

    const bare = feed({
      events: [
        event('turn_started', { ts: at(0), turn_number: 0, model_id: 'grok-4.7' }),
        event('loop_started', { ts: at(1), loop_index: 0 }),
        event('turn_ended', { ts: at(2), outcome: 'completed' }),
      ],
    });
    expect(bare.requestDetail('t0:0')).toMatchObject({
      completeness: 'unavailable',
      system: null,
      tools: null,
    });
  });

  it('truncates tool previews and does not throw on an empty session', () => {
    const long = 'm'.repeat(600);
    const snap = feed({
      events: [
        event('turn_started', { ts: at(0), turn_number: 0, model_id: 'grok-4.7' }),
        event('loop_started', { ts: at(1), loop_index: 0 }),
        event('turn_ended', { ts: at(3), outcome: 'completed' }),
      ],
      updates: [
        userChunk({ text: 'Read', promptIndex: 0 }),
        toolCall({
          id: 'call-long',
          name: 'read_file',
          input: {},
          promptId: PROMPT_1,
          streamAtSec: 1,
        }),
        toolUpdate({ id: 'call-long', status: 'completed', output: long, atSec: 2 }),
      ],
    }).snapshot();
    expect(snap.toolCalls[0]?.resultPreview).toHaveLength(500);
    expect(checkSnapshot(snap)).toEqual([]);

    const empty = new GrokSessionParser(makeSource('closed')).snapshot();
    expect(empty.agents).toHaveLength(1);
    expect(empty.session.usage).toEqual(emptyUsage());
    expect(empty.session.counts).toEqual({ turns: 0, requests: 0, toolCalls: 0, agents: 1 });
    expect(checkSnapshot(empty)).toEqual([]);
  });
});

/** Too deep for JSON.stringify, which gives up between 5,000 and 8,000 levels on Node 24. */
const DEPTH = 20_000;
const DEEP_VALUES = [
  `${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}`,
  `${'{"content":'.repeat(DEPTH)}"x"${'}'.repeat(DEPTH)}`,
];
const MARK = '__deep_value__';

/** Copies of `line` with one value replaced by a deep one, for every value position. */
function deepened(line: string): string[] {
  let root: unknown;
  try {
    root = JSON.parse(line);
  } catch {
    return [];
  }
  const out: string[] = [];
  const visit = (node: unknown, set: (v: unknown) => void) => {
    set(MARK);
    const text = JSON.stringify(root);
    // Raw, and as a string holding JSON (tool arguments are parsed from one).
    for (const deep of [...DEEP_VALUES, JSON.stringify(DEEP_VALUES[0])])
      out.push(text.replace(`"${MARK}"`, deep));
    set(node);
    if (node === null || typeof node !== 'object') return;
    const holder = node as Record<string, unknown>;
    for (const key of Object.keys(holder)) {
      visit(holder[key], (v) => {
        holder[key] = v;
      });
    }
  };
  visit(root, (v) => {
    root = v;
  });
  return out;
}

/** `doc` with one value replaced by a deep one, for every value position. */
function deepenedDocs(doc: unknown): unknown[] {
  return deepened(JSON.stringify(doc)).map((text) => JSON.parse(text) as unknown);
}

describe('values nested too deep to serialise', () => {
  it('anywhere in any log line or document, neither ingesting nor snapshots throw', () => {
    const spec = garden();
    const failures: string[] = [];
    const check = (where: string, deeper: Feed) => {
      try {
        const p = feed(deeper);
        // The untouched session again: the parser still takes input afterwards.
        feedInto(p, spec);
        const snap = p.snapshot();
        for (const r of snap.requests) p.requestDetail(r.id);
        for (const t of snap.toolCalls) p.toolResult(t.id);
      } catch (err) {
        failures.push(`${where}: ${(err as Error).message}`);
      }
    };
    for (const role of ['events', 'updates', 'chat'] as const) {
      const lines = spec[role] ?? [];
      lines.forEach((original, at) => {
        for (const deep of deepened(original))
          check(`${role} ${at}`, {
            ...spec,
            [role]: [...lines.slice(0, at), deep, ...lines.slice(at + 1)],
          });
      });
    }
    for (const role of ['summary', 'usage', 'tools'] as const) {
      if (spec[role] === undefined) continue;
      for (const doc of deepenedDocs(spec[role])) check(role, { ...spec, [role]: doc });
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

function feedInto(p: GrokSessionParser, spec: Feed): void {
  if (spec.events) p.ingestLines(eventsFile, spec.events);
  if (spec.updates) p.ingestLines(updatesFile, spec.updates);
  if (spec.chat) p.ingestLines(chatFile, spec.chat);
  if (spec.summary !== undefined) p.ingestJson(summaryFile, spec.summary);
  if (spec.usage !== undefined) p.ingestJson(usageFile, spec.usage);
}

describe('malformed input never throws', () => {
  it('out-of-range timestamps in every log and document are treated as missing', () => {
    const p = new GrokSessionParser(makeSource('busy'));
    expect(() => {
      p.ingestLines(eventsFile, [
        JSON.stringify({ ts: 1e300, type: 'turn_started', turn_number: 0 }),
      ]);
      p.ingestLines(updatesFile, [
        JSON.stringify({
          timestamp: 1e300,
          method: 'session/update',
          params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'hi' } } },
        }),
      ]);
      p.ingestJson(usageFile, { turns: [{ turnNumber: 1, endedAt: 1e300, inputTokens: 5 }] });
      p.ingestJson(summaryFile, { info: { id: 'x' }, created_at: 1e300, updated_at: 1e300 });
      p.snapshot();
    }).not.toThrow();
    expect(checkSnapshot(p.snapshot())).toEqual([]);
  });

  it('documents that are not objects count as parse errors', () => {
    const p = new GrokSessionParser(makeSource('busy'));
    const ch = p.ingestJson(summaryFile, 'not a summary');
    p.ingestJson(usageFile, [1, 2]);
    expect(ch.diagnostics).toBe(true);
    expect(p.snapshot().diagnostics.parseErrors).toBe(2);
  });
});

describe('usage without model loops on record', () => {
  const two = usageDoc([
    { turnNumber: 1, atSec: 5, usage: { inputTokens: 500, outputTokens: 40, modelCalls: 2 } },
    { turnNumber: 2, atSec: 9, usage: { inputTokens: 700, outputTokens: 10 } },
  ]);

  it('a turn with usage but no loops still counts its tokens, once', () => {
    const p = feed(
      {
        events: [
          event('turn_started', { ts: at(6), turn_number: 1 }),
          event('loop_started', { ts: at(6), loop_index: 0 }),
        ],
        usage: two,
      },
      'closed',
    );
    const s = p.snapshot();
    expect(s.session.usage).toMatchObject({ input: 1200, output: 50 });
    expect(s.requests.map((r) => [r.id, r.usage?.output ?? null])).toEqual([
      ['t0:0', 40],
      ['t1:0', 10],
    ]);
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('its loops arriving later join the placeholder instead of doubling the tokens', () => {
    const p = feed({ usage: two }, 'closed');
    p.ingestLines(eventsFile, [
      event('turn_started', { ts: at(0), turn_number: 0 }),
      event('loop_started', { ts: at(1), loop_index: 0 }),
      event('loop_started', { ts: at(3), loop_index: 1 }),
      event('turn_ended', { ts: at(5), outcome: 'completed' }),
    ]);
    const s = p.snapshot();
    expect(s.session.usage?.output).toBe(50);
    expect(
      s.requests.filter((r) => r.turnId === 'turn:1').map((r) => [r.id, r.usage?.output ?? null]),
    ).toEqual([
      ['t0:0', null],
      ['t0:1', 40],
    ]);
  });

  it('turn_completed usage for a turn with no loops is counted too', () => {
    const p = feed(
      {
        updates: [
          turnCompleted({
            promptId: PROMPT_1,
            atSec: 4,
            usage: { inputTokens: 90, outputTokens: 9 },
          }),
        ],
      },
      'closed',
    );
    expect(p.snapshot().session.usage).toMatchObject({ input: 90, output: 9 });
  });
});

describe('streamed chunks', () => {
  const start = () => {
    const p = new GrokSessionParser(makeSource('busy'));
    p.ingestLines(eventsFile, [
      event('turn_started', { ts: at(0), turn_number: 0 }),
      event('loop_started', { ts: at(1), loop_index: 0 }),
    ]);
    return p;
  };
  const chunk = (text: string) =>
    modelChunk({ kind: 'message', text, promptId: PROMPT_1, streamAtSec: 1 });

  it('appends deltas and lets a chunk that repeats everything so far replace it', () => {
    const p = start();
    p.ingestLines(updatesFile, ['Hel', 'lo', ' there'].map(chunk));
    expect(p.snapshot().requests[0]?.blocks).toEqual([
      expect.objectContaining({ kind: 'text', text: 'Hello there' }),
    ]);
    p.ingestLines(updatesFile, [chunk('Hello there, friend')]);
    expect(p.snapshot().requests[0]?.blocks).toEqual([
      expect.objectContaining({ kind: 'text', text: 'Hello there, friend' }),
    ]);
  });

  it('keeps up with long streams (linear, not quadratic)', () => {
    const p = start();
    const lines = Array.from({ length: 50_000 }, (_, i) => chunk(`w${i} `));
    const t0 = performance.now();
    p.ingestLines(updatesFile, lines);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(p.snapshot().requests[0]?.blocks[0]).toMatchObject({ kind: 'text' });
  });
});

describe('diagnostics', () => {
  it('lists exactly what Grok cannot provide; compaction markers come from explicit records', () => {
    expect(new GrokSessionParser(makeSource('busy')).snapshot().diagnostics.unavailable).toEqual([
      'per-request-usage',
      'subagents',
    ]);
  });
});

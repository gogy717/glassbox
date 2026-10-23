/**
 * Values nested deeper than JSON.stringify (or any recursion) can take, at every position of
 * every record: ingesting, snapshotting and request detail must not throw.
 */
import { describe, expect, it } from 'vitest';
import {
  apiError,
  apiRequest,
  apiRequestBlob,
  apiRequestShape,
  assistantBlocks,
  at,
  interrupt,
  taskNotification,
  toolResult,
  turnDuration,
  userPrompt,
} from './__fixtures__/builders.js';
import { mainFile, parseMain } from './__fixtures__/harness.js';

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

function session(): string[] {
  return [
    userPrompt({ text: 'one', ts: at(0) }),
    apiRequestShape(),
    apiRequest({ id: 'api-1', ts: at(1) }),
    ...assistantBlocks({
      requestRef: 'api-1',
      requestId: 'req_1',
      blocks: [
        'thinking',
        { type: 'tool_use', id: 'toolu_1' },
        {
          type: 'tool_use',
          id: 'toolu_agent',
          name: 'Agent',
          input: { prompt: 'look', subagent_type: 'general-purpose' },
        },
      ],
      blockTs: [at(2), at(3), at(4)],
    }),
    toolResult({ toolUseId: 'toolu_1', ts: at(5), content: [{ type: 'text', text: 'a.txt' }] }),
    toolResult({ toolUseId: 'toolu_agent', ts: at(5), content: 'failed', isError: true }),
    apiRequestBlob({ hash: 'a'.repeat(64), message: { role: 'user', content: 'blob' } }),
    // A tail hash that is no blob: the detail store hashes transcript messages to find it.
    apiRequest({
      id: 'api-2',
      ts: at(6),
      base: 'api-1',
      keep: 1,
      tail: ['a'.repeat(64), 'f'.repeat(64)],
    }),
    ...assistantBlocks({
      requestRef: 'api-2',
      requestId: 'req_2',
      blocks: ['text'],
      blockTs: [at(8)],
    }),
    turnDuration({ ts: at(8.2) }),
    userPrompt({ text: 'two', ts: at(10) }),
    apiRequest({ id: 'api-3', ts: at(11) }),
    interrupt({ ts: at(14) }),
    taskNotification({ taskId: 'bg-1', ts: at(20) }),
    apiError({ ts: at(22) }),
  ].flat();
}

describe('values nested too deep to serialise', () => {
  it('anywhere in any record, neither ingesting, snapshots nor request detail throw', () => {
    const lines = session();
    const failures: string[] = [];
    lines.forEach((original, at) => {
      for (const deep of deepened(original)) {
        try {
          const p = parseMain(...lines.slice(0, at), deep);
          p.ingestLines(mainFile, lines.slice(at + 1));
          const snap = p.snapshot();
          for (const r of snap.requests) p.requestDetail(r.id);
          for (const t of snap.toolCalls) p.toolResult(t.id);
        } catch (err) {
          failures.push(`line ${at}: ${(err as Error).message}`);
        }
      }
    });
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

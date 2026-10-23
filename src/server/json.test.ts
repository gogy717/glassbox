import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { capDepth, MAX_JSON_DEPTH, stringifyDeep, TOO_DEEP, toJson } from './json.js';

/** `levels` arrays, one inside the other, around `leaf`. */
function nest(levels: number, leaf: unknown): unknown {
  let v = leaf;
  for (let i = 0; i < levels; i++) v = [v];
  return v;
}

/** Deepest array/object nesting in a JSON text. */
function depthOf(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') max = Math.max(max, ++depth);
    else if (ch === ']' || ch === '}') depth--;
  }
  return max;
}

/** Values whose JSON both writers must reproduce exactly. */
const ORDINARY: unknown[] = [
  { a: 1, b: 'two', c: [true, null, 3.5, -0], d: { e: 'é ✓ "quoted" \\ \n  \ud800' } },
  [1, undefined, () => 1, Number.NaN, Number.POSITIVE_INFINITY, new Array(2)],
  { skipped: undefined, fn: () => 1, sym: Symbol('s'), at: new Date(0), list: [] },
  { boxed: [new Number(1), new String('s'), new Boolean(false)] },
  {
    gone: { toJSON: () => undefined },
    key: { toJSON: (k: string) => k },
    list: [{ toJSON: (k: string) => k }],
  },
  JSON.parse('{"__proto__":{"x":1},"y":[]}'),
  'just a string',
  42,
  null,
  // Exactly at the limit: nothing is cut.
  nest(MAX_JSON_DEPTH, 'leaf'),
  nest(MAX_JSON_DEPTH - 1, {}),
  // A Date is written as a string, so it adds no level.
  nest(MAX_JSON_DEPTH, new Date(0)),
];

describe('toJson', () => {
  it('writes ordinary values byte for byte as JSON.stringify does', () => {
    for (const v of ORDINARY) expect(toJson(v)).toBe(JSON.stringify(v));
  });

  it('writes the marker in place of a container one level past the limit', () => {
    expect(toJson(nest(MAX_JSON_DEPTH + 1, 'leaf'))).toBe(
      JSON.stringify(nest(MAX_JSON_DEPTH, TOO_DEEP)),
    );
    expect(TOO_DEEP).toBe('[nested deeper than 256 levels]');
  });

  it('cuts a value too deep for JSON.stringify to parseable JSON 256 levels deep', () => {
    const depth = 20_000;
    const deep = JSON.parse(`${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`);
    expect(() => JSON.stringify(deep)).toThrow(RangeError);

    const out = toJson({ input: deep });
    // The wrapper is level 1, so 255 levels of `deep` fit and its 256th is cut.
    expect(out).toBe(
      `{"input":${'{"a":'.repeat(MAX_JSON_DEPTH - 1)}${JSON.stringify(TOO_DEEP)}${'}'.repeat(MAX_JSON_DEPTH)}`,
    );
    expect(depthOf(out)).toBe(MAX_JSON_DEPTH);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('keeps the shallow parts around a deep value, and leaves the value itself untouched', () => {
    const value = { before: { x: [1, 2] }, deep: nest(MAX_JSON_DEPTH + 10, 1), after: 'z' };
    const before = JSON.stringify(value);

    const out = JSON.parse(toJson(value));
    expect(out.before).toEqual({ x: [1, 2] });
    expect(out.after).toBe('z');
    expect(Object.keys(out)).toEqual(['before', 'deep', 'after']);
    expect(JSON.stringify(value)).toBe(before);
  });

  it('cuts a deep value under a "__proto__" key without losing the key', () => {
    const value = JSON.parse(`{"__proto__":${JSON.stringify(nest(MAX_JSON_DEPTH + 5, 1))}}`);
    const out = toJson(value);
    expect(out.startsWith('{"__proto__":[[')).toBe(true);
    expect(depthOf(out)).toBe(MAX_JSON_DEPTH);
    expect(Object.hasOwn(JSON.parse(out), '__proto__')).toBe(true);
  });

  it('counts the levels of what toJSON returns, as JSON.stringify writes that', () => {
    const out = toJson({ when: { toJSON: () => nest(MAX_JSON_DEPTH, 1) } });
    expect(depthOf(out)).toBe(MAX_JSON_DEPTH);
    expect(out).toContain(JSON.stringify(TOO_DEEP));
  });
});

describe('server responses', () => {
  it('are all written by toJson', async () => {
    // Hono's c.json, or JSON.stringify straight into an event, would skip the cap.
    const dir = dirname(fileURLToPath(import.meta.url));
    const sources = (await readdir(dir, { recursive: true })).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('__tests__'),
    );
    const offenders: string[] = [];
    for (const f of sources) {
      const src = await readFile(join(dir, f), 'utf8');
      if (/\bc\.json\b|writeSSE\([^)]*JSON\.stringify/s.test(src)) offenders.push(f);
    }
    expect(sources.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});

describe('capDepth', () => {
  it('returns the value itself when it is within the cap, a cut copy when not', () => {
    const shallow = { a: [1, { b: 2 }] };
    expect(capDepth(shallow)).toBe(shallow);
    const deep = nest(MAX_JSON_DEPTH + 1, 'leaf');
    const cut = capDepth(deep);
    expect(cut).not.toBe(deep);
    expect(JSON.stringify(cut)).toBe(JSON.stringify(nest(MAX_JSON_DEPTH, TOO_DEEP)));
  });
});

describe('stringifyDeep', () => {
  const DEPTH = 20_000;

  it('writes ordinary values byte for byte as JSON.stringify does', () => {
    for (const v of ORDINARY) expect(stringifyDeep(v)).toBe(JSON.stringify(v));
    expect(stringifyDeep(undefined)).toBeUndefined();
  });

  it('writes a value too deep for JSON.stringify, all of it', () => {
    const text = `${'{"a":['.repeat(DEPTH)}"✓\\n"${']}'.repeat(DEPTH)}`;
    const value = JSON.parse(text);
    expect(() => JSON.stringify(value)).toThrow(RangeError);
    expect(stringifyDeep(value)).toBe(text);
  });

  it('leaves out and nulls what JSON.stringify does, however deep', () => {
    let value: unknown = new Date(0);
    let text = JSON.stringify(value);
    for (let i = 0; i < DEPTH; i++) {
      value = { skipped: undefined, a: [undefined, value, () => 1], fn: () => 1 };
      text = `{"a":[null,${text},null]}`;
    }
    expect(stringifyDeep(value)).toBe(text);
  });

  it('refuses a cycle, as JSON.stringify does', () => {
    const a: Record<string, unknown> = {};
    a.child = { back: a };
    expect(() => stringifyDeep(a)).toThrow(/circular structure/);
  });
});

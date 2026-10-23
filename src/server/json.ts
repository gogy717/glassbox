import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Deepest array/object nesting the server writes. */
export const MAX_JSON_DEPTH = 256;
/** Written in place of an array or object nested deeper than `MAX_JSON_DEPTH`. */
export const TOO_DEEP = `[nested deeper than ${MAX_JSON_DEPTH} levels]`;

/**
 * JSON.stringify for everything the server sends, with nesting capped at `MAX_JSON_DEPTH`
 * levels: a deeper array or object is written as `TOO_DEEP`. Transcripts are untrusted, and a
 * value a few thousand levels deep (a few KB, fine for JSON.parse) overflows the stack of
 * JSON.stringify here and of recursive renderers in the browser. Within the cap the output is
 * exactly JSON.stringify's.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(capDepth(value));
}

/**
 * What `toJson` writes, as a value: `value` itself when it nests at most `MAX_JSON_DEPTH`
 * levels, else a copy whose deeper arrays and objects are `TOO_DEEP`.
 */
export function capDepth(value: unknown): unknown {
  return capped(value, '', 0);
}

/** A JSON response written by `toJson`, with the headers Hono's own json() sets. */
export function jsonResponse<T>(c: Context, body: T, status?: ContentfulStatusCode): Response {
  return c.body(toJson(body), status, { 'Content-Type': 'application/json' });
}

/**
 * `value` itself when nothing in it is nested too deep, else a copy with the deep parts
 * replaced. `depth` counts the containers around `value`; recursion stops at the cap, so it
 * cannot overflow the stack however deep the value goes.
 */
function capped(value: unknown, key: string | number, depth: number): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON !== 'function') return cappedContainer(value, depth);
  // JSON.stringify writes what toJSON returns (e.g. a Date's string), so cap that.
  const json = toJSON.call(value, String(key));
  const out = typeof json === 'object' && json !== null ? cappedContainer(json, depth) : json;
  return out === json ? value : out;
}

function cappedContainer(value: object, depth: number): unknown {
  if (depth === MAX_JSON_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      if (typeof item !== 'object' || item === null) continue;
      const out = capped(item, i, depth + 1);
      if (out === item) continue;
      copy ??= value.slice();
      copy[i] = out;
    }
    return copy ?? value;
  }
  const record = value as Record<string, unknown>;
  let copy: Record<string, unknown> | null = null;
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (typeof item !== 'object' || item === null) continue;
    const out = capped(item, key, depth + 1);
    if (out === item) continue;
    // Spread keeps an own "__proto__" key as data, so assigning to it sets the copy's own key.
    copy ??= { ...record };
    copy[key] = out;
  }
  return copy ?? value;
}

type Frame =
  | { kind: 'array'; value: unknown[]; length: number; next: number }
  | {
      kind: 'object';
      value: Record<string, unknown>;
      keys: string[];
      next: number;
      empty: boolean;
    };

/**
 * Exactly what JSON.stringify writes (without replacer or indent), but iteratively, so no depth
 * overflows it: for a value too deep for JSON.stringify that must still go out whole, such as a
 * tool input echoed back to Claude Code. Slower, so only for that.
 */
export function stringifyDeep(value: unknown): string | undefined {
  const out: string[] = [];
  const stack: Frame[] = [];
  /** Containers being written, to refuse a cycle as JSON.stringify does. */
  const open = new Set<object>();

  /** Writes a value, or opens a container; false when JSON has nothing for it. */
  const write = (raw: unknown, key: string): boolean => {
    const v = jsonValue(raw, key);
    if (typeof v !== 'object' || v === null) {
      const text = JSON.stringify(v);
      if (text === undefined) return false;
      out.push(text);
      return true;
    }
    if (open.has(v)) throw new TypeError('Converting circular structure to JSON');
    open.add(v);
    if (Array.isArray(v)) {
      out.push('[');
      stack.push({ kind: 'array', value: v, length: v.length, next: 0 });
    } else {
      const record = v as Record<string, unknown>;
      out.push('{');
      stack.push({
        kind: 'object',
        value: record,
        keys: Object.keys(record),
        next: 0,
        empty: true,
      });
    }
    return true;
  };

  if (!write(value, '')) return undefined;
  for (let top = stack.at(-1); top; top = stack.at(-1)) {
    if (top.kind === 'array') {
      if (top.next < top.length) {
        const i = top.next++;
        if (i > 0) out.push(',');
        if (!write(top.value[i], String(i))) out.push('null');
        continue;
      }
      out.push(']');
    } else {
      if (top.next < top.keys.length) {
        const key = top.keys[top.next++] as string;
        const at = out.length;
        out.push(top.empty ? '' : ',', JSON.stringify(key), ':');
        if (write(top.value[key], key)) top.empty = false;
        else out.length = at;
        continue;
      }
      out.push('}');
    }
    stack.pop();
    open.delete(top.value);
  }
  return out.join('');
}

/** What JSON.stringify writes in place of `value`: toJSON's result, a boxed primitive unboxed. */
function jsonValue(value: unknown, key: string): unknown {
  let v = value;
  if (typeof v === 'object' && v !== null) {
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') v = toJSON.call(v, key);
  }
  if (v instanceof Number) return Number(v);
  if (v instanceof String) return String(v);
  if (v instanceof Boolean) return v.valueOf();
  return v;
}

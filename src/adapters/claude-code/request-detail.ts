/**
 * Rebuilds what a request actually sent (Claude Code ≥ 2.1.300).
 *
 * `api-request` records delta-encode messages[]: messages(r) = messages(r.base)[0:keep] ++ tail,
 * where each tail entry is sha256(sorted-key compact JSON) of one message. A hash resolves to
 * an `api-request-blob`, or to a message reconstructed from the transcript: a user record's
 * message, the merged content of all assistant records of one request, a single assistant
 * record, or a merged run of consecutive user records. Transcript candidates are hashed lazily,
 * only when a lookup misses, because most sessions never have their detail opened.
 */
import { createHash } from 'node:crypto';
import type { RequestDetail } from '../../core/model.js';

/**
 * Nesting followed when hashing. A deeper message (Claude Code could not serialise it either)
 * hashes to a value no record names, and stays unresolved instead of overflowing the stack.
 */
const HASH_DEPTH = 256;

export function stableStringify(v: unknown, depth = 0): string {
  if (depth > HASH_DEPTH && v !== null && typeof v === 'object') return '"[nested too deep]"';
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x ?? null, depth + 1)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k], depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function hashMessage(message: unknown): string {
  return createHash('sha256').update(stableStringify(message)).digest('hex');
}

interface ApiRequestEntry {
  base: string | null;
  keep: number;
  tail: string[];
  params: unknown;
  shapeHash: string | null;
}

interface Built {
  messages: unknown[];
  unresolved: number;
  missingBase: boolean;
}

const UNAVAILABLE_NOTE = 'This Claude Code version did not record the request';

const asBlocks = (content: unknown): unknown[] =>
  typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content)
      ? content
      : [];

export class RequestDetailStore {
  private readonly shapes = new Map<string, { system: unknown; tools: unknown[] | null }>();
  private readonly blobs = new Map<string, unknown>();
  private readonly requests = new Map<string, ApiRequestEntry>();
  private readonly memo = new Map<string, Built>();

  /** hash → message, for transcript candidates hashed so far. */
  private readonly index = new Map<string, unknown>();
  /** Candidates not hashed yet, in arrival order. */
  private pending: unknown[] = [];
  /** Assistant content per request key, in block order; re-hashed when it grows. */
  private readonly assistant = new Map<string, Map<number, unknown>>();
  private readonly dirtyAssistant = new Set<string>();
  /** The open run of consecutive user messages, per transcript file. */
  private readonly userRuns = new Map<string, unknown[]>();

  addShape(shapeHash: string, system: unknown, tools: unknown[] | null): void {
    this.shapes.set(shapeHash, { system, tools });
  }

  addBlob(hash: string, message: unknown): void {
    this.blobs.set(hash, message);
  }

  addRequest(id: string, entry: ApiRequestEntry): void {
    if (!this.requests.has(id)) this.requests.set(id, entry);
  }

  has(id: string): boolean {
    return this.requests.has(id);
  }

  addUser(file: string, message: unknown): void {
    if (message === undefined) return;
    this.pending.push(message);
    const run = this.userRuns.get(file) ?? [];
    run.push(message);
    this.userRuns.set(file, run);
  }

  /** `position` is `apiBlockIndex`; null appends after the blocks seen so far. */
  addAssistant(
    file: string,
    key: string | null,
    position: number | null,
    content: unknown[],
  ): void {
    this.closeUserRun(file);
    this.pending.push({ role: 'assistant', content });
    if (key === null) return;
    const blocks = this.assistant.get(key) ?? new Map<number, unknown>();
    const base = position ?? 1_000_000 + blocks.size;
    content.forEach((block, j) => {
      blocks.set(base * 100 + j, block);
    });
    this.assistant.set(key, blocks);
    this.dirtyAssistant.add(key);
  }

  private closeUserRun(file: string): void {
    const run = this.userRuns.get(file);
    if (run && run.length > 1) {
      const content = run.flatMap((m) => asBlocks((m as { content?: unknown })?.content));
      this.pending.push({ role: 'user', content });
    }
    this.userRuns.delete(file);
  }

  private resolve(hash: string): unknown {
    const found = this.blobs.get(hash) ?? this.index.get(hash);
    if (found !== undefined) return found;
    this.refreshIndex();
    return this.blobs.get(hash) ?? this.index.get(hash);
  }

  private refreshIndex(): void {
    for (const m of this.pending) this.index.set(hashMessage(m), m);
    this.pending = [];
    for (const key of this.dirtyAssistant) {
      const blocks = this.assistant.get(key);
      if (!blocks) continue;
      const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
      const message = { role: 'assistant', content };
      this.index.set(hashMessage(message), message);
    }
    this.dirtyAssistant.clear();
    // Runs still open at the end of a file are candidates too, but may still grow.
    for (const run of this.userRuns.values()) {
      if (run.length < 2) continue;
      const message = {
        role: 'user',
        content: run.flatMap((m) => asBlocks((m as { content?: unknown })?.content)),
      };
      this.index.set(hashMessage(message), message);
    }
  }

  private build(id: string): Built {
    // Walk the base chain iteratively: chains can be thousands of requests long.
    const chain: string[] = [];
    let cursor: string | null = id;
    while (cursor !== null && !this.memo.has(cursor) && this.requests.has(cursor)) {
      chain.push(cursor);
      cursor = this.requests.get(cursor)?.base ?? null;
    }
    let built: Built =
      cursor !== null && this.memo.has(cursor)
        ? (this.memo.get(cursor) as Built)
        : { messages: [], unresolved: 0, missingBase: cursor !== null };
    for (const rid of chain.reverse()) {
      const r = this.requests.get(rid) as ApiRequestEntry;
      const kept = built.messages.slice(0, r.keep);
      let unresolved = built.unresolved;
      let missingBase = built.missingBase;
      if (r.base !== null && !this.requests.has(r.base)) {
        missingBase = true;
        if (r.keep > 0) kept.push({ unresolved: `base:${r.base}`, messages: r.keep });
      }
      const tail = r.tail.map((h) => {
        const m = this.resolve(h);
        if (m !== undefined) return m;
        unresolved += 1;
        return { unresolved: h };
      });
      built = { messages: [...kept, ...tail], unresolved, missingBase };
      // Only memoise complete results: a later record may still resolve a missing hash.
      if (unresolved === 0 && !missingBase) this.memo.set(rid, built);
    }
    return built;
  }

  detail(id: string): RequestDetail {
    const r = this.requests.get(id);
    if (!r) {
      return {
        requestId: id,
        completeness: 'unavailable',
        notes: [UNAVAILABLE_NOTE],
        params: null,
        system: null,
        tools: null,
        messages: null,
      };
    }
    const built = this.build(id);
    const shape = r.shapeHash ? this.shapes.get(r.shapeHash) : undefined;
    const notes: string[] = [];
    if (built.unresolved > 0) {
      const n = built.unresolved;
      notes.push(
        `${n} message${n === 1 ? '' : 's'} could not be reconstructed from the transcript`,
      );
    }
    if (built.missingBase)
      notes.push(
        'The request this one builds on is missing from the transcript, so its first messages could not be reconstructed',
      );
    if (!shape) notes.push('The system prompt and tool definitions were not recorded');
    return {
      requestId: id,
      completeness: notes.length === 0 ? 'full' : 'partial',
      notes,
      params: r.params ?? null,
      system: shape?.system ?? null,
      tools: shape?.tools ?? null,
      messages: built.messages,
    };
  }
}

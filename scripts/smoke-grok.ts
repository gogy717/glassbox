/**
 * Local real-data smoke check for the Grok Build adapter.
 *
 *   npx tsx scripts/smoke-grok.ts [--grok-dir PATH] [--replay]
 *
 * Parses every local Grok session the way the server does. It prints ONLY ids, counts, token
 * totals, timings, invariant problem counts and record type names: never transcript content.
 * It only reads files under the Grok dir (sessions, active_sessions.json, version.json).
 *
 * --replay also feeds every line on its own, applies each patch to a client-side store and
 * compares the store with a fresh snapshot after every step: the number of stale entities a
 * live UI would have shown (must be 0).
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGrokAdapter } from '../src/adapters/grok/index.js';
import type { SessionParser, SourceFile } from '../src/core/adapter.js';
import { checkSnapshot } from '../src/core/invariants.js';
import { totalTokens } from '../src/core/usage.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const grokDir = arg('--grok-dir') ?? process.env.GROK_HOME ?? join(homedir(), '.grok');
const replay = process.argv.includes('--replay');
const adapter = createGrokAdapter({ grokDir });
const KINDS = ['agents', 'turns', 'requests', 'toolCalls', 'workflows'] as const;

type Step = { file: SourceFile; lines?: string[]; json?: unknown };

/** Patches applied in order must reproduce the snapshot after every step. */
function staleCount(parser: SessionParser, steps: Step[]): number {
  const first = parser.snapshot();
  const store = Object.fromEntries(
    KINDS.map((k) => [k, new Map<string, string>(first[k].map((e) => [e.id, JSON.stringify(e)]))]),
  ) as Record<(typeof KINDS)[number], Map<string, string>>;
  let stale = 0;
  for (const step of steps) {
    const ch = step.lines
      ? parser.ingestLines(step.file, step.lines)
      : parser.ingestJson(step.file, step.json);
    const patch = parser.patch(ch);
    for (const k of KINDS) {
      for (const e of patch[k]) store[k].set(e.id, JSON.stringify(e));
      for (const id of patch.removed?.[k] ?? []) store[k].delete(id);
    }
    const fresh = parser.snapshot();
    for (const k of KINDS) {
      for (const e of fresh[k]) {
        const now = JSON.stringify(e);
        if (store[k].get(e.id) !== now) {
          stale += 1;
          store[k].set(e.id, now);
        }
      }
    }
  }
  return stale;
}

const sources = (await adapter.discover()).sort((a, b) =>
  b.summary.updatedAt.localeCompare(a.summary.updatedAt),
);
const totals = { sessions: 0, crashes: 0, problems: 0, stale: 0, requests: 0, tokens: 0 };

for (const source of sources) {
  const id = source.nativeId.slice(0, 8);
  try {
    const t0 = performance.now();
    const files = await adapter.listFiles(source);
    const steps: Step[] = [];
    for (const file of files) {
      const text = await readFile(file.path, 'utf8');
      if (file.format === 'jsonl') {
        const lines = text.split('\n').filter(Boolean);
        if (replay) for (const line of lines) steps.push({ file, lines: [line] });
        else steps.push({ file, lines });
      } else {
        try {
          steps.push({ file, json: JSON.parse(text) });
        } catch {
          // A json file mid-write: the server would retry.
        }
      }
    }
    const parser = adapter.createParser(source);
    const stale = replay ? staleCount(parser, steps) : 0;
    if (!replay)
      for (const s of steps) {
        if (s.lines) parser.ingestLines(s.file, s.lines);
        else parser.ingestJson(s.file, s.json);
      }
    parser.setLive(source.summary.live);
    const snap = parser.snapshot();
    const problems = checkSnapshot(snap).length;
    const tokens = snap.session.usage ? totalTokens(snap.session.usage) : 0;
    totals.sessions += 1;
    totals.problems += problems;
    totals.stale += stale;
    totals.requests += snap.requests.length;
    totals.tokens += tokens;
    const c = snap.session.counts;
    const unknown = Object.entries(snap.diagnostics.unknownRecordTypes);
    console.log(
      [
        id,
        `live=${source.summary.live}`,
        `turns=${c?.turns} requests=${c?.requests} tools=${c?.toolCalls}`,
        `tokens=${tokens}`,
        `in-flight=${snap.requests.filter((r) => r.status === 'in-flight').length}`,
        `compacted=${snap.requests.filter((r) => r.compactedBefore).length}`,
        `parse=${(performance.now() - t0).toFixed(0)}ms`,
        `problems=${problems}`,
        replay ? `stale=${stale}` : '',
        `parseErrors=${snap.diagnostics.parseErrors}`,
        unknown.length ? `unknown=${unknown.map(([t, n]) => `${t}:${n}`).join(',')}` : '',
      ]
        .filter(Boolean)
        .join('  '),
    );
  } catch (err) {
    totals.crashes += 1;
    console.log(`${id}  CRASH ${(err as Error).name}: ${(err as Error).message.slice(0, 200)}`);
  }
}

console.log('---');
console.log(
  `sessions=${totals.sessions} crashes=${totals.crashes} problems=${totals.problems}` +
    `${replay ? ` stale=${totals.stale}` : ''} requests=${totals.requests} tokens=${totals.tokens}`,
);
if (totals.crashes > 0 || totals.problems > 0 || totals.stale > 0) process.exitCode = 1;

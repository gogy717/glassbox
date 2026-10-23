/**
 * Local real-data smoke check for the Claude Code adapter.
 *
 *   npx tsx scripts/smoke-claude.ts [--limit N] [--claude-dir PATH]
 *
 * Parses every local session the way the server does and prints ONLY numbers and ids:
 * session id prefix, version, entity counts, total tokens, parse time, invariant problem
 * count, request-detail completeness and unknown record type names. It never prints
 * transcript content, and it only reads files.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { checkSnapshot } from '../src/core/invariants.js';
import { totalTokens } from '../src/core/usage.js';

/** Same feed order as the server, so parents are usually known before their children. */
const ORDER = [
  'main',
  'subagent-meta',
  'subagent',
  'workflow-state',
  'workflow-journal',
  'workflow-agent-meta',
  'workflow-agent',
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const limit = Number(arg('--limit') ?? Number.POSITIVE_INFINITY);
const claudeDir =
  arg('--claude-dir') ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const adapter = createClaudeCodeAdapter({ claudeDir });

const sources = (await adapter.discover())
  .sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt))
  .slice(0, limit);

const totals = { sessions: 0, crashes: 0, problems: 0, requests: 0, tokens: 0, ms: 0 };
const detail = { full: 0, partial: 0, unavailable: 0 };
const unknownTypes: Record<string, number> = {};

for (const source of sources) {
  const id = source.nativeId.slice(0, 8);
  try {
    const t0 = performance.now();
    const parser = adapter.createParser(source);
    const files = (await adapter.listFiles(source)).sort(
      (a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role),
    );
    for (const file of files) {
      const text = await readFile(file.path, 'utf8');
      if (file.format === 'jsonl') parser.ingestLines(file, text.split('\n').filter(Boolean));
      else {
        try {
          parser.ingestJson(file, JSON.parse(text));
        } catch {
          // A json file mid-write: the server would retry; nothing to check here.
        }
      }
    }
    parser.setLive(source.summary.live);
    const snap = parser.snapshot();
    const ms = performance.now() - t0;
    for (const r of snap.requests) {
      const d = parser.requestDetail(r.id);
      if (d) detail[d.completeness] += 1;
    }
    const problems = checkSnapshot(snap).length;
    const tokens = snap.session.usage ? totalTokens(snap.session.usage) : 0;
    const unknown = Object.entries(snap.diagnostics.unknownRecordTypes);
    for (const [type, n] of unknown) unknownTypes[type] = (unknownTypes[type] ?? 0) + n;
    totals.sessions += 1;
    totals.problems += problems;
    totals.requests += snap.requests.length;
    totals.tokens += tokens;
    totals.ms += ms;
    const c = snap.session.counts;
    console.log(
      [
        id,
        `v${snap.session.version ?? '?'}`,
        `agents=${c?.agents} turns=${c?.turns} requests=${c?.requests} tools=${c?.toolCalls}`,
        `workflows=${snap.workflows.length}`,
        `tokens=${tokens}`,
        `parse=${ms.toFixed(0)}ms`,
        `problems=${problems}`,
        `parseErrors=${snap.diagnostics.parseErrors}`,
        unknown.length ? `unknown=${unknown.map(([t, n]) => `${t}:${n}`).join(',')}` : '',
      ]
        .filter(Boolean)
        .join('  '),
    );
  } catch (err) {
    totals.crashes += 1;
    // The error class and message come from glassbox code, not from transcript content.
    console.log(`${id}  CRASH ${(err as Error).name}: ${(err as Error).message.slice(0, 200)}`);
  }
}

console.log('---');
console.log(
  `sessions=${totals.sessions} crashes=${totals.crashes} problems=${totals.problems} ` +
    `requests=${totals.requests} tokens=${totals.tokens} parse=${totals.ms.toFixed(0)}ms`,
);
console.log(
  `detail full=${detail.full} partial=${detail.partial} unavailable=${detail.unavailable}`,
);
console.log(`unknown record types: ${JSON.stringify(unknownTypes)}`);
if (totals.crashes > 0 || totals.problems > 0) process.exitCode = 1;

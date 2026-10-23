/** Feeds a parser the way the server will: jsonl lines for one rollout file at a time. */
import type { SessionSource, SourceFile } from '../../../core/adapter.js';
import type { LiveState } from '../../../core/model.js';
import { CodexSessionParser } from '../parser.js';
import { at, CWD, SESSION_ID } from './builders.js';

export const ROLLOUT_PATH = `/home/u/.codex/sessions/2026/01/01/rollout-${SESSION_ID}.jsonl`;

export function makeSource(live: LiveState = 'closed'): SessionSource {
  return {
    agent: 'codex',
    nativeId: SESSION_ID,
    location: ROLLOUT_PATH,
    summary: {
      id: `codex:${SESSION_ID}`,
      agent: 'codex',
      nativeId: SESSION_ID,
      title: 'Garden plan',
      cwd: CWD,
      project: 'garden',
      startedAt: at(0),
      updatedAt: at(0),
      live,
      version: null,
      model: null,
      usage: null,
      counts: null,
    },
  };
}

export function rolloutFile(role: string, name: string): SourceFile {
  return {
    path: `${ROLLOUT_PATH}.${name}`,
    format: 'jsonl',
    role,
    agentId: null,
    workflowRunId: null,
  };
}

export const mainFile = rolloutFile('rollout', 'main');
export const childFile = rolloutFile('subagent', 'child');

export function feed(
  lines: string[],
  extras: { file: SourceFile; lines: string[] }[] = [],
  live: LiveState = 'closed',
): CodexSessionParser {
  const parser = new CodexSessionParser(makeSource(live));
  parser.ingestLines(mainFile, lines);
  for (const extra of extras) parser.ingestLines(extra.file, extra.lines);
  return parser;
}

export type ReplayStep = { file: SourceFile; lines: string[] } | { live: LiveState };

const KINDS = ['agents', 'turns', 'requests', 'toolCalls', 'workflows'] as const;

/**
 * Feeds `steps` one line at a time, applies every `patch()` to a client-side store the way the
 * UI does, and after each step compares that store with a fresh `snapshot()`. Returns every
 * difference: an entity whose view changed but that no change set reported.
 */
export function replayChecked(
  steps: ReplayStep[],
  live: LiveState = 'busy',
): { parser: CodexSessionParser; problems: string[] } {
  const parser = new CodexSessionParser(makeSource(live));
  const first = parser.snapshot();
  const store = Object.fromEntries(
    KINDS.map((k) => [k, new Map<string, unknown>(first[k].map((e) => [e.id, e]))]),
  ) as Record<(typeof KINDS)[number], Map<string, unknown>>;
  let session: unknown = first.session;
  let diagnostics: unknown = first.diagnostics;
  const problems: string[] = [];
  const atoms = steps.flatMap((s): ReplayStep[] =>
    'lines' in s ? s.lines.map((line) => ({ file: s.file, lines: [line] })) : [s],
  );
  atoms.forEach((step, i) => {
    const ch =
      'live' in step ? parser.setLive(step.live) : parser.ingestLines(step.file, step.lines);
    const patch = parser.patch(ch);
    session = patch.session;
    if (patch.diagnostics) diagnostics = patch.diagnostics;
    for (const k of KINDS) {
      for (const e of patch[k]) store[k].set(e.id, e);
      for (const id of patch.removed?.[k] ?? []) store[k].delete(id);
    }
    const fresh = parser.snapshot();
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(session, fresh.session)) problems.push(`step ${i}: session stale`);
    if (!same(diagnostics, fresh.diagnostics)) problems.push(`step ${i}: diagnostics stale`);
    for (const k of KINDS) {
      const ids = new Set(fresh[k].map((e) => e.id));
      for (const e of fresh[k])
        if (!same(store[k].get(e.id), e)) problems.push(`step ${i}: ${k} ${e.id} stale`);
      for (const id of store[k].keys())
        if (!ids.has(id)) problems.push(`step ${i}: ${k} ${id} should be removed`);
    }
  });
  return { parser, problems };
}

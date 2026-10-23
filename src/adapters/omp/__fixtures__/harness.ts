/** Feeds a parser the way the server will: jsonl lines for one session file at a time. */
import type { SessionSource, SourceFile } from '../../../core/adapter.js';
import type { LiveState } from '../../../core/model.js';
import { type OmpParserOptions, OmpSessionParser } from '../parser.js';
import { at, CWD, SESSION_ID } from './builders.js';

export const SESSION_PATH = `/home/user/.omp/agent/sessions/-work-garden/2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`;
export const SESSION_STEM = SESSION_PATH.slice(0, -'.jsonl'.length);

export function makeSource(live: LiveState = 'closed'): SessionSource {
  return {
    agent: 'oh-my-pi',
    nativeId: SESSION_ID,
    location: SESSION_PATH,
    summary: {
      id: `oh-my-pi:${SESSION_ID}`,
      agent: 'oh-my-pi',
      nativeId: SESSION_ID,
      title: null,
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

export const mainFile: SourceFile = {
  path: SESSION_PATH,
  format: 'jsonl',
  role: 'main',
  agentId: null,
  workflowRunId: null,
};

/** A sub-agent's session file; `id` is its path below the session dir (`Scout/Helper`). */
export function subFile(id: string): SourceFile {
  return {
    path: `${SESSION_STEM}/${id}.jsonl`,
    format: 'jsonl',
    role: 'subagent',
    agentId: id,
    workflowRunId: null,
  };
}

export function feed(
  lines: string[],
  extras: { file: SourceFile; lines: string[] }[] = [],
  live: LiveState = 'closed',
  options: OmpParserOptions = {},
): OmpSessionParser {
  const parser = new OmpSessionParser(makeSource(live), options);
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
): { parser: OmpSessionParser; problems: string[] } {
  const parser = new OmpSessionParser(makeSource(live));
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

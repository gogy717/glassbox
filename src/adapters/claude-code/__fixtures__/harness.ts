/** Test plumbing: a SessionSource and SourceFiles for a synthetic session, and a feeder. */
import type { SessionParser, SessionSource, SourceFile } from '../../../core/adapter.js';
import type { LiveState } from '../../../core/model.js';
import { ClaudeSessionParser } from '../parser.js';
import { at, CWD, SESSION_ID } from './builders.js';

export const PROJECT_DIR = '/home/u/.claude/projects/-work-demo-project';
export const SESSION_DIR = `${PROJECT_DIR}/${SESSION_ID}`;

export function makeSource(nativeId = SESSION_ID): SessionSource {
  return {
    agent: 'claude-code',
    nativeId,
    location: `${PROJECT_DIR}/${nativeId}.jsonl`,
    summary: {
      id: `claude-code:${nativeId}`,
      agent: 'claude-code',
      nativeId,
      title: null,
      cwd: CWD,
      project: 'demo-project',
      startedAt: at(0),
      updatedAt: at(0),
      live: 'unknown',
      version: null,
      model: null,
      usage: null,
      counts: null,
    },
  };
}

export const mainFile: SourceFile = {
  path: `${PROJECT_DIR}/${SESSION_ID}.jsonl`,
  format: 'jsonl',
  role: 'main',
  agentId: null,
  workflowRunId: null,
};

export function subagentFile(agentId: string): SourceFile {
  return {
    path: `${SESSION_DIR}/subagents/agent-${agentId}.jsonl`,
    format: 'jsonl',
    role: 'subagent',
    agentId,
    workflowRunId: null,
  };
}

export function subagentMetaFile(agentId: string): SourceFile {
  return {
    path: `${SESSION_DIR}/subagents/agent-${agentId}.meta.json`,
    format: 'json',
    role: 'subagent-meta',
    agentId,
    workflowRunId: null,
  };
}

export function journalFile(runId: string): SourceFile {
  return {
    path: `${SESSION_DIR}/subagents/workflows/wf_${runId}/journal.jsonl`,
    format: 'jsonl',
    role: 'workflow-journal',
    agentId: null,
    workflowRunId: runId,
  };
}

export function workflowAgentFile(runId: string, agentId: string): SourceFile {
  return {
    path: `${SESSION_DIR}/subagents/workflows/wf_${runId}/agent-${agentId}.jsonl`,
    format: 'jsonl',
    role: 'workflow-agent',
    agentId,
    workflowRunId: runId,
  };
}

export function workflowAgentMetaFile(runId: string, agentId: string): SourceFile {
  return {
    path: `${SESSION_DIR}/subagents/workflows/wf_${runId}/agent-${agentId}.meta.json`,
    format: 'json',
    role: 'workflow-agent-meta',
    agentId,
    workflowRunId: runId,
  };
}

export function workflowStateFile(runId: string): SourceFile {
  return {
    path: `${SESSION_DIR}/workflows/wf_${runId}.json`,
    format: 'json',
    role: 'workflow-state',
    agentId: null,
    workflowRunId: runId,
  };
}

/** A parser fed with `lines` (strings or arrays of strings) as the main transcript. */
export function parseMain(...lines: (string | string[])[]): SessionParser {
  const p = new ClaudeSessionParser(makeSource());
  p.ingestLines(mainFile, lines.flat());
  return p;
}

export type ReplayStep =
  | { file: SourceFile; lines: string[] }
  | { file: SourceFile; json: unknown }
  | { live: LiveState };

const KINDS = ['agents', 'turns', 'requests', 'toolCalls', 'workflows'] as const;

/**
 * Feeds `steps` one line at a time the way the server does, applies every `patch()` to a
 * client-side store the way the UI does, and after each step compares that store with a fresh
 * `snapshot()`. Returns every difference: an entity the change sets failed to report.
 */
export function replayChecked(steps: ReplayStep[]): { parser: SessionParser; problems: string[] } {
  const parser = new ClaudeSessionParser(makeSource());
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
      'live' in step
        ? parser.setLive(step.live)
        : 'json' in step
          ? parser.ingestJson(step.file, step.json)
          : parser.ingestLines(step.file, step.lines);
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

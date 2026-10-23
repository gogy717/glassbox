/**
 * Workflow runs (the Workflow tool, "ultracode"). A run is assembled from four sources that
 * can arrive in any order: the parent's tool result, `journal.jsonl`, each agent's transcript
 * and meta, and the final state file. Facts are collected here and only combined at view time,
 * so the outcome does not depend on arrival order.
 */
import type { RunStatus } from '../../core/model.js';
import { msToIso } from './records.js';

export interface JournalAgent {
  key: string | null;
  label: string | null;
  phase: string | null;
  outcome: 'result' | 'failed' | null;
}

export interface RunState {
  id: string;
  name: string | null;
  taskId: string | null;
  toolCallId: string | null;
  /** Agents in first-seen order. */
  agentIds: string[];
  journal: Map<string, JournalAgent>;
  /** Attempt agent ids per journal key, in start order; the last one is the live attempt. */
  attempts: Map<string, string[]>;
  /** Distinct journal phases in first-seen order. */
  journalPhases: string[];
  /** From the state file, written once when the run ends. */
  final: {
    status: RunStatus;
    phases: { title: string; detail: string | null }[] | null;
    startedAt: string | null;
    endedAt: string | null;
  } | null;
  /** From a task notification in the parent. */
  notified: { status: RunStatus; at: string | null } | null;
}

export function newRun(id: string): RunState {
  return {
    id,
    name: null,
    taskId: null,
    toolCallId: null,
    agentIds: [],
    journal: new Map(),
    attempts: new Map(),
    journalPhases: [],
    final: null,
    notified: null,
  };
}

export type JournalEvent =
  | { type: 'launched' }
  | {
      type: 'started';
      agentId: string;
      key: string | null;
      label: string | null;
      phase: string | null;
    }
  | { type: 'result' | 'failed'; agentId: string }
  | { type: 'other' };

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** One `journal.jsonl` line, or null when it is not valid JSON. */
export function parseJournalLine(line: string): JournalEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const agentId = str(r.agentId);
  if (r.type === 'launched') return { type: 'launched' };
  if (r.type === 'started' && agentId)
    return { type: 'started', agentId, key: str(r.key), label: str(r.label), phase: str(r.phase) };
  if ((r.type === 'result' || r.type === 'failed') && agentId) return { type: r.type, agentId };
  return { type: 'other' };
}

/** Applies a journal event; returns the agent it concerns, if any. */
export function applyJournal(run: RunState, e: JournalEvent): string | null {
  if (e.type === 'launched' || e.type === 'other') return null;
  addAgent(run, e.agentId);
  const entry = run.journal.get(e.agentId) ?? {
    key: null,
    label: null,
    phase: null,
    outcome: null,
  };
  run.journal.set(e.agentId, entry);
  if (e.type === 'started') {
    entry.key = e.key;
    entry.label = e.label;
    entry.phase = e.phase;
    if (e.phase && !run.journalPhases.includes(e.phase)) run.journalPhases.push(e.phase);
    if (e.key) {
      const list = run.attempts.get(e.key) ?? [];
      if (!list.includes(e.agentId)) list.push(e.agentId);
      run.attempts.set(e.key, list);
    }
  } else entry.outcome = e.type;
  return e.agentId;
}

export function addAgent(run: RunState, agentId: string): void {
  if (!run.agentIds.includes(agentId)) run.agentIds.push(agentId);
}

/** True when a later attempt with the same journal key replaced this agent. */
export function isRetried(run: RunState, agentId: string): boolean {
  const key = run.journal.get(agentId)?.key;
  const list = key ? run.attempts.get(key) : undefined;
  return list !== undefined && list.at(-1) !== agentId;
}

/** Final `status` of the state file → run status. */
export function finalStatus(status: unknown, error: unknown): RunStatus {
  switch (status) {
    case 'completed':
      return typeof error === 'string' && error ? 'error' : 'complete';
    case 'killed':
    case 'stopped':
    case 'cancelled':
      return 'interrupted';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return typeof error === 'string' && error ? 'error' : 'complete';
  }
}

/** Reads `workflows/<runId>.json`. Its `totalTokens` is a context-size sum: never used. */
export function applyState(run: RunState, value: unknown): void {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof v.workflowName === 'string') run.name = v.workflowName;
  if (typeof v.taskId === 'string') run.taskId = v.taskId;
  const start = typeof v.startTime === 'number' ? v.startTime : null;
  const duration = typeof v.durationMs === 'number' ? v.durationMs : null;
  const phases = Array.isArray(v.phases)
    ? v.phases.flatMap((p) => {
        const ph = (p ?? {}) as Record<string, unknown>;
        return typeof ph.title === 'string'
          ? [
              {
                title: ph.title,
                detail: typeof ph.detail === 'string' && ph.detail ? ph.detail : null,
              },
            ]
          : [];
      })
    : null;
  run.final = {
    status: finalStatus(v.status, v.error),
    phases,
    startedAt: start !== null ? msToIso(start) : null,
    endedAt: start !== null && duration !== null ? msToIso(start + duration) : null,
  };
}

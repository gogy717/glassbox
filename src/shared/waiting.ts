/**
 * How long the agents waited on the person: the time a permission prompt, a question or a plan
 * approval stayed open before it was answered, and the gap from the agent's reply to the
 * person's next prompt while the session was live. The weekly figures (server,
 * `WeekFigures.waiting`) and the session's Timeline (web, "Waiting for you") both add up the
 * waits here, so they agree.
 *
 * A wait is a tool call's own span, the part of it a prompt covered, or a gap between turns:
 * - a question (`ask` tools, e.g. AskUserQuestion) and a plan approval (ExitPlanMode) hold their
 *   tool open until the person answers: the whole span is the wait;
 * - a permission prompt is an approval window of a glassbox run (`approvalsOf`): the part of the
 *   tool's span it covers, from the prompt to the answer. Claude Code's transcript keeps no
 *   prompt times, so prompts of sessions glassbox did not run are not known;
 * - a gap between prompts runs from the end of a turn to the start of the next one the person
 *   sent, cut to the times a glassbox run of the session was live (`liveSpansOf`): the process
 *   was there, waiting for the person. No transcript of any adapter says whether a session it
 *   did not run was live through a gap (a session closed overnight did not wait), so those gaps
 *   are not counted.
 * A running wait counts up to now. Waits add up: two open at once count twice, as each was
 * answered by the person.
 *
 * Pure, and free of Node built-ins: the web imports it.
 *
 * CONTRACT: the server (`week-buckets.ts`) and the web Timeline (`time-stats.ts`) depend on this
 * file; change them together.
 */
import type { ToolCall, Turn } from '../core/model.js';
import type { RunState } from './runs.js';
import { toolSpan } from './segments.js';
import { toolCategory } from './tool-category.js';

/**
 * - 'permission': a tool blocked on a permission prompt.
 * - 'question': a tool asking the person a question (`ask` category).
 * - 'plan': a plan the person was asked to approve (ExitPlanMode).
 * - 'turn': the gap from the agent's reply to the person's next prompt, while a glassbox run of
 *   the session was live.
 */
export type WaitKind = 'permission' | 'question' | 'plan' | 'turn';

/** One stretch the agent waited on the person, by epoch ms. */
export interface Wait {
  kind: WaitKind;
  agentId: string;
  /** The tool call the wait is part of; for a gap between prompts, the turn that ended it. */
  of: string;
  start: number;
  end: number;
}

/** A permission prompt: when it was shown and when it was answered (null while open). */
export interface ApprovalWindow {
  requestedAt: number;
  decidedAt: number | null;
}

/** By tool-use id: a permission request's id is the id of the tool call it is about. */
export type ApprovalWindows = ReadonlyMap<string, ApprovalWindow>;

const ms = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const PLAN_TOOL = /^exit_?plan_?mode$/i;

/** What kind of wait holding this tool open is, if it holds the person to answer. */
export function waitKindOf(name: string, input: unknown): 'question' | 'plan' | null {
  if (toolCategory(name, input) === 'ask') return 'question';
  if (PLAN_TOOL.test(name)) return 'plan';
  return null;
}

/**
 * The waits of some tool calls, `now` standing for a running one's end. A tool that waits on a
 * question or a plan approval contributes its whole span; any other contributes the part of its
 * span an approval window covers (none when the window was still open after the tool ended).
 */
export function waitsOf(
  tools: Iterable<ToolCall>,
  now: number,
  approvals?: ApprovalWindows,
): Wait[] {
  const out: Wait[] = [];
  for (const t of tools) {
    const span = toolSpan(t, now);
    if (!span) continue;
    const [start, end] = span;
    const base = { agentId: t.agentId, of: t.id };
    const held = waitKindOf(t.name, t.input);
    if (held) {
      if (end > start) out.push({ kind: held, ...base, start, end });
      continue;
    }
    const window = approvals?.get(t.id);
    if (!window) continue;
    const waitEnd = window.decidedAt ?? (t.status === 'running' ? end : null);
    if (waitEnd === null) continue;
    const from = Math.max(start, window.requestedAt);
    const to = Math.min(end, waitEnd);
    if (to > from) out.push({ kind: 'permission', ...base, start: from, end: to });
  }
  return out;
}

/** A stretch a glassbox run of the session was live: epoch ms, the end null while it still is. */
export type LiveSpan = readonly [start: number, end: number | null];

/** What glassbox's runs know of a session's waits: its permission prompts and live stretches. */
export interface WaitSource {
  approvals?: ApprovalWindows;
  live?: readonly LiveSpan[];
}

/**
 * The gaps from the end of a turn to the start of the next one the person sent (`human`), agent
 * by agent, cut to the live spans (`now` ends an open one). Without live spans, none: nothing
 * says the session was there through the gap. The gap after the last reply is not one yet.
 */
export function turnWaitsOf(
  turns: Iterable<Turn>,
  now: number,
  live?: readonly LiveSpan[],
): Wait[] {
  const out: Wait[] = [];
  if (!live || live.length === 0) return out;
  const byAgent = new Map<string, Turn[]>();
  for (const t of turns) {
    const list = byAgent.get(t.agentId);
    if (list) list.push(t);
    else byAgent.set(t.agentId, [t]);
  }
  for (const list of byAgent.values()) {
    list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (let i = 1; i < list.length; i++) {
      const next = list[i] as Turn;
      if (next.origin !== 'human') continue;
      const from = ms(list[i - 1]?.endedAt ?? '');
      const to = ms(next.startedAt);
      if (from === null || to === null || to <= from) continue;
      for (const [start, end] of live) {
        const a = Math.max(from, start);
        const b = Math.min(to, end ?? now);
        if (b > a) out.push({ kind: 'turn', agentId: next.agentId, of: next.id, start: a, end: b });
      }
    }
  }
  return out;
}

/** The sum of the waits' lengths, as the figures add them up. */
export const waitMs = (waits: Iterable<Wait>): number => {
  let total = 0;
  for (const w of waits) total += w.end - w.start;
  return total;
};

/**
 * The approval windows of a session's glassbox runs, closed runs included: the answered prompts
 * of each run (at most the history a run keeps) and its open ones. Runs that predate the answered
 * history only contribute their open prompts.
 */
export function approvalsOf(
  runs: Iterable<RunState>,
  sessionId: string | null,
): Map<string, ApprovalWindow> {
  const out = new Map<string, ApprovalWindow>();
  if (!sessionId) return out;
  for (const run of runs) {
    if (run.sessionId !== sessionId) continue;
    for (const d of run.decidedPermissions ?? []) {
      const requestedAt = ms(d.requestedAt);
      const decidedAt = ms(d.decidedAt);
      if (requestedAt !== null && decidedAt !== null) out.set(d.id, { requestedAt, decidedAt });
    }
    for (const p of run.pendingPermissions) {
      const requestedAt = ms(p.requestedAt);
      if (requestedAt !== null) out.set(p.id, { requestedAt, decidedAt: null });
    }
  }
  return out;
}

/**
 * The stretches the session's glassbox runs were live: from the start of each run to now while
 * it lives, else to its last change (closing it, or failing).
 */
export function liveSpansOf(runs: Iterable<RunState>, sessionId: string | null): LiveSpan[] {
  const out: LiveSpan[] = [];
  if (!sessionId) return out;
  for (const run of runs) {
    if (run.sessionId !== sessionId) continue;
    const start = ms(run.startedAt);
    if (start === null) continue;
    const over = run.status === 'closed' || run.status === 'error';
    const end = over ? ms(run.updatedAt) : null;
    if (over && end === null) continue;
    out.push([start, end]);
  }
  return out;
}

/** What the session's glassbox runs know of its waits (`WaitSource`). */
export function waitSourceOf(runs: readonly RunState[], sessionId: string | null): WaitSource {
  return { approvals: approvalsOf(runs, sessionId), live: liveSpansOf(runs, sessionId) };
}

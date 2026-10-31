/**
 * How long the agents waited on the person: the time a permission prompt, a question or a plan
 * approval stayed open before it was answered. The weekly figures (server, `WeekFigures.waiting`)
 * and the session's Timeline (web, "Waiting for you") both add up the waits here, so they agree.
 *
 * A wait is a tool call's own span, or the part of it a prompt covered:
 * - a question (`ask` tools, e.g. AskUserQuestion) and a plan approval (ExitPlanMode) hold their
 *   tool open until the person answers: the whole span is the wait;
 * - a permission prompt is an approval window of a glassbox run (`approvalsOf`): the part of the
 *   tool's span it covers, from the prompt to the answer. Claude Code's transcript keeps no
 *   prompt times, so prompts of sessions glassbox did not run are not known.
 * A running wait counts up to now. Waits add up: two open at once count twice, as each was
 * answered by the person.
 *
 * Pure, and free of Node built-ins: the web imports it.
 *
 * CONTRACT: the server (`week-buckets.ts`) and the web Timeline (`time-stats.ts`) depend on this
 * file; change them together.
 */
import type { ToolCall } from '../core/model.js';
import type { RunState } from './runs.js';
import { toolSpan } from './segments.js';
import { toolCategory } from './tool-category.js';

/**
 * - 'permission': a tool blocked on a permission prompt.
 * - 'question': a tool asking the person a question (`ask` category).
 * - 'plan': a plan the person was asked to approve (ExitPlanMode).
 * - 'turn': reserved for the gap from the agent's last reply to the person's next prompt. Not
 *   produced yet: no transcript says whether the session was live through such a gap.
 */
export type WaitKind = 'permission' | 'question' | 'plan' | 'turn';

/** One stretch the agent waited on the person, by epoch ms. */
export interface Wait {
  kind: WaitKind;
  agentId: string;
  /** The tool call the wait is part of. */
  toolCallId: string;
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
    const base = { agentId: t.agentId, toolCallId: t.id };
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

/** The sum of the waits' lengths, as the figures add them up. */
export const waitMs = (waits: Iterable<Wait>): number => {
  let total = 0;
  for (const w of waits) total += w.end - w.start;
  return total;
};

const ms = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
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

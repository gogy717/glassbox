/** When the open session's tools waited for the person to answer a permission prompt. */
import { createContext, useContext, useMemo } from 'react';
import type { RunState } from '../../../src/shared/runs.js';
import { approvalsOf } from '../../../src/shared/waiting.js';

/** Epoch ms; `decidedAt` is null while the prompt is still open. */
export interface ApprovalWait {
  requestedAt: number;
  decidedAt: number | null;
}

/** By tool-use id: a permission request's id is the id of the tool call it is about. */
export type Approvals = ReadonlyMap<string, ApprovalWait>;

const NONE: Approvals = new Map();

export const ApprovalsContext = createContext<Approvals>(NONE);

export const useApprovalsContext = () => useContext(ApprovalsContext);

/**
 * Open and answered prompts of every glassbox run of the session, closed runs included: a
 * session continued several times keeps the waits of each. Runs that predate the answered-prompt
 * history only contribute their open prompts.
 */
export function approvalsFor(
  runs: ReadonlyMap<string, RunState>,
  sessionId: string | null,
): Map<string, ApprovalWait> {
  return approvalsOf(runs.values(), sessionId);
}

/**
 * The session's approval windows, as a map that keeps its identity while they stay the same:
 * runs change with every streamed token, and every view that reads this would redraw.
 */
export function useApprovals(
  runs: ReadonlyMap<string, RunState>,
  sessionId: string | null,
): Approvals {
  const found = approvalsFor(runs, sessionId);
  const key = [...found].map(([id, w]) => `${id} ${w.requestedAt} ${w.decidedAt}`).join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the content of `found`.
  return useMemo(() => (found.size ? found : NONE), [key]);
}

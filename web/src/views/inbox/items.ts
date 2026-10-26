/** What the Inbox lists: each thing that waits for you, then each session that looks stuck. */
import type { SessionSummary, TroubleSignal } from '../../../../src/core/model.js';
import { needsYou } from '../../data/needs-you';
import { type OpenPrompt, type PromptKind, promptKind } from '../../data/runs';
import { isListed, isRunning } from '../../lib/sessions';

/**
 * One thing to see to. A glassbox run's prompt is answered here: a tool's permission, a question,
 * a plan to approve. A wait a terminal holds ('terminal') is answered there. A running session
 * that looks stuck is opened. Ids are the session's, by what the item is about: one session is
 * one item.
 */
export type InboxItem =
  | { id: string; kind: PromptKind; session: SessionSummary; prompt: OpenPrompt }
  | { id: string; kind: 'terminal'; session: SessionSummary }
  | { id: string; kind: 'stuck'; session: SessionSummary; sign: TroubleSignal };

/** The oldest sign first; a sign of unknown start last. */
function oldestSignFirst(a: TroubleSignal, b: TroubleSignal): number {
  if (a.since === b.since) return 0;
  if (a.since === null) return 1;
  if (b.since === null) return -1;
  return a.since.localeCompare(b.since);
}

/**
 * The Inbox's items: first what waits for you, the sessions Home lists under Needs you, in its
 * order (the oldest wait first), each a run's prompt (`prompts`) or a terminal's wait; then the
 * running sessions the server sees a sign of trouble in, the oldest sign first, those already
 * listed as waiting aside. Pass the sessions with the runs' prompts folded in (`withWaiting`).
 */
export function inboxItems(
  sessions: readonly SessionSummary[],
  prompts: ReadonlyMap<string, OpenPrompt>,
  showProbes: boolean,
): InboxItem[] {
  const waits = needsYou(sessions, showProbes).map((session): InboxItem => {
    const id = `wait:${session.id}`;
    const prompt = prompts.get(session.id);
    return prompt
      ? { id, kind: promptKind(prompt.request), session, prompt }
      : { id, kind: 'terminal', session };
  });
  const stuck: Extract<InboxItem, { kind: 'stuck' }>[] = [];
  for (const session of sessions) {
    const sign = session.trouble;
    if (sign && isListed(session, showProbes) && isRunning(session) && session.live !== 'waiting')
      stuck.push({ id: `stuck:${session.id}`, kind: 'stuck', session, sign });
  }
  stuck.sort((a, b) => oldestSignFirst(a.sign, b.sign));
  return [...waits, ...stuck];
}

/** What a session that waits for you waits for, read from its activity. */
import type { SessionActivity, SessionSummary } from '../../../src/core/model.js';
import type { MessageKey, T } from '../i18n';
import { toolCategory } from './tool-category';

/**
 * - 'permission': a tool's permission prompt (the activity names the tool).
 * - 'question': the agent asked you something (an ask tool).
 * - 'turn': no tool is blocked; the turn finished and it is your turn to write.
 */
export type WaitKind = 'permission' | 'question' | 'turn';

export function waitKind(a: SessionActivity | undefined): WaitKind {
  if (!a?.tool) return 'turn';
  return toolCategory(a.tool) === 'ask' ? 'question' : 'permission';
}

/** Each kind's phrase; `{x}` is the tool. */
export const WAIT_KEY: Record<WaitKind, MessageKey> = {
  permission: 'wait.permission',
  question: 'wait.question',
  turn: 'wait.turn',
};

/**
 * Since when a session waits: the prompt (a glassbox run's) or the blocked tool's start, else
 * the session's last write, which is when its turn ended. Null when neither is known.
 */
export const waitingSince = (s: SessionSummary): string | null =>
  s.activity?.since ?? s.updatedAt ?? null;

/** The wait in words, on one line: "Permission · Bash", "Question", "Your turn". */
export const waitLabel = (t: T, a: SessionActivity | undefined): string =>
  t(WAIT_KEY[waitKind(a)], { x: a?.tool ?? '' });

/** Waiting the longest first; a wait of unknown start last. */
export function longestWaitFirst(a: SessionSummary, b: SessionSummary): number {
  const x = waitingSince(a);
  const y = waitingSince(b);
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x.localeCompare(y);
}

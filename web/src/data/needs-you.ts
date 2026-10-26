/** The sessions that need you: one list, so every count of them is the same count. */
import type { SessionSummary } from '../../../src/core/model.js';
import { isListed } from '../lib/sessions';
import { longestWaitFirst } from '../lib/waiting';

/**
 * The sessions waiting for you, as Home's board lists them under Needs you: hidden probes aside,
 * the longest wait first. Pass the sessions with the prompts of glassbox runs folded in
 * (`withWaiting`), whose process only knows it is busy. Every count of them reads this, Home's,
 * the tab's title and the Inbox's badge, and the Inbox lists them, so they never disagree.
 */
export const needsYou = (
  sessions: readonly SessionSummary[],
  showProbes: boolean,
): SessionSummary[] =>
  sessions.filter((s) => isListed(s, showProbes) && s.live === 'waiting').sort(longestWaitFirst);

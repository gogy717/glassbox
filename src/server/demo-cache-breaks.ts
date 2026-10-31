/**
 * The demo session's prompt-cache breaks: one of each reason Where tokens went tells apart,
 * staged on the demo snapshot's finished requests so the Cache breaks block and the execution
 * chain's tags show from the first second. Only the demo server stages them: the fixture, and the
 * receipts the tests draw from it, stay as they are.
 *
 * - Main agent, call #2 of prompt 1: the tools changed (a new shape hash from then on).
 * - recon:live-write: a 6½-minute Bash run lets the five-minute cache expire before call #4.
 * - recon:prior-art: compacted before call #4; call #7 resumes from an earlier, shorter context.
 * - verify:live-write: call #2 reads little back, for no reason the records show.
 */
import type { IsoTime, ModelRequest, SessionSnapshot, TokenUsage } from '../core/model.js';
import { MAIN_AGENT_ID } from '../core/model.js';
import { emptyUsage, sumUsage } from '../core/usage.js';

/** The shape hash every demo request carries until the tools change, and after. */
export const DEMO_SHAPE = 'demo-shape-1';
export const DEMO_SHAPE_LATER = 'demo-shape-2';

const LIVE_WRITE = 'af00000000000001';
const PRIOR_ART = 'af00000000000002';
const VERIFY = 'af00000000000003';
/** How much longer the Bash run before recon:live-write's call #4 takes. */
const LONG_RUN_MS = 387_000;

const shift = (iso: IsoTime | null, ms: number) =>
  iso === null ? null : new Date(Date.parse(iso) + ms).toISOString();

/** Usage for `context` tokens of which `read` came from the cache; `hour`: writes to the hour cache. */
function usageOf(base: TokenUsage, context: number, read: number, hour: boolean): TokenUsage {
  const write = context - read - 6;
  return {
    ...emptyUsage(),
    ...base,
    input: 6,
    cacheRead: read,
    cacheWrite: write,
    cacheWrite5m: hour ? 0 : write,
    cacheWrite1h: hour ? write : 0,
  };
}

/**
 * An agent's contexts, request by request, rewritten so each request reads the previous context
 * back, except where `reads` names what a break read instead.
 */
function rewrite(
  requests: ModelRequest[],
  contexts: number[],
  reads: Record<number, number>,
  hour: boolean,
): void {
  let prev = 0;
  requests.forEach((r, i) => {
    const context = contexts[i];
    if (!r.usage || context === undefined) return;
    r.usage = usageOf(r.usage, context, reads[i] ?? prev, hour);
    prev = context;
  });
}

/** Stages the breaks on `snap` in place and returns it. */
export function stageCacheBreaks(snap: SessionSnapshot): SessionSnapshot {
  const of = (agentId: string) =>
    snap.requests
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  for (const r of snap.requests) r.shapeHash = DEMO_SHAPE;

  // Main: the tools changed before call #2; nothing cached could be read back.
  const main = of(MAIN_AGENT_ID);
  for (const r of main.slice(1)) r.shapeHash = DEMO_SHAPE_LATER;
  const second = main[1];
  if (second?.usage) {
    const context = second.usage.input + second.usage.cacheRead + second.usage.cacheWrite;
    second.usage = usageOf(second.usage, context, 0, true);
  }

  // recon:live-write: five-minute writes, and a long Bash run between calls #3 and #4.
  const live = of(LIVE_WRITE);
  rewrite(
    live,
    live.map((_, i) => 24_000 + i * 21_000),
    { 3: 0 },
    false,
  );
  const third = live[2];
  const run = third && snap.toolCalls.find((t) => t.id === third.toolCallIds.at(-1));
  if (run?.endedAt && run.durationMs !== null) {
    run.endedAt = shift(run.endedAt, LONG_RUN_MS);
    run.durationMs += LONG_RUN_MS;
  }
  for (const r of live.slice(3)) {
    r.startedAt = shift(r.startedAt, LONG_RUN_MS);
    r.firstBlockAt = shift(r.firstBlockAt, LONG_RUN_MS);
    r.endedAt = shift(r.endedAt, LONG_RUN_MS);
    for (const b of r.blocks) b.at = shift(b.at, LONG_RUN_MS) as IsoTime;
    for (const t of snap.toolCalls)
      if (t.requestId === r.id) {
        t.startedAt = shift(t.startedAt, LONG_RUN_MS);
        t.endedAt = shift(t.endedAt, LONG_RUN_MS);
      }
  }

  // recon:prior-art, 8K a turn: compacted to 36K before call #4 (the system prompt and tools
  // still cached), and call #7 picks up from a 40K context of which only 12K was still cached.
  const prior = of(PRIOR_ART);
  const compacted = prior[3];
  if (compacted) compacted.compactedBefore = true;
  rewrite(
    prior,
    [40_000, 48_000, 56_000, 36_000, 44_000, 52_000, 40_000, 48_000, 56_000],
    { 3: 14_000, 6: 12_000 },
    false,
  );

  // verify:live-write: call #2 reads only 2K of the previous 24K back.
  const verify = of(VERIFY);
  rewrite(verify, [24_000, 45_000], { 1: 2_000 }, false);

  // Turns, agents and the session end and add up as their requests now do.
  for (const turn of snap.turns) {
    if (turn.endedAt === null) continue;
    const ends = snap.requests
      .filter((r) => r.turnId === turn.id)
      .flatMap((r) => [
        r.endedAt,
        ...snap.toolCalls.filter((t) => t.requestId === r.id).map((t) => t.endedAt),
      ])
      .filter((t): t is IsoTime => t !== null)
      .sort();
    turn.endedAt = ends.at(-1) ?? turn.endedAt;
  }
  for (const agent of snap.agents) {
    const requests = snap.requests.filter((r) => r.agentId === agent.id);
    agent.usage = sumUsage(requests.map((r) => r.usage));
    if (agent.endedAt === null) continue;
    const ends = snap.turns
      .filter((t) => t.agentId === agent.id)
      .map((t) => t.endedAt)
      .filter((t): t is IsoTime => t !== null)
      .sort();
    agent.endedAt = ends.at(-1) ?? agent.endedAt;
  }
  snap.session.usage = sumUsage(snap.requests.map((r) => r.usage));
  return snap;
}

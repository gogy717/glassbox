/**
 * The weekly receipt's server-side buckets against the session receipt (W3): a session alone in
 * its week must print the same figures as its own R1 receipt.
 */
import { describe, expect, it } from 'vitest';
import { createDemoSideSnapshots, createDemoSnapshot } from '../../../../src/core/fixtures/demo.js';
import { MAIN_AGENT_ID, type SessionSnapshot } from '../../../../src/core/model.js';
import { HOUR_MS, sessionBuckets, sliceSession } from '../../../../src/server/week-buckets.js';
import { createStore, type OpenSession } from '../../data/store';
import { subtreeIds, summarize } from '../../lib/agents';
import { toolCategory } from '../../lib/tool-category';
import { DEMO_NOW } from '../../test/demo';
import { receiptData } from './data';

const NOW = DEMO_NOW.getTime();

function opened(snapshot: SessionSnapshot): OpenSession {
  const store = createStore();
  store.openSession(snapshot.session.id);
  store.applyEvent({ type: 'snapshot', sessionId: snapshot.session.id, snapshot });
  return store.getState().open as OpenSession;
}

/** The demo with a failed call and a failed tool, so failures have something to count. */
function withFailures(): SessionSnapshot {
  const snap = createDemoSnapshot(DEMO_NOW);
  const r = snap.requests.find((x) => x.status === 'complete');
  if (r) r.status = 'error';
  const t = snap.toolCalls.find((x) => x.status === 'complete');
  if (t) t.status = 'error';
  return snap;
}

/** The demo with calls that queued before thinking: time the agent was not working. */
function withQueueing(): SessionSnapshot {
  const snap = createDemoSnapshot(DEMO_NOW);
  for (const r of snap.requests)
    for (const b of r.blocks) if (b.kind === 'thinking' && b.durationMs) b.durationMs /= 2;
  return snap;
}

/** The demo with a sub-agent cut off from main (an unknown parent), one of its calls failed. */
function withOrphan(): SessionSnapshot {
  const snap = createDemoSnapshot(DEMO_NOW);
  const sub = snap.agents.find((a) => a.id !== MAIN_AGENT_ID);
  if (sub) sub.parentId = 'gone';
  const r = snap.requests.find((x) => x.agentId === sub?.id && x.status === 'complete');
  if (r) r.status = 'error';
  return snap;
}

/** The demo with a local command (/model) minutes before its first prompt: a turn with no call. */
function withCommand(): SessionSnapshot {
  const snap = createDemoSnapshot(DEMO_NOW);
  const started = new Date(NOW - 50 * 60_000).toISOString();
  snap.turns.unshift({
    id: 'turn_m0',
    agentId: MAIN_AGENT_ID,
    index: 0,
    origin: 'human',
    prompt: '/model',
    startedAt: started,
    endedAt: started,
    status: 'complete',
    requestIds: [],
  });
  return snap;
}

const fixtures: [string, SessionSnapshot][] = [
  ['demo (running, sub-agents, workflow)', createDemoSnapshot(DEMO_NOW)],
  ['demo with failures', withFailures()],
  ['demo with queueing', withQueueing()],
  ['demo with an orphaned sub-agent', withOrphan()],
  ['demo with a local command before its first prompt', withCommand()],
  ...createDemoSideSnapshots(DEMO_NOW).map((s): [string, SessionSnapshot] => [s.session.id, s]),
];

describe('a session alone in its week prints its own receipt’s figures (W3)', () => {
  for (const [name, snap] of fixtures)
    it(name, () => {
      const open = opened(snap);
      const r1 = receiptData(open, NOW);
      const summary = summarize(open, MAIN_AGENT_ID, NOW);
      const b = sessionBuckets(snap, NOW);
      const hs = [...b.hours.keys()].sort((x, y) => x - y);
      const hourStarts: number[] = [];
      for (let h = hs[0] ?? 0; h <= (hs.at(-1) ?? 0); h += HOUR_MS) hourStarts.push(h);
      const week = sliceSession(b, { kind: '7d', hourStarts, now: NOW });
      const f = week?.inWindow;
      if (!f) throw new Error('nothing in the window');

      expect(f.activeMs).toBe(summary.activeMs);
      expect(f.requests).toBe(r1.work.requests);
      expect(f.toolCalls).toBe(r1.work.toolCalls);
      expect(f.failures).toBe(r1.work.failures);
      expect(f.subAgents).toBe(r1.work.subAgents);
      expect(week?.reportsUsage).toBe(r1.tokens.measured);
      expect(f.usage.cacheRead).toBe(r1.tokens.cacheRead);
      expect(f.usage.cacheWrite).toBe(r1.tokens.cacheWrite);
      expect(f.usage.input).toBe(r1.tokens.uncached);
      expect(f.usage.output).toBe(r1.tokens.output);
      expect(f.usage.thinking).toBe(r1.tokens.thinking);
      // Categories before the receipt folds them into its top three and "other".
      const cats: Record<string, number> = {};
      for (const t of open.toolCalls.values()) {
        const c = toolCategory(t.name, t.input);
        cats[c] = (cats[c] ?? 0) + 1;
      }
      expect(f.toolCats).toEqual(cats);
      // Agent time: every agent's own turns (each one's Summary bar active time), added up; the
      // main agent's share is the session's active time (DR7).
      const agentMs = [...subtreeIds(open, MAIN_AGENT_ID)].reduce(
        (n, id) => n + summarize(open, id, NOW).activeMs,
        0,
      );
      expect(f.agentMs).toBe(agentMs);
      expect(week?.hours.reduce((a, h) => a + h, 0)).toBe(agentMs);
      expect(f.agentMs).toBeGreaterThanOrEqual(f.activeMs);
      if (f.subAgents === 0) expect(f.agentMs).toBe(f.activeMs);
    });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../../src/core/model.js';
import { needsYou } from './needs-you';

const NOW = Date.parse('2026-10-26T10:00:00.000Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

let n = 0;
function session(live: SessionSummary['live'], more: Partial<SessionSummary> = {}): SessionSummary {
  n++;
  return {
    id: `claude-code:s${n}`,
    agent: 'claude-code',
    nativeId: `s${n}`,
    title: `Session ${n}`,
    cwd: '/w/garden',
    project: 'garden',
    startedAt: ago(3600),
    updatedAt: ago(60),
    live,
    version: null,
    model: null,
    usage: null,
    counts: null,
    ...more,
  };
}
const since = (s: number) =>
  ({ kind: 'waiting', tool: 'Bash', target: null, agentId: 'main', since: ago(s) }) as const;

describe('needsYou', () => {
  beforeEach(() => {
    n = 0;
  });

  it('lists the sessions that wait for you, the longest wait first', () => {
    const sessions = [
      session('busy'),
      session('waiting', { activity: since(20) }),
      session('idle'),
      // No tool blocked: its turn ended with its last write.
      session('waiting', { updatedAt: ago(40) }),
      session('waiting', { activity: since(90) }),
      session('closed'),
    ];
    expect(needsYou(sessions, false).map((s) => s.title)).toEqual([
      'Session 5',
      'Session 4',
      'Session 2',
    ]);
  });

  it('leaves the hidden probes out unless they are shown', () => {
    const sessions = [
      session('waiting', { activity: since(10) }),
      session('waiting', { tags: ['probe'], activity: since(5) }),
    ];
    expect(needsYou(sessions, false).map((s) => s.title)).toEqual(['Session 1']);
    expect(needsYou(sessions, true).map((s) => s.title)).toEqual(['Session 1', 'Session 2']);
  });

  it('leaves the list it is given as it was', () => {
    const sessions = [session('waiting', { activity: since(5) }), session('waiting')];
    const before = [...sessions];
    needsYou(sessions, false);
    expect(sessions).toEqual(before);
  });
});

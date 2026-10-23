import { describe, expect, it } from 'vitest';
import { checkSnapshot } from '../invariants.js';
import { createDemoSessions, createDemoSnapshot } from './demo.js';

describe('demo fixture', () => {
  const snap = createDemoSnapshot(new Date('2026-10-23T10:00:00Z'));

  it('passes the snapshot invariants', () => {
    expect(checkSnapshot(snap)).toEqual([]);
  });

  it('has one in-flight request, one running tool, one failed tool and a running workflow', () => {
    expect(snap.requests.filter((r) => r.status === 'in-flight')).toHaveLength(2);
    expect(snap.toolCalls.filter((t) => t.status === 'running')).toHaveLength(1);
    expect(snap.toolCalls.filter((t) => t.status === 'error')).toHaveLength(1);
    expect(snap.workflows[0]?.status).toBe('running');
  });

  it('lists the demo session first', () => {
    expect(createDemoSessions()[0]?.id).toBe(snap.session.id);
  });
});

describe('checkSnapshot', () => {
  it('reports dangling references and usage mismatches', () => {
    const snap = createDemoSnapshot();
    const broken = {
      ...snap,
      toolCalls: snap.toolCalls.map((t, i) => (i === 0 ? { ...t, requestId: 'nope' } : t)),
      agents: snap.agents.map((a, i) => (i === 0 ? { ...a, usage: { ...a.usage, output: 0 } } : a)),
    };
    const problems = checkSnapshot(broken);
    expect(problems).toContain(`tool call ${snap.toolCalls[0]?.id} has unknown request`);
    expect(problems).toContain('agent usage does not sum to request usage');
  });
});

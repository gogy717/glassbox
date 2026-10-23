import { describe, expect, it } from 'vitest';
import { demoOpen, DEMO_NOW as NOW } from '../test/demo';
import { agentPath, agentTree, subtreeIds, summarize } from './agents';

const EXPLORE = 'a1b2c3d4e5f60718';

describe('subtreeIds', () => {
  it('includes every descendant of main and only itself for a leaf', () => {
    const open = demoOpen();
    expect([...subtreeIds(open, 'main')].sort()).toEqual(
      ['main', EXPLORE, 'af00000000000001', 'af00000000000002', 'af00000000000003'].sort(),
    );
    expect([...subtreeIds(open, EXPLORE)]).toEqual([EXPLORE]);
  });
});

describe('agentPath', () => {
  it('walks from main through the workflow to a workflow agent', () => {
    const path = agentPath(demoOpen(), 'af00000000000002');
    expect(path.map((p) => (p.kind === 'agent' ? p.agent.label : `wf:${p.workflow.name}`))).toEqual(
      ['Main', 'wf:cc-recon', 'recon:prior-art'],
    );
  });

  it('is just main for main, and main for an unknown agent', () => {
    expect(agentPath(demoOpen(), 'main')).toHaveLength(1);
    expect(agentPath(demoOpen(), 'nope')).toHaveLength(1);
  });
});

describe('agentTree', () => {
  it('lists agents by start time with workflow agents grouped under their run and phase', () => {
    const rows = agentTree(demoOpen()).map((r) =>
      r.kind === 'agent'
        ? `${r.depth}:${r.agent.label}`
        : r.kind === 'workflow'
          ? `${r.depth}:wf:${r.workflow.name}`
          : `${r.depth}:phase:${r.title}`,
    );
    expect(rows).toEqual([
      '0:Main',
      '1:Explore transcript format',
      '1:wf:cc-recon',
      '2:phase:Recon',
      '3:recon:live-write',
      '3:recon:prior-art',
      '2:phase:Verify',
      '3:verify:live-write',
    ]);
  });
});

describe('summarize', () => {
  it('counts own turns and subtree requests, tools and tokens for main', () => {
    const s = summarize(demoOpen(), 'main', NOW.getTime());
    expect(s).toEqual({
      turns: 3,
      requests: 28,
      toolCalls: 24,
      activeMs: 184_000,
      input: 1_838_850,
      cacheHitRate: 1_582_194 / 1_838_850,
      output: 42_040,
      thinking: 27_050,
    });
  });

  it('covers only the agent itself for a leaf sub-agent', () => {
    const s = summarize(demoOpen(), EXPLORE, NOW.getTime());
    expect(s).toMatchObject({
      turns: 1,
      requests: 4,
      toolCalls: 3,
      activeMs: 78_000,
      input: 126_000,
      output: 2_800,
      thinking: 1_600,
    });
  });
});

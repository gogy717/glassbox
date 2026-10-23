import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../../core/adapter.js';
import { checkSnapshot } from '../../core/invariants.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import {
  agentMeta,
  apiRequest,
  assistantBlocks,
  at,
  journalLine,
  taskNotification,
  toolResult,
  userPrompt,
  workflowState,
} from './__fixtures__/builders.js';
import {
  journalFile,
  mainFile,
  makeSource,
  workflowAgentFile,
  workflowAgentMetaFile,
  workflowStateFile,
} from './__fixtures__/harness.js';
import { ClaudeSessionParser } from './parser.js';

const RUN = 'wf_run1';

const launchLines = () => [
  userPrompt({ ts: at(0) }),
  ...assistantBlocks({
    requestId: 'req_wf',
    blocks: [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { scriptPath: 'x.js' } }],
    blockTs: [at(2)],
  }),
  toolResult({
    toolUseId: 'toolu_wf',
    ts: at(3),
    content: 'Workflow launched',
    toolUseResult: {
      status: 'async_launched',
      taskId: 'task-7',
      taskType: 'local_workflow',
      workflowName: 'review-changes',
      runId: RUN,
      summary: 'Launched',
      transcriptDir: `/x/subagents/workflows/${RUN}`,
      scriptPath: 'x.js',
    },
  }),
];

const agentLines = (agentId: string, output: number) =>
  [
    userPrompt({ agentId, text: 'Review the diff', ts: at(10) }),
    assistantBlocks({
      agentId,
      requestId: `req_${agentId}`,
      blocks: ['text'],
      blockTs: [at(20)],
      usage: { output },
    }),
  ].flat();

type Step = [SourceFile, string[] | object];

function run(steps: Step[], live: 'busy' | 'closed' = 'busy') {
  const p = new ClaudeSessionParser(makeSource());
  p.setLive(live);
  for (const [file, data] of steps) {
    if (Array.isArray(data)) p.ingestLines(file, data);
    else p.ingestJson(file, data);
  }
  return p;
}

describe('workflow runs', () => {
  it('the Workflow tool result starts a running run spawned by that call', () => {
    const s = run([[mainFile, launchLines()]]).snapshot();
    expect(s.workflows).toEqual([
      {
        id: RUN,
        name: 'review-changes',
        taskId: 'task-7',
        toolCallId: 'toolu_wf',
        parentAgentId: MAIN_AGENT_ID,
        status: 'running',
        phases: [],
        agentIds: [],
        startedAt: at(2),
        endedAt: null,
      },
    ]);
    expect(s.toolCalls.find((t) => t.id === 'toolu_wf')?.spawned).toEqual({
      kind: 'workflow',
      runId: RUN,
    });
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('journal entries name agents and phases; agent files carry their work', () => {
    const s = run([
      [mainFile, launchLines()],
      [
        journalFile(RUN),
        [
          journalLine({ type: 'launched' }),
          journalLine({
            type: 'started',
            agentId: 'w1',
            key: 'k1',
            label: 'review:a',
            phase: 'Review',
          }),
          journalLine({ type: 'started', agentId: 'w2', key: 'k2', label: 'fix:a', phase: 'Fix' }),
          journalLine({ type: 'result', agentId: 'w1', key: 'k1' }),
        ],
      ],
      [workflowAgentFile(RUN, 'w1'), agentLines('w1', 11)],
      [workflowAgentFile(RUN, 'w2'), agentLines('w2', 22)],
    ]).snapshot();
    const w1 = s.agents.find((a) => a.id === 'w1');
    expect(w1).toMatchObject({
      kind: 'workflow-agent',
      label: 'review:a',
      phase: 'Review',
      workflowRunId: RUN,
      parentId: MAIN_AGENT_ID,
      spawnedByToolCallId: 'toolu_wf',
      status: 'complete',
    });
    expect(w1?.usage.output).toBe(11);
    expect(s.agents.find((a) => a.id === 'w2')).toMatchObject({
      label: 'fix:a',
      status: 'running',
    });
    expect(s.workflows[0]).toMatchObject({
      agentIds: ['w1', 'w2'],
      phases: [
        { title: 'Review', detail: null },
        { title: 'Fix', detail: null },
      ],
    });
    expect(s.turns.find((t) => t.agentId === 'w1')?.origin).toBe('agent-prompt');
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('failed entries are errors, and retried keys leave earlier attempts as errors', () => {
    const s = run([
      [mainFile, launchLines()],
      [
        journalFile(RUN),
        [
          journalLine({
            type: 'started',
            agentId: 'w1',
            key: 'k1',
            label: 'build',
            phase: 'Build',
          }),
          journalLine({ type: 'started', agentId: 'w2', key: 'k2', label: 'test', phase: 'Build' }),
          journalLine({ type: 'failed', agentId: 'w2', key: 'k2' }),
          journalLine({
            type: 'started',
            agentId: 'w3',
            key: 'k1',
            label: 'build',
            phase: 'Build',
          }),
        ],
      ],
    ]).snapshot();
    const status = (id: string) => s.agents.find((a) => a.id === id)?.status;
    expect([status('w1'), status('w2'), status('w3')]).toEqual(['error', 'error', 'running']);
    expect(s.workflows[0]?.phases).toEqual([{ title: 'Build', detail: null }]);
  });

  it('agent meta supplies phase and label when the journal has not named the agent', () => {
    const s = run([
      [mainFile, launchLines()],
      [
        workflowAgentMetaFile(RUN, 'w1'),
        agentMeta({ workflowPhase: 'Verify', description: 'verify:x' }),
      ],
      [workflowAgentFile(RUN, 'w1'), agentLines('w1', 5)],
    ]).snapshot();
    expect(s.agents.find((a) => a.id === 'w1')).toMatchObject({
      label: 'verify:x',
      phase: 'Verify',
      agentType: 'workflow-subagent',
      workflowRunId: RUN,
    });
    expect(s.workflows[0]?.agentIds).toEqual(['w1']);
  });

  it('the state file gives final status, phases with detail and times, never its token sum', () => {
    const p = run([
      [mainFile, launchLines()],
      [workflowAgentFile(RUN, 'w1'), agentLines('w1', 5)],
    ]);
    p.ingestJson(
      workflowStateFile(RUN),
      workflowState({
        runId: RUN,
        status: 'completed',
        startTime: Date.parse(at(2)),
        durationMs: 60_000,
        phases: [{ title: 'Review', detail: 'Read every file' }],
        totalTokens: 1_000_000,
      }),
    );
    const s = p.snapshot();
    expect(s.workflows[0]).toMatchObject({
      status: 'complete',
      phases: [{ title: 'Review', detail: 'Read every file' }],
      startedAt: at(2),
      endedAt: at(62),
    });
    expect(s.session.usage?.output).toBe(50 + 5);
    expect(checkSnapshot(s)).toEqual([]);
  });

  it('maps killed and failed final states', () => {
    const killed = run([[mainFile, launchLines()]]);
    killed.ingestJson(workflowStateFile(RUN), workflowState({ runId: RUN, status: 'killed' }));
    expect(killed.snapshot().workflows[0]?.status).toBe('interrupted');
    const failed = run([[mainFile, launchLines()]]);
    failed.ingestJson(
      workflowStateFile(RUN),
      workflowState({ runId: RUN, status: 'failed', error: 'boom' }),
    );
    expect(failed.snapshot().workflows[0]?.status).toBe('error');
  });

  it('a task notification for the run completes it', () => {
    const p = run([[mainFile, launchLines()]]);
    p.ingestLines(mainFile, [
      taskNotification({ taskId: 'task-7', toolUseId: 'toolu_wf', ts: at(90) }),
    ]);
    expect(p.snapshot().workflows[0]).toMatchObject({ status: 'complete', endedAt: at(90) });
  });

  it('a run with no end signal is unknown once the session closes', () => {
    expect(run([[mainFile, launchLines()]], 'closed').snapshot().workflows[0]?.status).toBe(
      'unknown',
    );
  });
});

describe('arrival order', () => {
  const journal: Step = [
    journalFile(RUN),
    [
      journalLine({ type: 'launched' }),
      journalLine({
        type: 'started',
        agentId: 'w1',
        key: 'k1',
        label: 'review:a',
        phase: 'Review',
      }),
      journalLine({ type: 'result', agentId: 'w1', key: 'k1' }),
    ],
  ];
  const meta: Step = [
    workflowAgentMetaFile(RUN, 'w1'),
    agentMeta({ workflowPhase: 'Review', description: 'review:a' }),
  ];
  const agent: Step = [workflowAgentFile(RUN, 'w1'), agentLines('w1', 9)];
  const main: Step = [mainFile, launchLines()];

  const view = (p: ClaudeSessionParser) => {
    const s = p.snapshot();
    return { agents: s.agents, workflows: s.workflows, problems: checkSnapshot(s) };
  };

  it('gives the same agents and runs whether the journal or the agent file comes first', () => {
    const journalFirst = view(run([main, journal, meta, agent]));
    const agentFirst = view(run([main, agent, meta, journal]));
    const mainLast = view(run([agent, journal, meta, main]));
    expect(journalFirst.problems).toEqual([]);
    expect(agentFirst).toEqual(journalFirst);
    expect(mainLast).toEqual(journalFirst);
    expect(journalFirst.agents.find((a) => a.id === 'w1')).toMatchObject({
      label: 'review:a',
      phase: 'Review',
      workflowRunId: RUN,
      spawnedByToolCallId: 'toolu_wf',
      status: 'complete',
    });
  });
});

describe('ended runs', () => {
  it('an agent of a killed run is no longer waiting on the model', () => {
    const p = run([
      [mainFile, launchLines()],
      [
        journalFile(RUN),
        [journalLine({ type: 'started', agentId: 'w1', key: 'k1', label: 'a', phase: 'P' })],
      ],
      [
        workflowAgentFile(RUN, 'w1'),
        [userPrompt({ agentId: 'w1' }), apiRequest({ id: 'api-w', agentId: 'w1' })],
      ],
    ]);
    const ch = p.ingestJson(
      workflowStateFile(RUN),
      workflowState({ runId: RUN, status: 'killed' }),
    );
    expect(ch.requests).toContain('api-w');
    const s = p.snapshot();
    expect(s.requests.find((r) => r.id === 'api-w')?.status).toBe('interrupted');
    expect(s.turns.find((t) => t.agentId === 'w1')?.status).toBe('interrupted');
  });

  it('absurd numbers in the state file do not throw', () => {
    const p = run([[mainFile, launchLines()]]);
    expect(() =>
      p.ingestJson(workflowStateFile(RUN), workflowState({ runId: RUN, startTime: 1.7e18 })),
    ).not.toThrow();
    expect(p.snapshot().workflows[0]?.startedAt).toBe(at(2));
  });
});

/**
 * Live-update completeness: every scenario is fed one line at a time, patches are applied to a
 * client-side store, and the store must equal a fresh snapshot after every step.
 */
import { describe, expect, it } from 'vitest';
import {
  agentMeta,
  apiError,
  apiRequest,
  assistantBlocks,
  at,
  interrupt,
  journalLine,
  taskNotification,
  toolResult,
  turnDuration,
  userPrompt,
  workflowState,
} from './__fixtures__/builders.js';
import {
  journalFile,
  mainFile,
  type ReplayStep,
  replayChecked,
  subagentFile,
  subagentMetaFile,
  workflowAgentFile,
  workflowAgentMetaFile,
  workflowStateFile,
} from './__fixtures__/harness.js';

const main = (...lines: (string | string[])[]): ReplayStep => ({
  file: mainFile,
  lines: lines.flat(),
});

describe('patches keep a live client in step with the snapshot', () => {
  it('a main session with tools, an interrupt, an error and a close', () => {
    const { problems } = replayChecked([
      { live: 'busy' },
      main(
        userPrompt({ text: 'one', ts: at(0) }),
        apiRequest({ id: 'api-1', ts: at(1) }),
        assistantBlocks({
          requestRef: 'api-1',
          requestId: 'req_1',
          blocks: ['thinking', { type: 'tool_use', id: 'toolu_1' }],
          style: '2.1.302',
          blockTs: [at(3), at(4)],
        }),
        toolResult({ toolUseId: 'toolu_1', ts: at(5) }),
        apiRequest({ id: 'api-2', ts: at(6) }),
        assistantBlocks({ requestRef: 'api-2', blocks: ['text'], blockTs: [at(8)] }),
        turnDuration({ ts: at(8.2) }),
        userPrompt({ text: 'two', ts: at(10) }),
        apiRequest({ id: 'api-3', ts: at(11) }),
        assistantBlocks({ requestRef: 'api-3', blocks: ['thinking'], stopReason: null }),
        interrupt({ ts: at(14) }),
        taskNotification({ taskId: 'bg-1', ts: at(20) }),
        apiRequest({ id: 'api-4', ts: at(21) }),
        apiError({ ts: at(22) }),
        apiRequest({ id: 'api-5', ts: at(25) }),
      ),
      { live: 'closed' },
    ]);
    expect(problems).toEqual([]);
  });

  it('a new prompt updates the turn it ends', () => {
    const { problems } = replayChecked([
      { live: 'busy' },
      main(
        userPrompt({ text: '/model', ts: at(0) }),
        userPrompt({ text: 'hi', ts: at(1) }),
        apiRequest({ id: 'api-1', ts: at(2) }),
        userPrompt({ text: 'and this', ts: at(3) }),
        apiRequest({ id: 'api-2', ts: at(4) }),
      ),
    ]);
    expect(problems).toEqual([]);
  });

  it('a request written before its prompt moves to that prompt’s turn (2.1.309 order)', () => {
    const { parser, problems } = replayChecked([
      { live: 'busy' },
      main(
        userPrompt({ text: 'first', ts: at(0) }),
        apiRequest({ id: 'api-1', ts: at(1) }),
        assistantBlocks({ requestRef: 'api-1', blocks: ['text'], blockTs: [at(2)] }),
        // The next prompt's api-request is on disk before the prompt itself.
        apiRequest({ id: 'api-2', ts: at(11) }),
        userPrompt({ text: 'second', ts: at(10) }),
        assistantBlocks({ requestRef: 'api-2', blocks: ['text'], blockTs: [at(12)] }),
        apiRequest({ id: 'api-3', ts: at(21) }),
        userPrompt({ text: 'third', ts: at(20) }),
      ),
      { live: 'closed' },
    ]);
    expect(problems).toEqual([]);
    const turns = parser.snapshot().turns.filter((t) => t.agentId === 'main');
    expect(turns.map((t) => [t.prompt, t.requestIds])).toEqual([
      ['first', ['api-1']],
      ['second', ['api-2']],
      ['third', ['api-3']],
    ]);
  });

  it('a later request updates the unanswered tools of the one before', () => {
    const { problems } = replayChecked([
      { live: 'busy' },
      main(
        userPrompt(),
        assistantBlocks({ requestId: 'r1', blocks: [{ type: 'tool_use', id: 't1' }] }),
        assistantBlocks({ requestId: 'r2', blocks: ['text'] }),
      ),
    ]);
    expect(problems).toEqual([]);
  });

  it('a sub-agent: spawn, meta, transcript, notification', () => {
    const { problems } = replayChecked([
      { live: 'busy' },
      main(
        userPrompt(),
        assistantBlocks({
          requestId: 'r_spawn',
          blocks: [
            { type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'Scan' } },
          ],
        }),
        toolResult({
          toolUseId: 'toolu_a',
          toolUseResult: { status: 'async_launched', agentId: 'a1' },
        }),
      ),
      {
        file: subagentFile('a1'),
        lines: [userPrompt({ agentId: 'a1' }), apiRequest({ id: 'api-a', agentId: 'a1' })],
      },
      {
        file: subagentMetaFile('a1'),
        json: agentMeta({ toolUseId: 'toolu_a', description: 'Scan the repo' }),
      },
      {
        file: subagentFile('a1'),
        lines: assistantBlocks({
          agentId: 'a1',
          requestRef: 'api-a',
          blocks: [{ type: 'tool_use', id: 'toolu_s' }],
        }),
      },
      main(taskNotification({ taskId: 'a1', toolUseId: 'toolu_a', status: 'killed' })),
      { live: 'closed' },
    ]);
    expect(problems).toEqual([]);
  });

  it('a workflow whose agent file comes before its meta, journal and state', () => {
    const RUN = 'wf_run1';
    const { problems } = replayChecked([
      { live: 'busy' },
      {
        file: workflowAgentFile(RUN, 'w1'),
        lines: [userPrompt({ agentId: 'w1' }), apiRequest({ id: 'api-w', agentId: 'w1' })],
      },
      {
        file: workflowAgentMetaFile(RUN, 'w1'),
        json: agentMeta({ workflowPhase: 'Verify', description: 'verify:x' }),
      },
      {
        file: journalFile(RUN),
        lines: [
          journalLine({
            type: 'started',
            agentId: 'w1',
            key: 'k1',
            label: 'verify:x',
            phase: 'Verify',
          }),
        ],
      },
      main(
        userPrompt(),
        assistantBlocks({
          requestId: 'req_wf',
          blocks: [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow' }],
        }),
        toolResult({
          toolUseId: 'toolu_wf',
          toolUseResult: { status: 'async_launched', runId: RUN, taskId: 't7' },
        }),
      ),
      { file: workflowStateFile(RUN), json: workflowState({ runId: RUN, status: 'killed' }) },
    ]);
    expect(problems).toEqual([]);
  });
});

describe('patch completeness across arrival orders', () => {
  const RUN = 'wf_run1';
  const launch = main(
    userPrompt(),
    assistantBlocks({
      requestId: 'req_wf',
      blocks: [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow' }],
    }),
    toolResult({
      toolUseId: 'toolu_wf',
      toolUseResult: { status: 'async_launched', runId: RUN, taskId: 't7' },
    }),
  );
  const journal: ReplayStep = {
    file: journalFile(RUN),
    lines: [
      journalLine({ type: 'launched' }),
      journalLine({ type: 'started', agentId: 'w1', key: 'k1', label: 'a', phase: 'P1' }),
      journalLine({ type: 'failed', agentId: 'w1', key: 'k1' }),
      journalLine({ type: 'started', agentId: 'w2', key: 'k1', label: 'a', phase: 'P1' }),
      journalLine({ type: 'result', agentId: 'w2', key: 'k1' }),
    ],
  };
  const agents: ReplayStep[] = ['w1', 'w2'].map((id) => ({
    file: workflowAgentFile(RUN, id),
    lines: [
      userPrompt({ agentId: id }),
      apiRequest({ id: `api-${id}`, agentId: id }),
      ...assistantBlocks({
        agentId: id,
        requestRef: `api-${id}`,
        blocks: [{ type: 'tool_use', id: `t-${id}` }],
      }),
    ],
  }));
  const state: ReplayStep = { file: workflowStateFile(RUN), json: workflowState({ runId: RUN }) };
  const notify = main(taskNotification({ taskId: 't7', toolUseId: 'toolu_wf' }));

  it.each([
    ['main, journal, agents, state', [launch, journal, ...agents, state, notify]],
    ['agents, journal, main, state', [...agents, journal, launch, notify, state]],
    ['state first', [state, launch, ...agents, journal, notify]],
  ])('%s', (_name, steps) => {
    const { problems } = replayChecked([
      { live: 'busy' },
      ...(steps as ReplayStep[]),
      { live: 'closed' },
    ]);
    expect(problems).toEqual([]);
  });

  it('a fork whose first record copies the parent tool result', () => {
    const { problems } = replayChecked([
      { live: 'busy' },
      main(
        userPrompt(),
        assistantBlocks({
          requestId: 'r_p',
          blocks: [{ type: 'tool_use', id: 'toolu_f', name: 'Agent' }],
        }),
      ),
      {
        file: subagentMetaFile('f1'),
        json: agentMeta({ agentType: 'fork', toolUseId: 'toolu_f' }),
      },
      {
        file: subagentFile('f1'),
        lines: [
          userPrompt({
            agentId: 'f1',
            origin: null,
            contentBlocks: [
              { type: 'tool_result', tool_use_id: 'toolu_f', content: 'placeholder' },
              { type: 'text', text: 'Do the forked task' },
            ],
          }),
          apiRequest({ id: 'api-f', agentId: 'f1' }),
        ],
      },
      main(toolResult({ toolUseId: 'toolu_f', content: 'real result' })),
      {
        file: subagentMetaFile('f1'),
        json: agentMeta({ agentType: 'fork', toolUseId: 'toolu_f', finished: true }),
      },
    ]);
    expect(problems).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { checkSnapshot } from '../../core/invariants.js';
import {
  at,
  CWD,
  gardenSession,
  header,
  SESSION_ID,
  Transcript,
  titleSlot,
} from './__fixtures__/builders.js';
import { feed, mainFile, subFile } from './__fixtures__/harness.js';

const head = [titleSlot(''), header()];

describe('OmpSessionParser', () => {
  it('maps each assistant message onto one request and counts each once', () => {
    const parser = feed(gardenSession());
    const snap = parser.snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    const text = JSON.stringify(snap);
    expect(text).not.toContain('pin-hash-sentinel');
    expect(text).not.toContain('credentialId');
    expect(text).not.toContain('feedfacecafebeef');
    expect(snap.session).toMatchObject({
      id: `oh-my-pi:${SESSION_ID}`,
      agent: 'oh-my-pi',
      title: 'GARDEN: Plan the garden',
      cwd: CWD,
      project: 'garden',
      startedAt: at(0),
      updatedAt: at(12),
      version: '18.12.6',
      model: 'github-copilot/claude-sonnet-5.5',
      live: 'closed',
    });
    expect(
      snap.turns.map((t) => ({
        index: t.index,
        origin: t.origin,
        prompt: t.prompt,
        status: t.status,
      })),
    ).toEqual([
      { index: 1, origin: 'human', prompt: 'Draw a garden plan', status: 'complete' },
      { index: 2, origin: 'human', prompt: 'Now water it', status: 'error' },
    ]);
    expect(snap.turns[0]).toMatchObject({ id: 'e3', startedAt: at(2), endedAt: at(7) });
    expect(snap.requests.map((r) => r.id)).toEqual(['e5', 'e9', 'e13']);
    expect(snap.requests[0]).toMatchObject({
      turnId: 'e3',
      index: 1,
      model: 'xai-oauth/grok-4.7',
      effort: 'high',
      startedAt: at(2),
      firstBlockAt: at(3),
      endedAt: at(4),
      status: 'complete',
      stopReason: 'toolUse',
      usage: { input: 100, cacheRead: 40, cacheWrite: 0, output: 10, thinking: 4 },
      hasDetail: false,
      error: null,
    });
    expect(snap.requests[0]?.blocks).toEqual([
      { kind: 'thinking', text: 'sketch the beds', durationMs: null, at: at(3) },
      { kind: 'text', text: "I'll look around.", at: at(3) },
      { kind: 'tool-use', toolCallId: 'call-ls|fc_1', at: at(3) },
    ]);
    // The provider sent this thought encrypted only.
    expect(snap.requests[1]?.blocks[0]).toMatchObject({ kind: 'thinking', text: null });
    expect(snap.requests[2]).toMatchObject({
      turnId: 'e12',
      model: 'github-copilot/claude-sonnet-5.5',
      status: 'error',
      stopReason: 'error',
      error: { message: '400 The requested model is not supported.', status: 400 },
    });
    expect(snap.toolCalls).toEqual([
      {
        id: 'call-ls|fc_1',
        agentId: 'main',
        requestId: 'e5',
        name: 'bash',
        input: { command: 'ls beds' },
        status: 'complete',
        startedAt: at(4),
        endedAt: at(5),
        durationMs: 1000,
        resultPreview: 'herb.txt\nmint.txt',
        hasFullResult: true,
        spawned: null,
      },
    ]);
    expect(parser.toolResult('call-ls|fc_1')).toBe('herb.txt\nmint.txt');
    expect(parser.toolResult('nope')).toBeUndefined();
    expect(snap.agents.map((a) => [a.id, a.status, a.model])).toEqual([
      ['main', 'error', 'github-copilot/claude-sonnet-5.5'],
    ]);
    expect(snap.session.usage).toMatchObject({
      input: 120,
      cacheRead: 190,
      output: 16,
      thinking: 6,
    });
    expect(snap.session.counts).toEqual({ turns: 2, requests: 3, toolCalls: 1, agents: 1 });
    expect(snap.diagnostics).toEqual({
      unknownRecordTypes: { snack_time: 1 },
      parseErrors: 1,
      unavailable: ['request-detail', 'in-flight'],
    });
    expect(parser.requestDetail('e5')).toEqual({
      requestId: 'e5',
      completeness: 'unavailable',
      notes: [expect.stringContaining('does not store the request body')],
      params: {
        provider: 'xai-oauth',
        api: 'openai-responses',
        model: 'xai-oauth/grok-4.7',
        thinkingLevel: 'high',
      },
      system: null,
      tools: null,
      messages: null,
    });
    expect(parser.requestDetail('e3')).toBeNull();
  });

  it('shows only the active branch: a resent prompt replaces the one it was edited from', () => {
    const t = new Transcript();
    const model = t.modelChange('xai-oauth/grok-4.7', 1);
    t.user('Plant roses', 2);
    t.answer({ sec: 3, text: 'Roses need sun.', usage: { input: 50, output: 5 } });
    t.user('Plant tulips instead', 4, {});
    // The edited prompt hangs off the model change, beside the first one.
    t.lines.pop();
    t.leaf = model;
    t.user('Plant tulips', 4);
    t.answer({ sec: 5, text: 'Tulips in autumn.', usage: { input: 30, output: 4 } });
    const snap = feed([...head, ...t.lines]).snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.turns.map((x) => x.prompt)).toEqual(['Plant tulips']);
    expect(snap.requests.map((r) => r.id)).toEqual(['e6']);
    expect(snap.session.usage).toMatchObject({ input: 30, output: 4 });
    expect(snap.diagnostics.unavailable).toContain('other-branches');
  });

  it('keeps the leaf where omp says it is, and counts side calls hanging off the branch', () => {
    const t = new Transcript();
    t.user('Sort the seeds', 1);
    const answer = t.answer({ sec: 3, text: 'Sorted.', usage: { input: 10, output: 2 } });
    // Late usage of a call that started before the answer: written off the branch.
    t.sideCall('auto-thinking', { input: 7, output: 1 }, 4, {
      parentId: 'e1',
      activeLeafId: answer,
    });
    const snap = feed([...head, ...t.lines]).snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.requests.map((r) => [r.id, r.turnId, r.index])).toEqual([
      ['e2', 'e1', 1],
      ['e3', 'e1', 2],
    ]);
    expect(snap.requests[1]).toMatchObject({
      blocks: [],
      startedAt: null,
      endedAt: at(4),
      hasDetail: false,
    });
    expect(snap.turns[0]?.status).toBe('complete');
    expect(snap.session.usage).toMatchObject({ input: 17, output: 3 });
    expect(snap.diagnostics.unavailable).not.toContain('other-branches');
  });

  it('falls back to the newest entry that is its own leaf when the named one is gone', () => {
    const t = new Transcript();
    t.user('Sort the seeds', 1);
    t.answer({ sec: 2, text: 'Sorted.' });
    t.entry('label', 3, { targetId: 'e2', label: 'x' }, { activeLeafId: 'gone' });
    const snap = feed([...head, ...t.lines]).snapshot();
    expect(snap.requests.map((r) => r.id)).toEqual(['e2']);
  });

  it('starts a turn at a background result that arrives while the agent is idle', () => {
    const t = new Transcript();
    t.user('Spawn a scout', 1);
    t.answer({
      sec: 2,
      tools: [{ id: 'c1', name: 'task', args: { tasks: [{ name: 'Scout', task: 'look' }] } }],
    });
    t.toolResult('c1', 'task', 'Spawned agent `Scout`', 2);
    // Mid-turn, injected input is context for the next call.
    t.injected('todo-reminder', 'Remember the todo list', 3);
    t.answer({ sec: 4, text: 'Waiting for the scout.' });
    // Idle: a reminder followed by a prompt starts no turn of its own.
    t.injected('plan-mode-context', 'Plan mode is on', 5);
    t.user('Any news?', 6);
    t.answer({ sec: 7, text: 'Not yet.' });
    t.injected('async-result', 'Scout finished: 3 beds', 8);
    t.answer({ sec: 9, text: 'The scout found 3 beds.' });
    const snap = feed([...head, ...t.lines]).snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.turns.map((x) => [x.origin, x.prompt, x.requestIds.length])).toEqual([
      ['human', 'Spawn a scout', 2],
      ['human', 'Any news?', 1],
      ['task-notification', 'Scout finished: 3 beds', 1],
    ]);
  });

  it('puts side calls before the first prompt outside any turn', () => {
    const t = new Transcript();
    t.sideCall('auto-thinking', { input: 4 }, 1);
    t.sideCall('probe', { input: 2 }, 1);
    t.user('Go', 2);
    t.answer({ sec: 3, text: 'Gone.' });
    const snap = feed([...head, ...t.lines]).snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.requests.map((r) => [r.id, r.turnId, r.index])).toEqual([
      ['e1', null, 1],
      ['e2', null, 2],
      ['e4', 'e3', 1],
    ]);
  });

  it('opens a turn of its own for an answer nothing asked for', () => {
    const t = new Transcript();
    t.answer({ sec: 1, text: 'Resumed.' });
    const snap = feed([...head, ...t.lines]).snapshot();
    expect(snap.turns).toEqual([
      expect.objectContaining({ id: 'e1', origin: 'other', prompt: '' }),
    ]);
  });

  it('marks the first request after a compaction', () => {
    const t = new Transcript();
    t.user('Go', 1);
    t.answer({ sec: 2, text: 'a' });
    t.entry('compaction', 3, {
      summary: 'earlier work',
      firstKeptEntryId: 'e1',
      tokensBefore: 900,
    });
    t.user('More', 4);
    t.answer({ sec: 5, text: 'b' });
    t.user('Again', 6);
    t.answer({ sec: 7, text: 'c' });
    const snap = feed([...head, ...t.lines]).snapshot();
    expect(snap.requests.map((r) => r.compactedBefore ?? false)).toEqual([false, true, false]);
  });

  it('follows the live state: the open turn runs and its tools run while busy', () => {
    const t = new Transcript();
    t.user('Run the tests', 1);
    t.answer({ sec: 2, tools: [{ id: 'c1', name: 'bash', args: { command: 'npm test' } }] });
    t.toolStart('c1', 'bash', 2);
    const parser = feed([...head, ...t.lines], [], 'busy');
    let snap = parser.snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.turns[0]).toMatchObject({ status: 'running', endedAt: null });
    expect(snap.toolCalls[0]).toMatchObject({ status: 'running', startedAt: at(2), endedAt: null });
    expect(snap.agents[0]).toMatchObject({ status: 'running', endedAt: null });

    const changes = parser.setLive('closed');
    expect(changes.turns).toEqual(['e1']);
    expect(changes.toolCalls).toEqual(['c1']);
    snap = parser.snapshot();
    expect(snap.turns[0]?.status).toBe('interrupted');
    expect(snap.toolCalls[0]?.status).toBe('unknown');
    expect(snap.session.live).toBe('closed');
    expect(parser.setLive('closed').turns).toEqual([]);
  });

  it('serves the whole output from the artifact omp saved when it cut a result short', () => {
    const t = new Transcript();
    t.user('Read it', 1);
    t.answer({
      sec: 2,
      tools: [
        { id: 'c1', name: 'read' },
        { id: 'c2', name: 'read' },
      ],
    });
    t.toolResult('c1', 'read', 'first lines', 3, {
      details: { meta: { truncation: { direction: 'head', artifactId: '4' } } },
    });
    t.toolResult('c2', 'read', 'also cut', 3, {
      details: { meta: { truncation: { direction: 'head', artifactId: '9' } } },
    });
    const asked: string[] = [];
    const parser = feed([...head, ...t.lines], [], 'closed', {
      readArtifact: (id) => {
        asked.push(id);
        return id === '4' ? 'first lines\nand the rest' : null;
      },
    });
    const snap = parser.snapshot();
    expect(asked).toEqual([]);
    expect(snap.toolCalls[0]).toMatchObject({ resultPreview: 'first lines', hasFullResult: true });
    expect(parser.toolResult('c1')).toBe('first lines\nand the rest');
    // An artifact that cannot be read leaves the result as recorded.
    expect(parser.toolResult('c2')).toBe('also cut');
    expect(asked).toEqual(['4', '9']);
  });

  it('keeps a repeated tool call id apart from the first', () => {
    const t = new Transcript();
    t.user('Go', 1);
    t.answer({ sec: 2, tools: [{ id: 'call_0', name: 'bash' }] });
    t.toolResult('call_0', 'bash', 'one', 3);
    t.answer({ sec: 4, tools: [{ id: 'call_0', name: 'bash' }] });
    t.toolResult('call_0', 'bash', 'two', 5);
    t.answer({ sec: 6, text: 'done' });
    const parser = feed([...head, ...t.lines]);
    const snap = parser.snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.toolCalls.map((c) => [c.id, c.requestId, c.resultPreview])).toEqual([
      ['call_0', 'e2', 'one'],
      ['call_0#2', 'e4', 'two'],
    ]);
    expect(parser.toolResult('call_0#2')).toBe('two');
  });

  it('takes the title from the slot omp rewrites, unless a later change is written after it', () => {
    const t = new Transcript();
    t.entry('title_change', 2, { title: 'Old name', source: 'auto' });
    // The slot was rewritten at 5, after the audit entry.
    expect(
      feed([titleSlot('🧪 NEW: New name', 5), header(), ...t.lines]).snapshot().session.title,
    ).toBe('NEW: New name');
    t.entry('title_change', 9, { title: 'Renamed live', source: 'user' });
    expect(
      feed([titleSlot('NEW: New name', 5), header(), ...t.lines]).snapshot().session.title,
    ).toBe('Renamed live');
    // Sessions from before the slot carry the title in the header.
    expect(feed([header({ title: 'From the header' })]).snapshot().session.title).toBe(
      'From the header',
    );
  });

  it('survives a tool input nested deeper than JSON.stringify can go', () => {
    const t = new Transcript();
    t.user('Go', 1);
    t.answer({ sec: 2, tools: [{ id: 'c1', name: 'bash', args: { deep: 'DEEP' } }] });
    // A few KB, fine for JSON.parse, too deep for JSON.stringify.
    const deep = `${'{"d":'.repeat(20_000)}"leaf"${'}'.repeat(20_000)}`;
    const line = (t.lines[1] as string).replace('"DEEP"', deep);
    const parser = feed([...head, t.lines[0] as string]);
    parser.snapshot();
    const changes = parser.ingestLines(mainFile, [line]);
    expect(changes.toolCalls).toEqual(['c1']);
    expect(parser.patch(changes).toolCalls).toHaveLength(1);
  });

  it('says when live state cannot be seen on this platform', () => {
    const snap = feed(gardenSession(), [], 'closed', { liveSignal: false }).snapshot();
    expect(snap.diagnostics.unavailable).toEqual(['request-detail', 'in-flight', 'live-state']);
  });
});

/** A parent whose `task` call spawned `Scout`, which spawned `Scout/Helper`. */
function family() {
  const parent = new Transcript();
  parent.user('Survey the garden', 1);
  parent.answer({
    sec: 2,
    tools: [
      {
        id: 'c-task',
        name: 'task',
        args: { context: 'garden', tasks: [{ name: 'Scout', agent: 'scout', task: 'Count beds' }] },
      },
    ],
    usage: { input: 100, output: 10 },
  });
  parent.toolStart('c-task', 'task', 2);
  parent.toolResult('c-task', 'task', 'Spawned agent `Scout`', 2, {
    details: {
      progress: [{ id: 'Scout', status: 'pending' }],
      async: { state: 'running', jobId: 'Scout' },
    },
  });
  parent.answer({ sec: 9, text: 'The scout counted 3 beds.', usage: { input: 20, output: 5 } });

  const scout = new Transcript('s');
  scout.modelChange('xai-oauth/grok-4.7', 3);
  scout.entry('session_init', 3, {
    systemPrompt: ['You scout gardens.'],
    task: 'Count beds',
    tools: ['read', 'task'],
    agent: 'scout',
  });
  scout.sideCall('auto-thinking', { input: 9, output: 1 }, 3);
  scout.user('Count beds', 3, { attribution: 'agent' });
  scout.answer({
    sec: 4,
    tools: [{ id: 'c-sub', name: 'task', args: { agent: 'task', task: 'Measure' } }],
    usage: { input: 40, output: 4 },
  });
  scout.toolResult('c-sub', 'task', 'done', 7, {
    details: { results: [{ id: 'Helper', exitCode: 1, error: 'ran out of time' }] },
  });
  scout.answer({ sec: 8, text: '3 beds', usage: { input: 30, output: 3 } });

  const helper = new Transcript('h');
  helper.user('Measure', 5, { attribution: 'agent' });
  helper.answer({ sec: 6, text: 'Too slow.', usage: { input: 5, output: 1 } });

  return {
    main: [...head, ...parent.lines],
    scout: [titleSlot(''), header({ id: 'sub-1', timestamp: at(3) }), ...scout.lines],
    helper: [titleSlot(''), header({ id: 'sub-2', timestamp: at(5) }), ...helper.lines],
  };
}

describe('sub-agents', () => {
  it('ties each sub-agent to the task call that named it, keeping its tokens apart', () => {
    const f = family();
    const parser = feed(f.main, [
      { file: subFile('Scout'), lines: f.scout },
      { file: subFile('Scout/Helper'), lines: f.helper },
    ]);
    const snap = parser.snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(
      snap.agents.map((a) => ({
        id: a.id,
        kind: a.kind,
        parentId: a.parentId,
        spawnedBy: a.spawnedByToolCallId,
        type: a.agentType,
        label: a.label,
        status: a.status,
        startedAt: a.startedAt,
      })),
    ).toEqual([
      {
        id: 'main',
        kind: 'main',
        parentId: null,
        spawnedBy: null,
        type: null,
        label: 'Main',
        status: 'complete',
        startedAt: at(0),
      },
      {
        id: 'Scout',
        kind: 'subagent',
        parentId: 'main',
        spawnedBy: 'c-task',
        type: 'scout',
        label: 'Scout',
        status: 'complete',
        startedAt: at(3),
      },
      {
        id: 'Scout/Helper',
        kind: 'subagent',
        parentId: 'Scout',
        spawnedBy: 'Scout/c-sub',
        type: null,
        label: 'Helper',
        status: 'error',
        startedAt: at(5),
      },
    ]);
    expect(snap.toolCalls.find((c) => c.id === 'c-task')?.spawned).toEqual({
      kind: 'agent',
      agentId: 'Scout',
    });
    expect(snap.toolCalls.find((c) => c.id === 'Scout/c-sub')?.spawned).toEqual({
      kind: 'agent',
      agentId: 'Scout/Helper',
    });
    const usage = Object.fromEntries(snap.agents.map((a) => [a.id, a.usage.input]));
    expect(usage).toEqual({ main: 120, Scout: 79, 'Scout/Helper': 5 });
    expect(snap.session.usage?.input).toBe(204);
    expect(snap.turns.filter((t) => t.agentId !== 'main').map((t) => [t.id, t.origin])).toEqual([
      ['Scout/s4', 'agent-prompt'],
      ['Scout/Helper/h1', 'agent-prompt'],
    ]);
    expect(snap.requests.find((r) => r.id === 'Scout/s3')).toMatchObject({
      turnId: null,
      agentId: 'Scout',
    });
    expect(snap.requests.find((r) => r.id === 'Scout/s5')).toMatchObject({ hasDetail: true });
    expect(parser.requestDetail('Scout/s5')).toMatchObject({
      completeness: 'partial',
      system: ['You scout gardens.'],
      tools: ['read', 'task'],
      messages: null,
    });
  });

  it('ties a running sync task to the sub-agents that started after it', () => {
    const parent = new Transcript();
    parent.user('Go', 1);
    parent.answer({
      sec: 2,
      tools: [{ id: 'c-task', name: 'task', args: { agent: 'task', task: 'Look' } }],
    });
    parent.toolStart('c-task', 'task', 2);
    const child = new Transcript('k');
    child.user('Look', 3, { attribution: 'agent' });
    const parser = feed(
      [...head, ...parent.lines],
      [
        {
          file: subFile('QuietOwl'),
          lines: [header({ id: 'sub-1', timestamp: at(3) }), ...child.lines],
        },
      ],
      'busy',
    );
    const snap = parser.snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.agents[1]).toMatchObject({
      id: 'QuietOwl',
      spawnedByToolCallId: 'c-task',
      status: 'running',
    });
    expect(snap.toolCalls[0]).toMatchObject({
      status: 'running',
      spawned: { kind: 'agent', agentId: 'QuietOwl' },
    });
  });

  it('keeps a sub-agent nobody names, under its parent, and one called main apart from Main', () => {
    const child = new Transcript('k');
    child.user('Hello', 3, { attribution: 'agent' });
    child.answer({ sec: 4, text: 'hi' });
    const parser = feed(head, [
      { file: subFile('Orphan/Lost'), lines: child.lines },
      { file: subFile('main'), lines: child.lines },
    ]);
    const snap = parser.snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.agents.map((a) => [a.id, a.parentId, a.spawnedByToolCallId])).toEqual([
      ['main', null, null],
      ['Orphan/Lost', 'main', null],
      ['agent:main', 'main', null],
    ]);
  });

  it('ignores a file in a role it does not read', () => {
    const parser = feed(head);
    const changes = parser.ingestLines(
      {
        path: '/x/0.read.log',
        format: 'jsonl',
        role: 'artifact',
        agentId: null,
        workflowRunId: null,
      },
      ['not json'],
    );
    expect(changes.requests).toEqual([]);
    expect(parser.snapshot().diagnostics.parseErrors).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { at, header, ms, SESSION_ID, Transcript, titleSlot } from './__fixtures__/builders.js';
import { cleanTitle, mapOmpUsage, parseOmpLine, textOf, toIso } from './records.js';

const entry = (line: string) => {
  const rec = parseOmpLine(line);
  if (rec.kind !== 'entry') throw new Error(`not an entry: ${rec.kind}`);
  return rec;
};

describe('parseOmpLine', () => {
  it('reads the title slot and the header', () => {
    expect(parseOmpLine(titleSlot('Plan the garden', 8))).toEqual({
      kind: 'title-slot',
      title: 'Plan the garden',
      updatedAt: at(8),
    });
    expect(parseOmpLine(header({ parentSession: '/s/parent.jsonl' }))).toEqual({
      kind: 'header',
      id: SESSION_ID,
      cwd: '/work/garden',
      startedAt: at(0),
      title: null,
      parentSession: '/s/parent.jsonl',
    });
  });

  it('places every entry in the tree, with the build that wrote it', () => {
    const t = new Transcript();
    t.user('hi', 1);
    t.sideCall('auto-thinking', { input: 3 }, 2, { parentId: 'e1', activeLeafId: 'e9' });
    const [first, side] = t.lines.map(entry);
    expect(first?.node).toEqual({ id: 'e1', parentId: null, timestamp: at(1), version: '18.12.6' });
    expect(side?.node).toMatchObject({ id: 'e2', parentId: 'e1', activeLeafId: 'e9' });
    // A cleared leaf is recorded as null, which is not the same as no leaf at all.
    const cleared = entry(
      JSON.stringify({ type: 'label', id: 'l', parentId: null, activeLeafId: null }),
    );
    expect(cleared.node.activeLeafId).toBeNull();
    expect('activeLeafId' in (first?.node ?? {})).toBe(false);
  });

  it('reads an assistant message: model, usage, timing, blocks and errors', () => {
    const t = new Transcript();
    t.answer({
      sec: 10,
      took: 2,
      thinking: 'sketch',
      text: 'Done.',
      tools: [{ id: 'c1', name: 'bash', args: { command: 'ls' } }],
      usage: { input: 5, output: 7, cacheRead: 11, reasoning: 3 },
    });
    t.answer({ sec: 12, stopReason: 'error', error: { message: '400 nope', status: 400 } });
    const [ok, failed] = t.lines.map((l) => entry(l).body);
    expect(ok).toEqual({
      kind: 'assistant',
      provider: 'xai-oauth',
      model: 'grok-4.7',
      api: 'openai-responses',
      usage: {
        input: 5,
        cacheRead: 11,
        cacheWrite: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 7,
        thinking: 3,
        webSearch: 0,
        webFetch: 0,
      },
      stopReason: 'toolUse',
      error: null,
      startedAt: at(8),
      endedAt: at(10),
      ttftMs: 1000,
      blocks: [
        { kind: 'thinking', text: 'sketch' },
        { kind: 'text', text: 'Done.' },
        { kind: 'tool-call', id: 'c1', name: 'bash', input: { command: 'ls' } },
      ],
    });
    expect(failed).toMatchObject({
      stopReason: 'error',
      error: { message: '400 nope', status: 400, retryAttempt: null },
    });
    expect(JSON.stringify(ok)).not.toContain('credentialId');
  });

  it('keeps an encrypted or redacted thought as a thinking block without text', () => {
    const line = new Transcript();
    line.entry('message', 1, {
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', summary: false },
          { type: 'redactedThinking', data: 'opaque' },
          { type: 'text', text: '' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      },
    });
    expect(entry(line.lines[0] as string).body).toMatchObject({
      blocks: [
        { kind: 'thinking', text: null },
        { kind: 'thinking', text: null },
      ],
    });
  });

  it('reads tool results: text, error flag, the artifact holding the full output', () => {
    const t = new Transcript();
    t.toolResult('c1', 'read', 'first 300 lines', 3, {
      isError: true,
      details: { meta: { truncation: { direction: 'head', artifactId: '5' } } },
    });
    t.toolResult('c2', 'bash', 'wide', 4, {
      details: { meta: { limits: { columnTruncated: { maxColumn: 768, artifactId: '8' } } } },
    });
    t.toolResult('c3', 'bash', 'odd', 5, {
      details: { meta: { truncation: { artifactId: '../x' } } },
    });
    const [read, bash, odd] = t.lines.map((l) => entry(l).body);
    expect(read).toEqual({
      kind: 'tool-result',
      toolCallId: 'c1',
      toolName: 'read',
      text: 'first 300 lines',
      isError: true,
      at: at(3),
      artifactId: '5',
      spawned: [],
    });
    expect(bash).toMatchObject({ artifactId: '8' });
    expect(odd).toMatchObject({ artifactId: null });
  });

  it('reads the agents a task result names, with their outcome once known', () => {
    const t = new Transcript();
    t.toolResult('c1', 'task', 'Spawned agent `Scout`', 3, {
      details: { progress: [{ id: 'Scout', status: 'pending' }], async: { state: 'running' } },
    });
    t.toolResult('c2', 'task', 'done', 9, {
      details: {
        results: [
          { id: 'Ok', exitCode: 0 },
          { id: 'Broke', exitCode: 1 },
          { id: 'Stopped', exitCode: 0, aborted: true },
          { id: 'Threw', exitCode: 0, error: 'boom' },
        ],
      },
    });
    const [async, sync] = t.lines.map((l) => entry(l).body);
    expect(async).toMatchObject({ spawned: [{ id: 'Scout', outcome: null }] });
    expect(sync).toMatchObject({
      spawned: [
        { id: 'Ok', outcome: 'complete' },
        { id: 'Broke', outcome: 'error' },
        { id: 'Stopped', outcome: 'interrupted' },
        { id: 'Threw', outcome: 'error' },
      ],
    });
  });

  it('reads model, thinking, side calls, sub-agent init, tool starts and injected input', () => {
    const t = new Transcript();
    t.modelChange('xai-oauth/grok-4.7', 1);
    t.thinkingLevel(null, 1);
    t.sideCall('auto-thinking', { input: 9, output: 2 }, 2);
    t.entry('session_init', 3, {
      systemPrompt: ['You garden.', 'Project context'],
      task: 'Water the herbs',
      tools: ['read', 'bash'],
      agent: 'task',
    });
    t.toolStart('c1', 'bash', 4);
    t.injected('async-result', 'Scout finished', 5);
    t.entry('compaction', 6, { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 10 });
    t.entry('title_change', 7, { title: '🌿 HERB: Water the herbs', source: 'auto' });
    const bodies = t.lines.map((l) => entry(l).body);
    expect(bodies).toEqual([
      { kind: 'model-change', model: 'xai-oauth/grok-4.7' },
      { kind: 'thinking-change', level: null },
      expect.objectContaining({
        kind: 'model-usage',
        purpose: 'auto-thinking',
        provider: 'xai-oauth',
      }),
      {
        kind: 'session-init',
        agent: 'task',
        task: 'Water the herbs',
        systemPrompt: ['You garden.', 'Project context'],
        tools: ['read', 'bash'],
      },
      { kind: 'tool-start', toolCallId: 'c1', at: at(4) },
      {
        kind: 'injected',
        customType: 'async-result',
        text: 'Scout finished',
        attribution: 'agent',
        at: at(5),
      },
      { kind: 'compaction' },
      { kind: 'title-change', title: 'HERB: Water the herbs' },
    ]);
  });

  it('reads user input with who sent it', () => {
    const t = new Transcript();
    t.user('Plan it', 1);
    t.user('From the parent', 2, { attribution: 'agent', content: 'plain string content' });
    const [person, agent] = t.lines.map((l) => entry(l).body);
    expect(person).toEqual({
      kind: 'user',
      text: 'Plan it',
      attribution: 'user',
      synthetic: false,
      at: at(1),
    });
    expect(agent).toMatchObject({ text: 'plain string content', attribution: 'agent' });
  });

  it('skips what it knows and names what it does not, never throwing', () => {
    const t = new Transcript();
    t.entry('credential_pin', 1, { provider: 'xai-oauth', hash: 'abc' });
    t.entry('custom', 1, { customType: 'session_exit', data: { reason: 'dispose' } });
    t.entry('custom', 1, { customType: 'my-extension-state', data: {} });
    t.entry('message', 1, { message: { role: 'bashExecution', command: 'ls', output: '' } });
    t.entry('message', 1, { message: { role: 'oracle' } });
    t.entry('message', 1, { message: { role: 'toolResult' } });
    t.entry('weather', 1);
    expect(t.lines.map((l) => entry(l).body)).toEqual([
      { kind: 'skip' },
      { kind: 'skip' },
      { kind: 'unknown', type: 'custom:my-extension-state' },
      { kind: 'skip' },
      { kind: 'unknown', type: 'message:oracle' },
      { kind: 'unknown', type: 'message:toolResult' },
      { kind: 'unknown', type: 'weather' },
    ]);
    expect(parseOmpLine(JSON.stringify({ type: 'message', parentId: null }))).toEqual({
      kind: 'unknown',
      type: 'message',
    });
    expect(parseOmpLine(JSON.stringify({ type: 'session' }))).toEqual({
      kind: 'unknown',
      type: 'session',
    });
    for (const bad of ['', '   ', '{', '[1]', 'null', '"x"', '{"id":"a"}'])
      expect(parseOmpLine(bad)).toEqual({ kind: 'invalid' });
  });
});

describe('mapOmpUsage', () => {
  it('splits Anthropic cache writes by TTL and counts server-side tools', () => {
    expect(
      mapOmpUsage({
        input: 1,
        output: 2,
        cacheRead: 3,
        cttl: { ephemeral5m: 4, ephemeral1h: 5 },
        server: { webSearch: 2, webFetch: 1 },
      }),
    ).toEqual({
      input: 1,
      cacheRead: 3,
      cacheWrite: 9,
      cacheWrite5m: 4,
      cacheWrite1h: 5,
      output: 2,
      thinking: 0,
      webSearch: 2,
      webFetch: 1,
    });
    expect(mapOmpUsage('nope')).toBeNull();
  });
});

describe('cleanTitle', () => {
  it.each([
    [
      '🌍 ANTI: Explain Antigravity eligibility failure',
      'ANTI: Explain Antigravity eligibility failure',
    ],
    // A Nerd Fonts glyph shows as a box in a browser without that font.
    [' FLAKY: Fix flaky park tests', 'FLAKY: Fix flaky park tests'],
    ['A1 FIX: not a card, the icon is ASCII', 'A1 FIX: not a card, the icon is ASCII'],
    ['Plain title', 'Plain title'],
    ['  padded  ', 'padded'],
  ])('%s → %s', (raw, title) => {
    expect(cleanTitle(raw)).toBe(title);
  });

  it('drops a blank title', () => {
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle(7)).toBeNull();
  });
});

describe('textOf and toIso', () => {
  it('joins text blocks and skips images', () => {
    expect(
      textOf([
        { type: 'text', text: 'a' },
        { type: 'image', data: 'x' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
    expect(textOf('plain')).toBe('plain');
    expect(textOf(42)).toBe('');
  });

  it('reads omp milliseconds and ISO strings', () => {
    expect(toIso(ms(3))).toBe(at(3));
    expect(toIso(at(3))).toBe(at(3));
    expect(toIso('not a time')).toBeNull();
    expect(toIso(1e300)).toBeNull();
  });
});

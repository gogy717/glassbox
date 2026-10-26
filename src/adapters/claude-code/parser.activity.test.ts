import { describe, expect, it } from 'vitest';
import {
  apiRequest,
  assistantBlocks,
  at,
  toolResult,
  turnDuration,
  userPrompt,
} from './__fixtures__/builders.js';
import { mainFile, makeSource, subagentFile } from './__fixtures__/harness.js';
import { ClaudeSessionParser } from './parser.js';

const readTokens = (sec: number) =>
  assistantBlocks({
    requestRef: 'api-1',
    requestId: 'req_1',
    blocks: [
      'thinking',
      {
        type: 'tool_use',
        id: 'toolu_read',
        name: 'Read',
        input: { file_path: '/w/web/src/tokens.css' },
      },
    ],
    blockTs: [at(sec - 1), at(sec)],
  });

function live(...lines: (string | string[])[]) {
  const p = new ClaudeSessionParser(makeSource());
  p.ingestLines(mainFile, lines.flat());
  p.setLive('busy');
  return p;
}

const activity = (p: ClaudeSessionParser) => p.snapshot().session.activity;

describe('activity of a live Claude Code session', () => {
  it('follows a turn: the call, the tool, the next call, the reply', () => {
    const p = live(
      userPrompt({ text: 'restyle', ts: at(0) }),
      apiRequest({ id: 'api-1', ts: at(1) }),
    );
    expect(activity(p)).toEqual({
      kind: 'thinking',
      tool: null,
      target: null,
      agentId: 'main',
      since: at(1),
    });

    p.ingestLines(mainFile, readTokens(6));
    expect(activity(p)).toEqual({
      kind: 'tool',
      tool: 'Read',
      target: 'tokens.css',
      agentId: 'main',
      since: at(6),
    });

    // The result is in; the next api-request is not on disk yet.
    p.ingestLines(mainFile, [toolResult({ toolUseId: 'toolu_read', ts: at(8) })]);
    expect(activity(p)).toMatchObject({ kind: 'thinking', since: at(8) });
    p.ingestLines(mainFile, [apiRequest({ id: 'api-2', ts: at(9) })]);
    expect(activity(p)).toMatchObject({ kind: 'thinking', since: at(9) });

    // 2.1.302 writes each block as it completes: text is out, the call is still open.
    p.ingestLines(
      mainFile,
      assistantBlocks({
        requestRef: 'api-2',
        requestId: 'req_2',
        blocks: ['text', 'text'],
        style: '2.1.302',
        blockTs: [at(12), at(13)],
      }).slice(0, 1),
    );
    expect(activity(p)).toMatchObject({ kind: 'writing', since: at(9) });
  });

  it('shows the sub-agent at work rather than the Agent tool waiting on it', () => {
    const p = live(
      userPrompt({ ts: at(0) }),
      assistantBlocks({
        requestId: 'req_main',
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_agent',
            name: 'Agent',
            input: { description: 'Scan the repo', prompt: 'Look' },
          },
        ],
        blockTs: [at(2)],
      }),
    );
    expect(activity(p)).toMatchObject({ kind: 'tool', tool: 'Agent', target: 'Scan the repo' });
    p.ingestLines(subagentFile('a1'), [
      userPrompt({ agentId: 'a1', text: 'Look', ts: at(3) }),
      apiRequest({ id: 'api-sub', agentId: 'a1', ts: at(4) }),
      ...assistantBlocks({
        agentId: 'a1',
        requestRef: 'api-sub',
        requestId: 'req_sub',
        blocks: [
          { type: 'tool_use', id: 'toolu_grep', name: 'Grep', input: { pattern: 'claimEarly' } },
        ],
        blockTs: [at(7)],
      }),
    ]);
    expect(activity(p)).toEqual({
      kind: 'tool',
      tool: 'Grep',
      target: 'claimEarly',
      agentId: 'a1',
      since: at(7),
    });
  });

  it('waits on the person with the tool that asked', () => {
    const p = live(
      userPrompt({ ts: at(0) }),
      apiRequest({ id: 'api-1', ts: at(1) }),
      assistantBlocks({
        requestRef: 'api-1',
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_rm',
            name: 'Bash',
            input: { command: 'git push --force origin main' },
          },
        ],
        blockTs: [at(3)],
      }),
    );
    p.setLive('waiting');
    expect(activity(p)).toEqual({
      kind: 'waiting',
      tool: 'Bash',
      target: 'git push',
      agentId: 'main',
      since: at(3),
    });
  });

  it('is idle once the turn is over, and absent once the process is gone', () => {
    const p = live(
      userPrompt({ ts: at(0) }),
      apiRequest({ id: 'api-1', ts: at(1) }),
      assistantBlocks({ requestRef: 'api-1', blocks: ['text'], blockTs: [at(4)] }),
      turnDuration({ ts: at(4.5) }),
    );
    p.setLive('idle');
    expect(activity(p)).toMatchObject({ kind: 'idle', since: at(4.5) });
    p.setLive('closed');
    expect('activity' in p.snapshot().session).toBe(false);
  });

  it('reaches a live client through the patch of the ingest that changed it', () => {
    const p = live(userPrompt({ ts: at(0) }), apiRequest({ id: 'api-1', ts: at(1) }));
    const ch = p.ingestLines(mainFile, readTokens(6));
    expect(p.patch(ch).session.activity).toMatchObject({ kind: 'tool', tool: 'Read' });
  });
});

describe('what a live Claude Code session last said', () => {
  const lastReply = (p: ClaudeSessionParser) => p.snapshot().session.lastReply;

  it('is the main agent’s latest words in its latest turn, while the process is up', () => {
    const p = live(
      userPrompt({ text: 'release it', ts: at(0) }),
      apiRequest({ id: 'api-1', ts: at(1) }),
      assistantBlocks({
        requestRef: 'api-1',
        requestId: 'req_1',
        blocks: [
          { type: 'text', text: 'Tagging v2.0 now.' },
          { type: 'tool_use', id: 'toolu_tag', name: 'Bash', input: { command: 'git tag v2.0' } },
        ],
        blockTs: [at(2), at(3)],
      }),
    );
    expect(lastReply(p)).toBe('Tagging v2.0 now.');

    // A new prompt has said nothing yet: the last turn's words are not its words.
    p.ingestLines(mainFile, [
      toolResult({ toolUseId: 'toolu_tag', ts: at(4) }),
      userPrompt({ text: 'and push', ts: at(10) }),
    ]);
    expect(lastReply(p)).toBeNull();

    const ch = p.ingestLines(mainFile, [
      apiRequest({ id: 'api-2', ts: at(11) }),
      ...assistantBlocks({
        requestRef: 'api-2',
        requestId: 'req_2',
        blocks: [{ type: 'text', text: 'Pushed to origin.' }],
        blockTs: [at(12)],
      }),
    ]);
    expect(p.patch(ch).session.lastReply).toBe('Pushed to origin.');
    p.setLive('closed');
    expect('lastReply' in p.snapshot().session).toBe(false);
  });
});

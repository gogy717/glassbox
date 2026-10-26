import { describe, expect, it } from 'vitest';
import { type LastReplyInput, lastReplyField } from './last-reply.js';
import type { LiveState, ModelRequest, ResponseBlock, Turn } from './model.js';

const at = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();
const text = (s: string, sec = 1): ResponseBlock => ({ kind: 'text', text: s, at: at(sec) });
const thinking = (s: string): ResponseBlock => ({
  kind: 'thinking',
  text: s,
  durationMs: 900,
  at: at(1),
});
const toolUse = (id: string): ResponseBlock => ({ kind: 'tool-use', toolCallId: id, at: at(1) });

const call = (
  id: string,
  blocks: ResponseBlock[],
  o: Partial<ModelRequest> = {},
): ModelRequest => ({
  id,
  agentId: 'main',
  turnId: 'turn-2',
  index: 1,
  model: null,
  effort: null,
  startedAt: at(0),
  firstBlockAt: null,
  endedAt: at(2),
  status: 'complete',
  stopReason: 'end_turn',
  usage: null,
  blocks,
  toolCallIds: [],
  hasDetail: false,
  error: null,
  ...o,
});

const turn = (requestIds: string[], o: Partial<Turn> = {}): Turn => ({
  id: 'turn-2',
  agentId: 'main',
  index: 2,
  origin: 'human',
  prompt: 'ship it',
  startedAt: at(0),
  endedAt: null,
  status: 'running',
  requestIds,
  ...o,
});

/** The helper's input over a parser's requests, the latest turn holding `ids`. */
function input(requests: ModelRequest[], ids: string[], live: LiveState = 'busy'): LastReplyInput {
  const byId = new Map(requests.map((r) => [r.id, r]));
  return { live, lastTurn: turn(ids), request: (id) => byId.get(id) };
}

describe('lastReplyField', () => {
  it('is the last thing the main agent wrote in its latest turn', () => {
    const requests = [
      call('r1', [text('Let me look at the build.'), toolUse('t1')]),
      call('r2', [
        text('Found it: a stale lockfile.'),
        toolUse('t2'),
        text('Pushing the fix now.'),
      ]),
      call('r3', [thinking('Should I also bump the version?')], { status: 'in-flight' }),
    ];
    expect(lastReplyField(input(requests, ['r1', 'r2', 'r3']))).toEqual({
      lastReply: 'Pushing the fix now.',
    });
  });

  it('carries no words into a new turn that has not spoken yet', () => {
    const earlier = call('r1', [text('All 89 tests pass.')], { turnId: 'turn-1' });
    const now = call('r2', [toolUse('t3')]);
    expect(lastReplyField(input([earlier, now], ['r2']))).toEqual({ lastReply: null });
    expect(lastReplyField({ live: 'idle', lastTurn: null, request: () => undefined })).toEqual({
      lastReply: null,
    });
  });

  it('passes over thinking, blank text and a sub-agent’s words', () => {
    const requests = [
      call('r1', [text('Two agents will look at it.')]),
      call('r2', [text('The sub-agent speaks here.')], { agentId: 'agent-7' }),
      call('r3', [thinking('Hmm.'), text('  \n\t ')]),
    ];
    expect(lastReplyField(input(requests, ['r1', 'r2', 'r3']))).toEqual({
      lastReply: 'Two agents will look at it.',
    });
  });

  it('keeps the first 140 characters, counted as characters, and says it was cut', () => {
    const cjk = '修'.repeat(200);
    const emoji = '🧪'.repeat(150);
    const whole = `${'a'.repeat(139)}.`;
    const reply = (s: string) =>
      lastReplyField(input([call('r1', [text(s)])], ['r1'])).lastReply ?? '';
    expect(reply(cjk)).toBe(`${'修'.repeat(140)}…`);
    expect(reply(emoji)).toBe(`${'🧪'.repeat(140)}…`);
    expect(reply(whole)).toBe(whole);
  });

  it('trims the reply but keeps its line breaks, for the page to read its markdown', () => {
    const reply = lastReplyField(
      input([call('r1', [text('\n\n## Done\n\n- one\n- two\n\n')])], ['r1']),
    );
    expect(reply).toEqual({ lastReply: '## Done\n\n- one\n- two' });
  });

  it('masks credentials and shows the home directory as ~, as the session list does', () => {
    const home = process.env.HOME ?? '';
    const said = `I set API_TOKEN=Zx9Qm2Lp8Rt4Vw7Ky3Nb6Hc1 and wrote ${home}/notes/plan.md.`;
    const reply = lastReplyField(input([call('r1', [text(said)])], ['r1'])).lastReply ?? '';
    expect(reply).toBe('I set API_TOKEN=••• and wrote ~/notes/plan.md.');
    expect(reply).not.toContain('Zx9Qm2');
  });

  it('says nothing for a session that is not running', () => {
    const requests = [call('r1', [text('Done.')])];
    for (const live of ['closed', 'unknown'] as const)
      expect(lastReplyField(input(requests, ['r1'], live))).toEqual({});
    for (const live of ['busy', 'waiting', 'idle'] as const)
      expect(lastReplyField(input(requests, ['r1'], live))).toEqual({ lastReply: 'Done.' });
  });
});

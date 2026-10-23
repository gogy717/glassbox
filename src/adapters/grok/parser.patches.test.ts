/**
 * Live-update completeness: each scenario is fed one line at a time, patches are applied to a
 * client-side store, and the store must equal a fresh snapshot after every step.
 */
import { describe, expect, it } from 'vitest';
import { checkSnapshot } from '../../core/invariants.js';
import {
  at,
  chat,
  compaction,
  modelChunk,
  PROMPT_1,
  PROMPT_2,
  summaryDoc,
  TOOL_DEFS,
  toolCall,
  toolUpdate,
  turnCompleted,
  usageDoc,
  userChunk,
} from './__fixtures__/builders.js';
import {
  chatFile,
  eventsFile,
  type ReplayStep,
  replayChecked,
  summaryFile,
  toolsFile,
  updatesFile,
  usageFile,
} from './__fixtures__/harness.js';

type Timed = ReplayStep & { t: number };
const ev = (t: number, type: string, f: object = {}): Timed => ({
  file: eventsFile,
  lines: [JSON.stringify({ ts: at(t), type, ...f })],
  t,
});
const up = (t: number, line: string): Timed => ({ file: updatesFile, lines: [line], t });
const ch = (t: number, line: string): Timed => ({ file: chatFile, lines: [line], t });

const USAGE = {
  inputTokens: 1000,
  cachedReadTokens: 800,
  cacheCreationTokens: 0,
  outputTokens: 60,
  reasoningTokens: 20,
  modelCalls: 3,
};

/** One human turn of three model loops with a tool, chat history and usage; then a second turn. */
function session(): Timed[] {
  return [
    { file: summaryFile, json: summaryDoc(), t: 0 },
    ev(0, 'turn_started', { turn_number: 0, model_id: 'grok-4.7' }),
    up(0, userChunk({ text: 'Plan the garden beds', promptIndex: 0, atSec: 0 })),
    ch(0, chat('system', { content: 'You are a helpful agent.' })),
    ch(
      0,
      chat('user', { content: [{ type: 'text', text: 'Plan the garden beds' }], prompt_index: 0 }),
    ),
    ev(1, 'loop_started', { loop_index: 0 }),
    ev(2, 'first_token'),
    up(
      2,
      modelChunk({
        kind: 'thought',
        text: 'Look at the layout.',
        promptId: PROMPT_1,
        streamAtSec: 1,
        atSec: 2,
      }),
    ),
    up(
      3,
      toolCall({
        id: 'call-1',
        name: 'list_dir',
        input: { path: '.' },
        promptId: PROMPT_1,
        streamAtSec: 1,
        atSec: 3,
      }),
    ),
    ch(3, chat('reasoning', { summary: [{ type: 'text', text: 'Look at the layout.' }] })),
    ch(
      3,
      chat('assistant', {
        content: '',
        tool_calls: [{ id: 'call-1', name: 'list_dir', arguments: '{}' }],
      }),
    ),
    ev(4, 'tool_completed', {
      tool_call_id: 'call-1',
      tool_name: 'list_dir',
      duration_ms: 900,
      outcome: 'success',
    }),
    up(4, toolUpdate({ id: 'call-1', status: 'Completed', output: 'beds.md', atSec: 4 })),
    ch(4, chat('tool_result', { tool_call_id: 'call-1', content: 'beds.md' })),
    ev(5, 'loop_started', { loop_index: 1 }),
    up(
      6,
      modelChunk({
        kind: 'message',
        text: 'Reading the notes.',
        promptId: PROMPT_1,
        streamAtSec: 5,
        atSec: 6,
      }),
    ),
    ch(6, chat('reasoning', { summary: [] })),
    ch(6, chat('assistant', { content: 'Reading the notes.' })),
    ev(8, 'loop_started', { loop_index: 2 }),
    up(
      9,
      modelChunk({
        kind: 'message',
        text: 'Three beds.',
        promptId: PROMPT_1,
        streamAtSec: 8,
        atSec: 9,
      }),
    ),
    ch(9, chat('reasoning', { summary: [{ type: 'text', text: 'Summarise.' }] })),
    ch(9, chat('assistant', { content: 'Three beds.' })),
    up(10, turnCompleted({ promptId: PROMPT_1, atSec: 10, usage: USAGE })),
    ev(10, 'turn_ended', { outcome: 'completed' }),
    { file: usageFile, json: usageDoc([{ turnNumber: 1, atSec: 10, usage: USAGE }]), t: 11 },
    { file: toolsFile, json: TOOL_DEFS, t: 11 },
    ev(20, 'turn_started', { turn_number: 1 }),
    up(20, userChunk({ text: 'Now water them', promptIndex: 1, atSec: 20 })),
    ev(21, 'loop_started', { loop_index: 0 }),
    up(22, compaction('auto_compact_started', 22)),
    ev(23, 'loop_started', { loop_index: 1 }),
    up(30, compaction('auto_compact_completed', 30)),
    ev(31, 'loop_started', { loop_index: 2 }),
    up(
      32,
      modelChunk({
        kind: 'message',
        text: 'Stopped.',
        promptId: PROMPT_2,
        streamAtSec: 31,
        atSec: 32,
      }),
    ),
    ev(33, 'turn_ended', { outcome: 'cancelled' }),
  ];
}

const byTime = (steps: Timed[]) => [...steps].sort((a, b) => a.t - b.t);
const ROLE_ORDER = ['chat-history', 'events', 'summary', 'tool-definitions', 'updates', 'usage'];
const byRole = (steps: Timed[]) =>
  [...steps].sort(
    (a, b) =>
      ROLE_ORDER.indexOf('file' in a ? a.file.role : '') -
        ROLE_ORDER.indexOf('file' in b ? b.file.role : '') || a.t - b.t,
  );

describe('patches keep a live client equal to the snapshot', () => {
  it('in live time order, through a close', () => {
    const { parser, problems } = replayChecked([...byTime(session()), { live: 'closed' }]);
    expect(problems).toEqual([]);
    expect(checkSnapshot(parser.snapshot())).toEqual([]);
  });

  it('in the server’s role order', () => {
    expect(replayChecked(byRole(session()), 'closed').problems).toEqual([]);
  });

  it('with updates.jsonl read before events.jsonl', () => {
    const steps = byTime(session());
    const first = steps.filter((s) => 'file' in s && s.file.role === 'updates');
    const rest = steps.filter((s) => !('file' in s) || s.file.role !== 'updates');
    expect(replayChecked([...first, ...rest]).problems).toEqual([]);
  });

  it('through live-state changes mid-turn', () => {
    const steps = byTime(session()).slice(0, 20);
    expect(
      replayChecked([
        ...steps,
        { live: 'closed' },
        { live: 'busy' },
        ...byTime(session()).slice(20),
      ]).problems,
    ).toEqual([]);
  });
});

describe('chat-history pairing changes', () => {
  it('a tool call arriving after the chat history re-pairs other requests in the patch', () => {
    const steps: ReplayStep[] = [
      {
        file: chatFile,
        lines: [
          chat('reasoning', { summary: [{ text: 'Searching.' }] }),
          chat('assistant', {
            content: '',
            tool_calls: [{ id: 'c9', name: 'grep', arguments: '{}' }],
          }),
          chat('reasoning', { summary: [{ text: 'Answering.' }] }),
          chat('assistant', { content: 'Done.' }),
        ],
      },
      {
        file: eventsFile,
        lines: [
          JSON.stringify({ ts: at(0), type: 'turn_started', turn_number: 0 }),
          JSON.stringify({ ts: at(1), type: 'loop_started', loop_index: 0 }),
          JSON.stringify({ ts: at(3), type: 'loop_started', loop_index: 1 }),
          JSON.stringify({ ts: at(5), type: 'loop_started', loop_index: 2 }),
        ],
      },
      {
        file: updatesFile,
        lines: [
          toolCall({
            id: 'c9',
            name: 'grep',
            input: {},
            promptId: PROMPT_1,
            streamAtSec: 3,
            atSec: 4,
          }),
        ],
      },
    ];
    expect(replayChecked(steps).problems).toEqual([]);
  });
});

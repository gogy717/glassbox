import { describe, expect, it } from 'vitest';
import {
  at,
  event,
  modelChunk,
  PROMPT_1,
  toolCall,
  toolUpdate,
  turnCompleted,
  userChunk,
} from './__fixtures__/builders.js';
import { feed } from './__fixtures__/harness.js';

const events = [
  event('turn_started', { ts: at(0), turn_number: 0, model_id: 'grok-4.7' }),
  event('loop_started', { ts: at(1), loop_index: 0 }),
];
const prompt = userChunk({ text: 'Read the notes', promptIndex: 0 });
const thought = modelChunk({
  kind: 'thought',
  text: 'Look first.',
  promptId: PROMPT_1,
  streamAtSec: 1,
});
const readNotes = toolCall({
  id: 'call-1',
  name: 'read_file',
  input: { target_file: '/work/garden/notes.md' },
  promptId: PROMPT_1,
  streamAtSec: 1,
  atSec: 3,
});

describe('activity of a live Grok session', () => {
  it('thinks in an open loop, then names the tool it runs', () => {
    expect(feed({ events, updates: [prompt, thought] }).snapshot().session.activity).toEqual({
      kind: 'thinking',
      tool: null,
      target: null,
      agentId: 'main',
      since: at(1),
    });
    expect(
      feed({ events, updates: [prompt, thought, readNotes] }).snapshot().session.activity,
    ).toMatchObject({
      kind: 'tool',
      tool: 'read_file',
      target: 'notes.md',
      agentId: 'main',
    });
  });

  it('stops naming the tool once it is done', () => {
    const done = toolUpdate({ id: 'call-1', status: 'completed', output: 'beds', atSec: 4 });
    expect(
      feed({ events, updates: [prompt, thought, readNotes, done] }).snapshot().session.activity
        ?.kind,
    ).toBe('thinking');
  });

  it('is idle after the turn, and absent once closed', () => {
    const updates = [prompt, thought, turnCompleted({ promptId: PROMPT_1, atSec: 9 })];
    const parser = feed({ events, updates }, 'idle');
    expect(parser.snapshot().session.activity?.kind).toBe('idle');
    parser.setLive('closed');
    expect('activity' in parser.snapshot().session).toBe(false);
  });
});

describe('what a live Grok session last said', () => {
  it('is the reply to the latest prompt, and absent once closed', () => {
    expect(
      feed({ events, updates: [prompt, thought, readNotes] }).snapshot().session.lastReply,
    ).toBeNull();
    const reply = modelChunk({
      kind: 'message',
      text: 'The notes list three beds.',
      promptId: PROMPT_1,
      streamAtSec: 5,
    });
    const done = toolUpdate({ id: 'call-1', status: 'completed', output: 'beds', atSec: 4 });
    const parser = feed({ events, updates: [prompt, thought, readNotes, done, reply] }, 'idle');
    expect(parser.snapshot().session.lastReply).toBe('The notes list three beds.');
    parser.setLive('closed');
    expect('lastReply' in parser.snapshot().session).toBe(false);
  });
});

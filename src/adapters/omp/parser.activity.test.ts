import { describe, expect, it } from 'vitest';
import { at, header, Transcript, titleSlot } from './__fixtures__/builders.js';
import { feed, mainFile } from './__fixtures__/harness.js';

const head = [titleSlot(''), header()];

describe('activity of a live oh-my-pi session', () => {
  it('follows a turn: the running tool, then the model on its next step', () => {
    const t = new Transcript();
    t.user('Run the tests', 1);
    t.answer({ sec: 3, tools: [{ id: 'c1', name: 'bash', args: { command: 'npm test' } }] });
    t.toolStart('c1', 'bash', 3);
    const parser = feed([...head, ...t.lines], [], 'busy');
    expect(parser.snapshot().session.activity).toEqual({
      kind: 'tool',
      tool: 'bash',
      target: 'npm test',
      agentId: 'main',
      since: at(3),
    });

    // oh-my-pi writes a call once it is answered: nothing on record says the model is working,
    // but the process is busy and the turn is open.
    const before = t.lines.length;
    t.toolResult('c1', 'bash', 'ok', 6);
    parser.ingestLines(mainFile, t.lines.slice(before));
    expect(parser.snapshot().session.activity).toEqual({
      kind: 'thinking',
      tool: null,
      target: null,
      agentId: 'main',
      since: at(6),
    });
  });

  it('is idle between turns, and absent once closed', () => {
    const t = new Transcript();
    t.user('Hello', 1);
    t.answer({ sec: 4, text: 'Hi.' });
    const parser = feed([...head, ...t.lines], [], 'idle');
    expect(parser.snapshot().session.activity).toMatchObject({ kind: 'idle', since: at(4) });
    parser.setLive('closed');
    expect('activity' in parser.snapshot().session).toBe(false);
  });
});

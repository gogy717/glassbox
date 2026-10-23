/**
 * Live-update completeness: each scenario is fed one line at a time, patches are applied to a
 * client-side store, and the store must equal a fresh snapshot after every step.
 */
import { describe, expect, it } from 'vitest';
import { checkSnapshot } from '../../core/invariants.js';
import { at, gardenSession, header, Transcript, titleSlot } from './__fixtures__/builders.js';
import { mainFile, makeSource, replayChecked, subFile } from './__fixtures__/harness.js';
import { OmpSessionParser } from './parser.js';

describe('patches', () => {
  it('keep a client equal to the snapshot through a whole session and a live flip', () => {
    const { parser, problems } = replayChecked([
      { file: mainFile, lines: gardenSession() },
      { live: 'idle' },
      { live: 'closed' },
    ]);
    expect(problems).toEqual([]);
    expect(checkSnapshot(parser.snapshot())).toEqual([]);
  });

  it('remove what a resent prompt replaced', () => {
    const t = new Transcript();
    const model = t.modelChange('xai-oauth/grok-4.7', 1);
    t.user('Plant roses', 2);
    t.answer({ sec: 3, tools: [{ id: 'c1', name: 'bash' }] });
    t.toolResult('c1', 'bash', 'ok', 4);
    t.answer({ sec: 5, text: 'Roses.' });
    t.leaf = model;
    t.user('Plant tulips', 6);
    t.answer({ sec: 7, text: 'Tulips.' });
    const { parser, problems } = replayChecked([
      { file: mainFile, lines: [titleSlot(''), header(), ...t.lines] },
    ]);
    expect(problems).toEqual([]);
    expect(parser.snapshot().requests.map((r) => r.id)).toEqual(['e7']);
  });

  it('name the removed entities in the change set itself', () => {
    const t = new Transcript();
    const model = t.modelChange('xai-oauth/grok-4.7', 1);
    t.user('Plant roses', 2);
    t.answer({ sec: 3, text: 'Roses.' });
    const parser = new OmpSessionParser(makeSource('busy'));
    parser.ingestLines(mainFile, [header(), ...t.lines]);
    parser.snapshot();
    t.leaf = model;
    const before = t.lines.length;
    t.user('Plant tulips', 4);
    const changes = parser.ingestLines(mainFile, t.lines.slice(before));
    expect(changes.removed).toEqual({ turns: ['e2'], requests: ['e3'] });
    expect(changes.turns).toEqual(['e4']);
  });

  it('follow a sub-agent whose file appears while its parent waits', () => {
    const parent = new Transcript();
    parent.user('Survey', 1);
    parent.answer({
      sec: 2,
      tools: [{ id: 'c-task', name: 'task', args: { agent: 'task', task: 'Count beds' } }],
    });
    parent.toolStart('c-task', 'task', 2);
    // The sync task's result, written once the sub-agent is done, names it.
    const waiting = parent.lines.length;
    parent.toolResult('c-task', 'task', 'Scout counted 3 beds', 7, {
      details: { results: [{ id: 'Scout', exitCode: 0 }] },
    });
    parent.answer({ sec: 8, text: '3 beds it is.' });
    const child = new Transcript('k');
    child.user('Count beds', 3, { attribution: 'agent' });
    child.answer({ sec: 4, tools: [{ id: 'c-ls', name: 'bash' }], usage: { input: 9 } });
    child.toolResult('c-ls', 'bash', '3 beds', 5);
    child.answer({ sec: 6, text: '3 beds', usage: { input: 4 } });
    const { parser, problems } = replayChecked([
      { file: mainFile, lines: [titleSlot(''), header(), ...parent.lines.slice(0, waiting)] },
      {
        file: subFile('Scout'),
        lines: [header({ id: 'sub-1', timestamp: at(3) }), ...child.lines],
      },
      { file: mainFile, lines: parent.lines.slice(waiting) },
      { live: 'closed' },
    ]);
    expect(problems).toEqual([]);
    const snap = parser.snapshot();
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.agents.map((a) => [a.id, a.spawnedByToolCallId, a.status])).toEqual([
      ['main', null, 'complete'],
      ['Scout', 'c-task', 'complete'],
    ]);
  });
});

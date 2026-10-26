import { describe, expect, it, vi } from 'vitest';
import { createDemoSessions } from '../../../src/core/fixtures/demo.js';
import type { SessionSummary, Turn } from '../../../src/core/model.js';
import type { OpenSession } from '../data/store';
import { makeI18n } from '../i18n';
import { DEMO_NOW, demoOpen } from '../test/demo';
import { pageItems, promptItems, sessionItems } from './palette-items';

const { t } = makeI18n('en');

const turn = (index: number, more: Partial<Turn>): Turn => ({
  id: `turn_${index}`,
  agentId: 'main',
  index,
  origin: 'human',
  prompt: '',
  startedAt: DEMO_NOW.toISOString(),
  endedAt: DEMO_NOW.toISOString(),
  status: 'complete',
  requestIds: ['r'],
  ...more,
});

describe('promptItems', () => {
  it('words the prompts as the prompt list does, newest first, without local commands', () => {
    const open: OpenSession = {
      ...demoOpen(),
      turns: new Map(
        [
          turn(1, { prompt: '/effort max', requestIds: [] }),
          turn(2, { origin: 'task-notification', prompt: '<task-notification>…' }),
          turn(3, { prompt: '  Run the\n tests  ' }),
          turn(4, { agentId: 'agent-1', prompt: 'A sub-agent’s task' }),
        ].map((x) => [x.id, x]),
      ),
    };
    const select = vi.fn();
    const items = promptItems(open, t, select);
    expect(items.map((i) => [i.label, i.keywords])).toEqual([
      ['Prompt 3 · Run the tests', 'Run the\n tests'],
      ['Prompt 2 · Background task finished', 'Background task finished'],
    ]);
    items[0]?.run();
    expect(select).toHaveBeenCalledWith('turn_3');
    expect(promptItems(null, t, select)).toEqual([]);
  });
});

describe('sessionItems', () => {
  it('leaves probes out unless they are shown, and names an untitled session as its row does', () => {
    const [demo, idle, closed] = createDemoSessions(DEMO_NOW) as SessionSummary[];
    const probe = { ...(idle as SessionSummary), id: 'p', title: 'Probe', tags: ['probe'] };
    const list = [closed, probe, demo, idle] as SessionSummary[];
    expect(sessionItems(list, false, t, vi.fn()).map((i) => i.label)).toEqual([
      'glassbox / Live viewer research (demo)',
      'shopfront / Fix flaky login test',
      'blog / Untitled session',
    ]);
    expect(sessionItems(list, true, t, vi.fn())).toHaveLength(4);
  });
});

describe('pageItems', () => {
  it('offers the tabs only when there is a session to show them', () => {
    const go = { home: vi.fn(), stats: vi.fn() };
    expect(pageItems(t, { ...go, tab: null }).map((i) => i.label)).toEqual(['Home', 'Stats']);
    const tab = vi.fn();
    const items = pageItems(t, { ...go, tab });
    expect(items.map((i) => i.label)).toEqual([
      'Home',
      'Stats',
      'Execution chain',
      'How it worked',
      'Where tokens went',
      'Timeline',
      'Files',
    ]);
    items[4]?.run();
    expect(tab).toHaveBeenCalledWith('tokens');
  });
});

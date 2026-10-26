import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT_ID, type ModelRequest, type ToolCall } from '../../../src/core/model.js';
import type { OpenSession } from '../data/store';
import { I18nContext, makeI18n } from '../i18n';
import { cjkInMono } from '../test/cjk';
import { DEMO_NOW, demoOpen } from '../test/demo';
import { UiContext } from '../ui';
import { SessionView } from '../views/SessionView';
import { OutcomeStrip } from './OutcomeStrip';

function renderStrip(open: OpenSession = demoOpen(), agentId = 'main', locale: 'en' | 'zh' = 'en') {
  const navigate = vi.fn();
  const setFollow = vi.fn();
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <UiContext.Provider value={{ follow: true, setFollow }}>
        <OutcomeStrip open={open} agentId={agentId} navigate={navigate} />
      </UiContext.Provider>
    </I18nContext.Provider>,
  );
  return { navigate, setFollow };
}

const strip = (name = 'Outcome') => screen.getByRole('region', { name });

let serial = 0;
/** The demo with more main-agent shell calls, each a minute after the demo's clock. */
function withCalls(open: OpenSession, calls: (Partial<ToolCall> & { command: string })[]) {
  const toolCalls = new Map(open.toolCalls);
  for (const { command, ...over } of calls) {
    serial++;
    const at = new Date(DEMO_NOW.getTime() + serial * 60_000).toISOString();
    const id = `t_extra${serial}`;
    toolCalls.set(id, {
      id,
      agentId: MAIN_AGENT_ID,
      requestId: 'req_m3',
      name: 'Bash',
      input: { command },
      status: 'complete',
      startedAt: at,
      endedAt: at,
      durationMs: 1000,
      resultPreview: null,
      hasFullResult: false,
      spawned: null,
      ...over,
    });
  }
  return { ...open, toolCalls };
}

describe('OutcomeStrip', () => {
  it('says what the selected agent and its sub-agents did, figures in mono', () => {
    renderStrip();
    expect(strip()).toHaveTextContent('3 files edited · 1 created · 1 failure');
    expect([...strip().querySelectorAll('.figure')].map((f) => f.textContent)).toEqual([
      '3',
      '1',
      '1',
    ]);
  });

  it('opens the Files tab from the files, and the first failed call from the failures', () => {
    const { navigate, setFollow } = renderStrip();
    fireEvent.click(within(strip()).getByRole('button', { name: /files edited/ }));
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'files' });
    fireEvent.click(within(strip()).getByRole('button', { name: /failure/ }));
    expect(setFollow).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'main',
      turnId: 'turn_m1',
      requestId: 'req_m2',
      card: 'tool:tu_m2b',
    });
  });

  it('counts test runs with the last one’s verdict, and commits, each going to its last call', () => {
    const open = withCalls(demoOpen(), [
      { command: 'npm test', status: 'error', resultPreview: '1 failed' },
      { command: 'git commit -m "Busy sessions first"' },
      { command: 'npx vitest run', resultPreview: 'Tests  12 passed (12)' },
    ]);
    const { navigate } = renderStrip(open);
    expect(strip()).toHaveTextContent(
      '3 files edited · 1 created · tests ✓ 2 runs, last passed · 1 commit · 2 failures',
    );
    const tests = within(strip()).getByRole('button', { name: /tests/ });
    fireEvent.click(tests);
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 'req_m3', card: `tool:t_extra${serial}` }),
    );
    const commit = within(strip()).getByRole('button', { name: /commit/ });
    expect(commit).toHaveAttribute('title', 'Last commit: Busy sessions first');
    fireEvent.click(commit);
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ card: `tool:t_extra${serial - 1}` }),
    );
  });

  it('marks a last run that failed, and counts the questions asked', () => {
    const open = withCalls(demoOpen(), [
      { command: 'pytest', resultPreview: '3 passed' },
      { command: 'pytest', resultPreview: 'FAILED tests/test_a.py::test_x' },
    ]);
    const read = open.toolCalls.get('tu_m2j') as ToolCall;
    open.toolCalls.set('t_ask', {
      ...read,
      id: 't_ask',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Which one?' }] },
    });
    renderStrip(open);
    expect(strip()).toHaveTextContent('tests ✗ 2 runs, last failed · 1 question · 1 failure');
  });

  it('goes to the response of a failed model call when that failed first', () => {
    const open = demoOpen();
    const first = open.requests.get('req_m1') as ModelRequest;
    const requests = new Map(open.requests).set('req_m1', {
      ...first,
      status: 'error',
      error: { message: 'Overloaded', status: 529, retryAttempt: 1 },
    });
    const { navigate } = renderStrip({ ...open, requests });
    expect(strip()).toHaveTextContent('2 failures');
    fireEvent.click(within(strip()).getByRole('button', { name: /failures/ }));
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'main',
      turnId: 'turn_m1',
      requestId: 'req_m1',
      card: 'response',
    });
  });

  it('is not drawn when the agent did none of it', () => {
    // The explorer only searched.
    renderStrip(demoOpen(), 'a1b2c3d4e5f60718');
    expect(screen.queryByRole('region', { name: 'Outcome' })).toBeNull();
  });

  it('speaks Chinese, its CJK out of the mono face', () => {
    renderStrip(demoOpen(), 'main', 'zh');
    expect(strip('结果')).toHaveTextContent('修改了 3 个文件 · 新建 1 个 · 1 次失败');
    expect(cjkInMono(document.body)).toEqual([]);
  });

  it('sits between the summary bar and the toolbar of the session page', async () => {
    const open = demoOpen();
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <UiContext.Provider value={{ follow: true, setFollow: vi.fn() }}>
          <SessionView
            open={open}
            route={{
              sessionId: open.id,
              agentId: 'main',
              tab: 'steps',
              turnId: null,
              requestId: null,
            }}
            navigate={vi.fn()}
          />
        </UiContext.Provider>
      </I18nContext.Provider>,
    );
    const summary = screen.getByRole('region', { name: 'Summary' });
    const tabs = screen.getByRole('tablist');
    // Its chunk loads beside the first one.
    await screen.findByRole('region', { name: 'Outcome' });
    expect(summary.nextElementSibling).toBe(strip());
    expect(strip().nextElementSibling?.contains(tabs)).toBe(true);
  });
});

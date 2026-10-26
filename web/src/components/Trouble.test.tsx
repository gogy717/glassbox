import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentNode, ModelRequest, ToolCall } from '../../../src/core/model.js';
import type { OpenSession } from '../data/store';
import { I18nContext, makeI18n } from '../i18n';
import { cjkInMono } from '../test/cjk';
import { DEMO_NOW, demoOpen } from '../test/demo';
import { UiContext } from '../ui';
import { Trouble } from './Trouble';
import css from './Trouble.module.css';

const NOW = DEMO_NOW.getTime();

function renderTrouble(
  open: OpenSession = demoOpen(),
  agentId = 'main',
  locale: 'en' | 'zh' = 'en',
) {
  const navigate = vi.fn();
  const setFollow = vi.fn();
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <UiContext.Provider value={{ follow: true, setFollow }}>
        <Trouble open={open} agentId={agentId} now={NOW} navigate={navigate} />
      </UiContext.Provider>
    </I18nContext.Provider>,
  );
  return { navigate, setFollow };
}

/**
 * The demo with `n` more failing `npm test` calls of `agentId`, a minute apart, to the clock:
 * one a model call, in the prompt it runs.
 */
function looping(open: OpenSession, n: number, agentId = 'main', turnId = 'turn_m3') {
  const toolCalls = new Map(open.toolCalls);
  const requests = new Map(open.requests);
  const base = open.requests.get('req_m1') as ModelRequest;
  for (let i = 0; i < n; i++) {
    const at = new Date(NOW - (n - i) * 60_000).toISOString();
    const id = `t_loop${i}`;
    const requestId = `req_loop${i}`;
    requests.set(requestId, {
      ...base,
      id: requestId,
      agentId,
      turnId,
      startedAt: at,
      endedAt: at,
      toolCallIds: [id],
    });
    toolCalls.set(id, {
      id,
      agentId,
      requestId,
      name: 'Bash',
      input: { command: 'npm test -- --run' },
      status: 'error',
      startedAt: at,
      endedAt: at,
      durationMs: 1000,
      resultPreview: 'FAIL src/a.test.ts',
      hasFullResult: false,
      spawned: null,
    } satisfies ToolCall);
  }
  return { ...open, toolCalls, requests };
}

describe('Trouble', () => {
  it('says there is none, in words beside Data complete', () => {
    renderTrouble();
    const button = screen.getByRole('button', { name: 'Signs of trouble · No trouble' });
    expect(button.querySelector(`.${css.dot}`)).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Signs of trouble' })).toHaveTextContent(
      'Nothing looks stuck',
    );
  });

  it('counts the signs and lists each, a link to the call it points at', () => {
    const { navigate, setFollow } = renderTrouble(looping(demoOpen(), 4));
    const button = screen.getByRole('button', { name: 'Signs of trouble · 2 signs of trouble' });
    expect(button.querySelector(`.${css.dot}`)).not.toBeNull();
    fireEvent.click(button);
    const panel = screen.getByRole('dialog', { name: 'Signs of trouble' });
    const items = within(panel).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([
      'Repeated npm test -- --run 4×',
      '4 tool calls failed in a row',
    ]);
    // The command in the mono face, as the execution chain shows it.
    expect(within(items[0] as HTMLElement).getByText('npm test -- --run')).toHaveClass(
      css.target as string,
    );
    fireEvent.click(items[1] as HTMLElement);
    expect(setFollow).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenLastCalledWith({
      tab: 'flow',
      agentId: 'main',
      turnId: 'turn_m3',
      requestId: 'req_loop3',
      card: 'tool:t_loop3',
    });
    // Gone once followed.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says nothing of a session that no longer runs, however it ended', () => {
    const open = looping(demoOpen(), 4);
    const main = open.agents.get('main') as AgentNode;
    renderTrouble({
      ...open,
      session: { ...open.session, live: 'closed' },
      agents: new Map(open.agents).set('main', { ...main, status: 'complete' }),
    });
    expect(screen.getByRole('button', { name: 'Signs of trouble · No trouble' })).toBeVisible();
  });

  it('names the sub-agent a sign belongs to', () => {
    const open = looping(demoOpen(), 3, 'af00000000000002', 'turn_w2');
    renderTrouble(open);
    fireEvent.click(screen.getByRole('button', { name: /Signs of trouble/ }));
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveTextContent('Repeated npm test -- --run 3× · recon:prior-art');
  });

  it('speaks Chinese, its CJK out of the mono face', () => {
    renderTrouble(looping(demoOpen(), 4), 'main', 'zh');
    fireEvent.click(screen.getByRole('button', { name: '异常迹象 · 2 个异常迹象' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('连续 4 次工具调用失败');
    expect(cjkInMono(document.body)).toEqual([]);
  });
});

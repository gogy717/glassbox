import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../../src/core/model.js';
import type { OpenSession } from '../../data/store';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { UiContext } from '../../ui';
import { McpUsage } from './McpUsage';

const SUB = 'a1b2c3d4e5f60718';

/** The demo, with MCP calls: three by the main agent (one failed), one by its sub-agent. */
function withMcp(open = demoOpen()): OpenSession {
  const reqOf = (agentId: string) =>
    [...open.requests.values()].find((r) => r.agentId === agentId && r.status === 'complete');
  const main = reqOf('main');
  const sub = reqOf(SUB);
  if (!main || !sub) throw new Error('fixture');
  const at = Date.parse(main.endedAt ?? '');
  const iso = (sec: number) => new Date(at + sec * 1000).toISOString();
  const mk = (id: string, name: string, over: Partial<ToolCall>): ToolCall => ({
    id,
    agentId: 'main',
    requestId: main.id,
    name,
    input: {},
    status: 'complete',
    startedAt: iso(0),
    endedAt: iso(1),
    durationMs: 1000,
    resultPreview: 'ok',
    hasFullResult: true,
    spawned: null,
    resultChars: 4_000,
    ...over,
  });
  const calls = [
    mk('m1', 'mcp__tracker__list_issues', { startedAt: iso(1), durationMs: 800 }),
    mk('m2', 'mcp__tracker__get_issue', {
      startedAt: iso(3),
      status: 'error',
      durationMs: 1_200,
      resultPreview: 'issue not found',
      resultChars: 15,
    }),
    mk('m3', 'mcp__docs__search', { startedAt: iso(5), durationMs: 400, resultChars: 12_000 }),
    mk('m4', 'mcp__tracker__list_issues', {
      agentId: SUB,
      requestId: sub.id,
      startedAt: iso(7),
      durationMs: 600,
    }),
  ];
  const toolCalls = new Map(open.toolCalls);
  for (const c of calls) toolCalls.set(c.id, c);
  return { ...open, toolCalls };
}

function renderMcp(open: OpenSession, agentId = 'main', locale: 'en' | 'zh' = 'en') {
  const navigate = vi.fn();
  const setFollow = vi.fn();
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <UiContext.Provider value={{ follow: true, setFollow }}>
        <McpUsage open={open} agentId={agentId} navigate={navigate} />
      </UiContext.Provider>
    </I18nContext.Provider>,
  );
  return { navigate, setFollow };
}

afterEach(cleanup);

describe('the MCP section of Where tokens went', () => {
  it('shows nothing when the session made no MCP call', () => {
    const { container } = render(
      <I18nContext.Provider value={makeI18n('en')}>
        <UiContext.Provider value={{ follow: true, setFollow: vi.fn() }}>
          <McpUsage open={demoOpen()} agentId="main" navigate={vi.fn()} />
        </UiContext.Provider>
      </I18nContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each server by calls, with its failures, time and result size, every agent included', () => {
    renderMcp(withMcp());
    const section = screen.getByRole('region', { name: /MCP servers/ });
    const rows = within(section).getAllByRole('button', { expanded: false });
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^tracker.*3 calls.*1 failed/),
      expect.stringMatching(/^docs.*1 call(?!s)/),
    ]);
    // 800 + 1,200 + 600 ms; three results of 4,000, 15 and 4,000 characters.
    expect(rows[0]).toHaveTextContent('2.6s in all');
    expect(rows[0]).toHaveTextContent('median 800ms');
    expect(rows[0]).toHaveTextContent(`≈ ${(2_004).toLocaleString('en')} tokens`);
    expect(rows[1]).toHaveTextContent(`≈ ${(3_000).toLocaleString('en')} tokens`);
  });

  it('unfolds a server into its tools, each call a link to it in the execution chain', () => {
    const open = withMcp();
    const { navigate, setFollow } = renderMcp(open);
    fireEvent.click(screen.getByRole('button', { name: /^tracker/ }));
    const tools = screen.getByRole('list', { name: 'Tools of tracker' });
    const items = within(tools).getAllByRole('listitem', { name: /./ });
    expect(items).toEqual([
      within(tools).getByRole('listitem', { name: 'list_issues' }),
      within(tools).getByRole('listitem', { name: 'get_issue' }),
    ]);
    expect(items[0]).toHaveTextContent('2 calls');
    expect(items[1]).toHaveTextContent('1 failed');
    const calls = within(items[1] as HTMLElement).getAllByRole('button', {
      name: /Show in execution chain/,
    });
    expect(calls).toHaveLength(1);
    fireEvent.click(calls[0] as HTMLElement);
    const req = open.requests.get(open.toolCalls.get('m2')?.requestId ?? '');
    expect(setFollow).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith({
      tab: 'flow',
      agentId: 'main',
      turnId: req?.turnId,
      requestId: req?.id,
      card: 'tool:m2',
    });
  });

  it('counts the selected agent alone when its sub-agents are left out', () => {
    renderMcp(withMcp());
    const toggle = screen.getByRole('button', { name: 'Include sub-agents' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /^tracker/ })).toHaveTextContent('2 calls');
  });

  it('says so when the selected agent called none itself but its sub-agents did', () => {
    const open = withMcp();
    const own = new Map(
      [...open.toolCalls].filter(([, c]) => !(c.agentId === 'main' && c.name.startsWith('mcp__'))),
    );
    renderMcp({ ...open, toolCalls: own });
    fireEvent.click(screen.getByRole('button', { name: 'Include sub-agents' }));
    expect(screen.getByText('This agent made no MCP call of its own')).toBeInTheDocument();
  });

  it('counts a sub-agent’s own calls without a toggle, and shows nothing for an agent that made none', () => {
    const open = withMcp();
    renderMcp(open, SUB);
    expect(screen.queryByRole('button', { name: 'Include sub-agents' })).toBeNull();
    expect(screen.getByRole('button', { name: /^tracker/ })).toHaveTextContent('1 call');
    cleanup();
    // The workflow's agents called none.
    const other = [...open.agents.keys()].find(
      (id) => id !== 'main' && id !== SUB && open.agents.get(id)?.parentId !== SUB,
    );
    renderMcp(open, other);
    expect(screen.queryByRole('region', { name: /MCP servers/ })).toBeNull();
  });

  it('speaks Chinese', () => {
    renderMcp(withMcp(), 'main', 'zh');
    const section = screen.getByRole('region', { name: /MCP 服务器/ });
    expect(within(section).getByRole('button', { name: /^tracker/ })).toHaveTextContent('3 次调用');
    expect(within(section).getByRole('button', { name: '包括子代理' })).toBeInTheDocument();
  });
});

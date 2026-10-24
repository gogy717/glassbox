import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest, RequestDetail, ToolCall } from '../../../../src/core/model.js';
import { SessionAgentContext } from '../../data/session-agent';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { useFakeLayout } from '../../test/layout';
import { moduleCssValue } from '../../test/module-css';
import type { CardKey } from './cards';
import { DetailPanel } from './DetailPanel';
import panelCss from './DetailPanel.module.css';
import { resetDetailPrefs } from './detail/prefs';

const open = demoOpen();
const req = (id: string) => open.requests.get(id) as ModelRequest;
const tools = (r: ModelRequest) => r.toolCallIds.map((id) => open.toolCalls.get(id) as ToolCall);

function renderPanel(r: ModelRequest, card: CardKey, onClose = vi.fn(), agent = 'claude-code') {
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <SessionAgentContext.Provider value={agent}>
        <DetailPanel sessionId={open.id} req={r} tools={tools(r)} card={card} onClose={onClose} />
      </SessionAgentContext.Provider>
    </I18nContext.Provider>,
  );
  return onClose;
}

const detail: RequestDetail = {
  requestId: 'req_m1',
  completeness: 'partial',
  notes: ['2 messages could not be resolved'],
  params: { model: 'claude-opus-5-5', max_tokens: 64000 },
  system: [{ type: 'text', text: 'You are Claude Code…' }],
  tools: [{ name: 'Bash' }],
  messages: [{ role: 'user', content: 'Busy sessions first' }],
};

function stubFetch(body: unknown, status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('DetailPanel', () => {
  useFakeLayout();
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    resetDetailPrefs();
  });

  it('loads what the request sent, with completeness and notes', async () => {
    const fetch = stubFetch(detail);
    renderPanel(req('req_m1'), 'request');
    const panel = screen.getByRole('region', { name: 'Request details' });
    // F-web W8: a quick local fetch never flashes "Loading…".
    expect(within(panel).queryByText('Loading…')).toBeNull();
    expect(await within(panel).findByText('Partly reconstructed')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      `/api/sessions/${encodeURIComponent(open.id)}/requests/req_m1/detail`,
      expect.anything(),
    );
    expect(within(panel).getByText('2 messages could not be resolved')).toBeInTheDocument();
    for (const h of ['System prompt', 'Messages', 'Tool definitions', 'Parameters'])
      expect(within(panel).getByRole('heading', { name: h })).toBeInTheDocument();
  });

  it('shows what was sent readable by default, with the JSON one click away and remembered', async () => {
    stubFetch({
      ...detail,
      messages: [
        { role: 'user', content: 'Busy sessions first' },
        { role: 'assistant', content: 'Sorting now:\n```ts\nsessions.sort(byActivity);\n```' },
      ],
    });
    renderPanel(req('req_m1'), 'request');
    const panel = screen.getByRole('region', { name: 'Request details' });
    await within(panel).findByText('Partly reconstructed');
    // Readable: the newest message on top, its code a block of its own, nothing to expand.
    const [newest] = within(panel).getAllByRole('article');
    expect(newest).toHaveAccessibleName('Assistant message #2 of 2');
    await vi.waitFor(() =>
      expect(newest?.querySelector('pre')?.textContent).toBe('sessions.sort(byActivity);'),
    );
    expect(within(panel).queryByText('{} JSON')).toBeNull();

    fireEvent.click(within(panel).getByRole('radio', { name: 'JSON' }));
    expect(within(panel).queryByRole('article')).toBeNull();
    expect(within(panel).getAllByText('{} JSON')).toHaveLength(4);
    expect(JSON.parse(localStorage.getItem('glassbox.detail') ?? '{}')).toMatchObject({
      view: 'json',
    });
  });

  it('reloads what was sent once an in-flight request completes', async () => {
    const fetch = stubFetch(detail);
    const live = req('req_m6');
    const onClose = vi.fn();
    const { rerender } = render(
      <I18nContext.Provider value={makeI18n('en')}>
        <DetailPanel sessionId={open.id} req={live} tools={[]} card="request" onClose={onClose} />
      </I18nContext.Provider>,
    );
    await screen.findByText('Partly reconstructed');
    expect(fetch).toHaveBeenCalledTimes(1);
    stubFetch({ ...detail, completeness: 'full', notes: [] });
    rerender(
      <I18nContext.Provider value={makeI18n('en')}>
        <DetailPanel
          sessionId={open.id}
          req={{ ...live, status: 'complete', endedAt: live.startedAt }}
          tools={[]}
          card="request"
          onClose={onClose}
        />
      </I18nContext.Provider>,
    );
    expect(await screen.findByText('Fully reconstructed')).toBeInTheDocument();
  });

  it('heads the panel with the card and the call, and says how complete it is as a mark', async () => {
    stubFetch({ ...detail, completeness: 'full', notes: [] });
    renderPanel(req('req_m1'), 'request');
    const panel = screen.getByRole('region', { name: 'Request details' });
    const head = within(panel).getByText('Request details').parentElement as HTMLElement;
    // "call #1": the number in the mono face, the word in the UI face (调用 never goes mono).
    expect(head).toHaveTextContent('call #1');
    expect(within(head).getByText('1', { selector: '.figure' })).toBeInTheDocument();
    expect(within(head).queryByText(/call/, { selector: '.figure' })).toBeNull();
    const full = await within(head).findByText('Fully reconstructed');
    // A quiet check and the word, never a filled badge.
    expect(full.closest('[data-state]')).toHaveAttribute('data-state', 'complete');
    // One Readable | JSON switch for the panel, in its head.
    expect(within(panel).getAllByRole('radiogroup', { name: 'Show as' })).toHaveLength(1);
    expect(within(head).getByRole('radiogroup', { name: 'Show as' })).toBeInTheDocument();
  });

  it('copies what the panel shows, as JSON', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderPanel(req('req_m2'), 'tool:tu_m2b');
    const panel = screen.getByRole('region', { name: 'Tool call details' });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Copy' }));
    });
    const copied = JSON.parse(writeText.mock.calls[0]?.[0] ?? '');
    expect(copied).toMatchObject({
      name: 'Edit',
      input: { file_path: '/repo/src/server/store.ts' },
    });
  });

  it('maximizes into a dialog, and gives focus back when it closes', () => {
    renderPanel(req('req_m2'), 'tool:tu_m2b');
    const panel = screen.getByRole('region', { name: 'Tool call details' });
    const max = within(panel).getByRole('button', { name: 'Maximize' });
    fireEvent.click(max);
    const dialog = screen.getByRole('dialog', { name: 'Tool call details · call #2' });
    expect(within(dialog).getByRole('heading', { name: 'Arguments' })).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(max).toHaveFocus();
  });

  // Final review M7 (G4): one body at a time; while maximized the panel says where it went.
  it('mounts the body once, in the dialog while maximized and back in the panel after', () => {
    renderPanel(req('req_m2'), 'tool:tu_m2b');
    const panel = screen.getByRole('region', { name: 'Tool call details' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Maximize' }));
    const dialog = screen.getByRole('dialog', { name: 'Tool call details · call #2' });
    expect(screen.getAllByRole('heading', { name: 'Arguments' })).toHaveLength(1);
    expect(within(dialog).getByRole('heading', { name: 'Arguments' })).toBeInTheDocument();
    expect(within(panel).getByText('Shown enlarged')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(within(panel).getByRole('heading', { name: 'Arguments' })).toBeInTheDocument();
    expect(within(panel).queryByText('Shown enlarged')).toBeNull();
  });

  it('explains when the request detail could not be loaded, and retries', async () => {
    stubFetch({ error: 'boom' }, 500);
    renderPanel(req('req_m1'), 'request');
    expect(await screen.findByText('Could not load: boom')).toBeInTheDocument();
    stubFetch(detail);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Partly reconstructed')).toBeInTheDocument();
  });

  it('does not fetch when this Claude Code version recorded no request detail', () => {
    const fetch = stubFetch(detail);
    renderPanel({ ...req('req_m1'), hasDetail: false }, 'request');
    expect(
      screen.getByText('This Claude Code version did not record the request'),
    ).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the response: thinking with its time and tokens, the text and raw usage', () => {
    renderPanel(req('req_m1'), 'response');
    const panel = screen.getByRole('region', { name: 'Response details' });
    expect(panel).toHaveTextContent('Looking for where the session list is sorted');
    expect(within(panel).getByText('Thought for 8.4s · 610 thinking tokens')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Let me look at how sessions are discovered first.');
    expect(within(panel).getByRole('heading', { name: 'Usage & timing' })).toBeInTheDocument();
  });

  it('renders the reply’s markdown, with its source one click away', async () => {
    const reply = '## Plan\n\n| Step | Done |\n|---|---|\n| sort | yes |';
    renderPanel(
      { ...req('req_m1'), blocks: [{ kind: 'text', text: reply, at: '2026-10-23T10:00:00.000Z' }] },
      'response',
    );
    const panel = screen.getByRole('region', { name: 'Response details' });
    expect(
      await within(panel).findByRole('heading', { level: 6, name: 'Plan' }),
    ).toBeInTheDocument();
    // The reply scrolls itself: the wheel must not be taken over by the chain around it.
    expect(
      within(panel).getByRole('heading', { name: 'Plan' }).closest('[data-scroll-region]'),
    ).not.toBeNull();
    expect(within(panel).getByRole('table')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Source' }));
    expect(within(panel).queryByRole('table')).toBeNull();
    expect(panel.querySelector('pre')?.textContent).toContain('## Plan');
  });

  it('shows the usage and timing as a list, the JSON one click away', () => {
    renderPanel(req('req_m1'), 'response');
    const panel = screen.getByRole('region', { name: 'Response details' });
    expect(within(panel).getByText('usage.thinking')).toBeInTheDocument();
    expect(within(panel).getByText('610')).toBeInTheDocument();
    expect(within(panel).getByText('claude-opus-5-5')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('radio', { name: 'JSON' }));
    expect(within(panel).getByText('{} JSON')).toBeInTheDocument();
  });

  it('swaps in the final reply when an open in-flight request completes', () => {
    const live = req('req_m6');
    const done = { ...req('req_m1'), id: live.id, turnId: live.turnId };
    const { rerender } = render(
      <I18nContext.Provider value={makeI18n('en')}>
        <DetailPanel sessionId={open.id} req={live} tools={[]} card="response" onClose={() => {}} />
      </I18nContext.Provider>,
    );
    expect(screen.queryByText(/Let me look at how sessions/)).toBeNull();
    rerender(
      <I18nContext.Provider value={makeI18n('en')}>
        <DetailPanel sessionId={open.id} req={done} tools={[]} card="response" onClose={() => {}} />
      </I18nContext.Provider>,
    );
    expect(screen.getByText(/Let me look at how sessions/)).toBeInTheDocument();
  });

  it('says when thinking content was not recorded', () => {
    renderPanel(req('req_m2'), 'response');
    expect(screen.getByText('Thinking content not recorded')).toBeInTheDocument();
  });

  it('says Codex thinking is encrypted rather than missing', () => {
    renderPanel(req('req_m2'), 'response', vi.fn(), 'codex');
    expect(
      screen.getByText('Codex encrypts its thinking, so it cannot be shown'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Thinking content not recorded')).toBeNull();
  });

  it('shows a tool call’s arguments readable, with the JSON one click away', () => {
    renderPanel(req('req_m2'), 'tool:tu_m2b');
    const panel = screen.getByRole('region', { name: 'Tool call details' });
    const args = within(panel)
      .getByRole('heading', { name: 'Arguments' })
      .closest('div') as HTMLElement;
    expect(within(args).getByText('file_path')).toBeInTheDocument();
    expect(within(args).queryByText('{} JSON')).toBeNull();
    // One Readable | JSON switch, in the panel's head.
    fireEvent.click(within(panel).getByRole('radio', { name: 'JSON' }));
    expect(within(args).getByText('{} JSON')).toBeInTheDocument();
  });

  it('shows a tool call’s arguments, result and timing, and loads the full result on request', async () => {
    const fetch = stubFetch({ toolCallId: 'tu_m2b', result: 'FULL RESULT TEXT' });
    renderPanel(req('req_m2'), 'tool:tu_m2b');
    const panel = screen.getByRole('region', { name: 'Tool call details' });
    expect(within(panel).getByRole('heading', { name: 'Arguments' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('String to replace not found in file.');
    expect(panel).toHaveTextContent('Failed');
    expect(panel).toHaveTextContent('50ms');
    fireEvent.click(within(panel).getByRole('button', { name: 'Load full result' }));
    expect(await within(panel).findByText('FULL RESULT TEXT')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      `/api/sessions/${encodeURIComponent(open.id)}/tool-calls/tu_m2b/result`,
      expect.anything(),
    );
  });

  it('keeps a loaded full result when maximized, and copies it in full', async () => {
    const fetch = stubFetch({ toolCallId: 'tu_m2b', result: 'FULL RESULT TEXT' });
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderPanel(req('req_m2'), 'tool:tu_m2b');
    const panel = screen.getByRole('region', { name: 'Tool call details' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Load full result' }));
    await within(panel).findByText('FULL RESULT TEXT');

    fireEvent.click(within(panel).getByRole('button', { name: 'Maximize' }));
    const dialog = screen.getByRole('dialog', { name: 'Tool call details · call #2' });
    // The same result, not a second fetch behind a second "Load full result".
    expect(within(dialog).getByText('FULL RESULT TEXT')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Load full result' })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Copy' }));
    });
    expect(JSON.parse(writeText.mock.calls[0]?.[0] ?? '')).toMatchObject({
      name: 'Edit',
      result: 'FULL RESULT TEXT',
    });
  });

  it('wraps its head in a narrow column, so Maximize and Close stay on screen', () => {
    renderPanel(req('req_m2'), 'tool:tu_m2b');
    const close = screen.getByRole('button', { name: 'Hide details' });
    const tools = close.parentElement as HTMLElement;
    const head = tools.parentElement as HTMLElement;
    const sheet = `${import.meta.dirname}/DetailPanel.module.css`;
    expect(moduleCssValue(sheet, panelCss, head, 'flex-wrap')).toBe('wrap');
    // The buttons move as one, to the right of the next line.
    expect(moduleCssValue(sheet, panelCss, tools, 'flex-wrap')).toBe('nowrap');
    expect(moduleCssValue(sheet, panelCss, tools, 'margin-left')).toBe('auto');
  });

  it('closes from its header', () => {
    const onClose = renderPanel(req('req_m1'), 'response');
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(onClose).toHaveBeenCalled();
  });
});

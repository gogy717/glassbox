import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoSnapshot } from '../../../../../src/core/fixtures/demo.js';
import { demoRequestDetail } from '../../../../../src/core/fixtures/demo-detail.js';
import type { ModelRequest, RequestDetail, ToolCall } from '../../../../../src/core/model.js';
import { I18nContext, makeI18n } from '../../../i18n';
import { cjkInMono } from '../../../test/cjk';
import { DEMO_NOW, demoOpen } from '../../../test/demo';
import { ContextView } from './ContextView';
import css from './context.module.css';

const open = demoOpen();
const snapshot = createDemoSnapshot(DEMO_NOW);
const req = (id: string) => open.requests.get(id) as ModelRequest;
const sent = (id: string) => demoRequestDetail(snapshot, id) as RequestDetail;

function renderView(
  r: ModelRequest,
  detail: RequestDetail | null,
  locale: 'en' | 'zh' = 'en',
  onOpenCall = vi.fn(),
) {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <ContextView req={r} detail={detail} calls={open.toolCalls} onOpenCall={onOpenCall} />
    </I18nContext.Provider>,
  );
  return onOpenCall;
}

const rows = () =>
  within(document.querySelector(`.${css.list}`) as HTMLElement).getAllByRole('listitem');
const count = () => document.querySelector(`.${css.count}`);

describe('ContextView', () => {
  it('says how big the context was, estimated from the request’s own count', () => {
    renderView(req('req_m3'), sent('req_m3'));
    expect(screen.getByText(/About/)).toHaveTextContent('About 37,800 tokens in context');
    expect(
      screen.getByText(/^Estimated: the request’s reported input, cache reads and cache writes/),
    ).toBeInTheDocument();
  });

  it('lists the parts largest first, each with its estimated tokens and share', () => {
    renderView(req('req_m3'), sent('req_m3'));
    const [first, second] = rows();
    expect(first).toHaveTextContent('Tool result');
    expect(first).toHaveTextContent('Read store.ts');
    expect(first).toHaveTextContent('≈8.65K');
    expect(first).toHaveTextContent('22.9%');
    expect(second).toHaveTextContent('Read model.ts');
    // What this request added: the results of the calls before it.
    expect(within(first as HTMLElement).getByText('this request')).toBeInTheDocument();
    expect(count()).toHaveTextContent('36 parts');
  });

  it('draws the parts as one bar, coloured by who put them there, its legend in words', () => {
    renderView(req('req_m3'), sent('req_m3'));
    const segments = document.querySelectorAll(`.${css.seg}`);
    expect(segments.length).toBeGreaterThan(3);
    // The largest first, its title naming it.
    expect(segments[0]).toHaveAttribute('data-group', 'results');
    expect(segments[0]?.getAttribute('title')).toMatch(/^Tool result · Read store\.ts · ≈8\.65K/);
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringMatching(/^System prompt & tools/),
      expect.stringMatching(/^User/),
      expect.stringMatching(/^Model/),
      expect.stringMatching(/^Tool results/),
    ]);
  });

  it('filters the parts by what they are and name', () => {
    renderView(req('req_m3'), sent('req_m3'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter parts' }), {
      target: { value: 'model.ts' },
    });
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('Tool result'),
      expect.stringContaining('Tool call'),
    ]);
    expect(count()).toHaveTextContent('2 of 36 parts');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing like it' } });
    expect(screen.getByText('No part matches “nothing like it”')).toBeInTheDocument();
  });

  it('opens a tool result’s call', () => {
    const onOpenCall = renderView(req('req_m3'), sent('req_m3'));
    fireEvent.click(
      within(rows()[0] as HTMLElement).getByRole('button', { name: 'Read store.ts' }),
    );
    expect(onOpenCall).toHaveBeenCalledWith(open.toolCalls.get('tu_m2a') as ToolCall);
  });

  it('weighs a request in flight by characters alone, and says so', () => {
    renderView(req('req_m6'), sent('req_m6'));
    expect(
      screen.getByText(
        'Estimated from characters alone: the request has not reported its tokens yet.',
      ),
    ).toBeInTheDocument();
  });

  it('says why there is no bill when the request body was not recorded', () => {
    renderView({ ...req('req_m1'), hasDetail: false }, null);
    expect(
      screen.getByText(
        'Not available for this request: this Claude Code version did not record what it sent.',
      ),
    ).toBeInTheDocument();
  });

  it('says so for an agent that keeps the system prompt and tools only', () => {
    renderView(req('req_m1'), { ...sent('req_m1'), completeness: 'partial', messages: null });
    expect(screen.getByText(/records the system prompt and tools, not the messages/)).toBeVisible();
  });

  it('speaks Chinese, its CJK out of the mono face', () => {
    renderView(req('req_m3'), sent('req_m3'), 'zh');
    expect(screen.getByText(/上下文约/)).toHaveTextContent('上下文约 37,800 token');
    expect(rows()[0]).toHaveTextContent('工具结果');
    expect(cjkInMono(document.body)).toEqual([]);
  });
});

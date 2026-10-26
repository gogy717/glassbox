import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Turn } from '../../../src/core/model.js';
import { I18nContext, makeI18n } from '../i18n';
import { cjkInMono } from '../test/cjk';
import { DEMO_NOW, demoOpen } from '../test/demo';
import { SummaryBar } from './SummaryBar';

const value = (label: string, region = 'Summary') =>
  within(screen.getByRole('region', { name: region }))
    .getByText(label)
    .parentElement?.querySelector('[data-value]')?.textContent;

describe('SummaryBar figures', () => {
  // The demo's last turn runs: its active time and span run to the clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads token counts compact, the exact count in the tooltip and for screen readers', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" />
      </I18nContext.Provider>,
    );
    const bar = screen.getByRole('region', { name: 'Summary' });
    expect(value('Input')).toBe('1.84M');
    expect(value('Output (thinking)')).toBe('42K (27.1K)');
    const input = within(bar).getByText('Input').parentElement as HTMLElement;
    expect(input).toHaveAttribute('title', '1,838,850');
    expect(input.querySelector('[data-value]')).toHaveAttribute('aria-hidden', 'true');
    expect(input.querySelector('.visually-hidden')).toHaveTextContent('1,838,850');
    expect(within(bar).getByText('Output (thinking)').parentElement).toHaveAttribute(
      'title',
      '42,040 (27,050)',
    );
    // Counts stay exact: nobody needs "1.2K tool calls".
    expect(value('Model calls')).toBe('28');
    expect(within(bar).getByText('Model calls').parentElement).not.toHaveAttribute('title');
  });

  it('sets a Chinese unit out of the mono face', () => {
    render(
      <I18nContext.Provider value={makeI18n('zh')}>
        <SummaryBar open={demoOpen()} agentId="main" />
      </I18nContext.Provider>,
    );
    expect(value('输入', '汇总')).toBe('184万');
    expect(value('输出(思考)', '汇总')).toBe('4.2万 (2.71万)');
    expect(cjkInMono(document.body)).toEqual([]);
  });

  it('says how many days the active time is spread over once a session crosses midnight', () => {
    const open = demoOpen();
    const first = open.turns.get('turn_m1') as Turn;
    // The first prompt two days before the clock; the last turn still runs: three days.
    const early = {
      ...first,
      startedAt: new Date(DEMO_NOW.getTime() - 2 * 86_400_000).toISOString(),
    };
    const spread = { ...open, turns: new Map(open.turns).set(first.id, early) };
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={spread} agentId="main" />
      </I18nContext.Provider>,
    );
    expect(value('Active time')).toMatch(/^\d+h\d+m · over 3 days$/);
    cleanup();
    render(
      <I18nContext.Provider value={makeI18n('zh')}>
        <SummaryBar open={spread} agentId="main" />
      </I18nContext.Provider>,
    );
    expect(value('活跃时长', '汇总')).toMatch(/ · 跨 3 天$/);
    expect(cjkInMono(document.body)).toEqual([]);
    // Within one day the figure stands alone.
    cleanup();
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" />
      </I18nContext.Provider>,
    );
    expect(value('Active time')).toBe('3m4s');
  });
});

describe('SummaryBar', () => {
  it('says whether anything looks stuck right after Data complete, for the agent it shows', () => {
    // At the demo's own clock: three days on, its running prompt would be a sign.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const navigate = vi.fn();
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" navigate={navigate} />
      </I18nContext.Provider>,
    );
    const diagnostics = screen.getByRole('button', { name: /Data diagnostics/ });
    const trouble = screen.getByRole('button', { name: 'Signs of trouble · No trouble' });
    expect(diagnostics.parentElement?.nextElementSibling).toBe(trouble.parentElement);
  });

  it('shows a dash, not 0ms, for an agent that has made no model call', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="nobody" />
      </I18nContext.Provider>,
    );
    expect(value('Model calls')).toBe('0');
    expect(value('Active time')).toBe('—');
  });

  it('shows the time spent once there are calls', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" />
      </I18nContext.Provider>,
    );
    expect(value('Active time')).not.toBe('—');
  });

  it('shows dashes, not zeros, for token figures no call has reported', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="nobody" />
      </I18nContext.Provider>,
    );
    expect(value('Input')).toBe('—');
    expect(value('Cache hit')).toBe('—');
    expect(value('Output (thinking)')).toBe('—');
  });

  it('keeps four figures on narrow screens and the rest behind a disclosure', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" />
      </I18nContext.Provider>,
    );
    const bar = screen.getByRole('region', { name: 'Summary' });
    const extra = [...bar.querySelectorAll('[data-extra]')].map(
      (m) => m.querySelector('.section-label')?.textContent,
    );
    expect(extra).toEqual(['Tool calls', 'Input', 'Cache hit']);
    const more = within(bar).getByRole('button', { name: 'More figures' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(bar).toHaveAttribute('data-more');
    expect(within(bar).getByRole('button', { name: 'Fewer figures' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('carries the token rate behind the disclosure, for narrow screens where the top bar drops it', () => {
    const tail = (...v: number[]) => [...new Array<number>(60 - v.length).fill(0), ...v];
    const minute = Date.UTC(2026, 9, 23, 2, 0, 0);
    const rate = {
      minute: new Date(minute).toISOString(),
      at: new Date(minute + 30_000).toISOString(),
      since: new Date(minute - 3_600_000).toISOString(),
      agents: {
        codex: {
          input: tail(0),
          cacheRead: tail(90_000, 90_000, 90_000, 90_000, 45_000),
          cacheWrite: tail(0),
          output: tail(0),
        },
      },
      coverage: { running: 2, counted: 1, agents: { codex: { running: 2, counted: 1 } } },
    };
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" rate={rate} rateAgent="codex" />
      </I18nContext.Provider>,
    );
    expect(value('Token rate')).toBe('≈90K/min');
    const cell = within(screen.getByRole('region', { name: 'Summary' })).getByText(
      'Token rate',
    ).parentElement;
    expect(cell).toHaveAttribute('data-narrow-only');
    expect(cell).toHaveAttribute('data-extra');
    // I3b M4: in Chinese it reads "≈9万/分钟", the 万 and 分钟 out of the mono face.
    cleanup();
    render(
      <I18nContext.Provider value={makeI18n('zh')}>
        <SummaryBar open={demoOpen()} agentId="main" rate={rate} rateAgent="codex" />
      </I18nContext.Provider>,
    );
    expect(screen.getByRole('region', { name: '汇总' })).toHaveTextContent('≈9万/分钟');
    expect(cjkInMono(document.body)).toEqual([]);
  });
});

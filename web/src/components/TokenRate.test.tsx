import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MINUTE_MS, RATE_MINUTES, type TokenRate as Rate } from '../../../src/shared/rate.js';
import { I18nContext, makeI18n } from '../i18n';
import { TokenRate } from './TokenRate';

const MINUTE = Date.UTC(2026, 9, 24, 10, 59, 0);
const flat = (n = 0) => new Array<number>(RATE_MINUTES).fill(n);
/** The last values of a series, the rest zero. */
const tail = (...values: number[]) => [...flat().slice(values.length), ...values];

/**
 * Claude Code: 5.95M tokens in the last five buckets, 4.5 minutes of them counted (1.32M/min).
 * Codex: 0.45M over the same (100K/min). oh-my-pi: busy until 8 minutes ago, quiet since.
 * All: 6.4M / 4.5 = 1.42M/min; last minute 1.48M; the hour 6.41M; peak 1.53M; now 630K.
 */
const rate = (o: Partial<Rate> = {}): Rate => ({
  minute: new Date(MINUTE).toISOString(),
  at: new Date(MINUTE + 30_000).toISOString(),
  since: new Date(MINUTE - 120 * MINUTE_MS).toISOString(),
  agents: {
    'claude-code': {
      input: flat(),
      cacheRead: tail(1_100_000, 1_200_000, 1_300_000, 1_250_000, 400_000),
      cacheWrite: tail(100_000, 100_000, 100_000, 100_000, 100_000),
      output: tail(40_000, 40_000, 40_000, 40_000, 40_000),
    },
    codex: {
      input: tail(10_000, 10_000, 10_000, 10_000, 10_000),
      cacheRead: tail(80_000, 80_000, 80_000, 80_000, 80_000),
      cacheWrite: flat(),
      output: flat(),
    },
    'oh-my-pi': {
      input: [...flat().slice(10), 5000, 5000, ...flat().slice(52)],
      cacheRead: flat(),
      cacheWrite: flat(),
      output: flat(),
    },
  },
  coverage: {
    running: 2,
    counted: 2,
    agents: { 'claude-code': { running: 1, counted: 1 }, codex: { running: 1, counted: 1 } },
  },
  ...o,
});

function renderRate(
  r: Rate | null,
  agent: string | null = null,
  onAgent = vi.fn(),
  locale: 'en' | 'zh' = 'en',
) {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <TokenRate rate={r} agent={agent} onAgent={onAgent} sessionOpen={false} />
    </I18nContext.Provider>,
  );
  return { onAgent, button: () => screen.getByRole('button', { name: /^Token rate|^Token 速率/ }) };
}

describe('TokenRate', () => {
  it('shows the 5-minute average a minute, with the hour as a line, and says every figure', () => {
    const { button } = renderRate(rate());
    expect(button()).toHaveTextContent('1.42M/min');
    expect(button()).toHaveAccessibleName(
      'Token rate: 1.42M tokens a minute over the last 5 minutes, 1.48M in the last minute, 6.41M in the last hour',
    );
    expect(button().querySelector('polyline')).not.toBeNull();
    expect(button()).toHaveAttribute('aria-expanded', 'false');
  });

  it('leads with the chosen CLI’s tag and shows its own rate', () => {
    const { button } = renderRate(rate(), 'codex');
    expect(within(button()).getByText('Codex')).toHaveAttribute('data-agent', 'codex');
    expect(button()).toHaveTextContent('100K/min');
    expect(button()).toHaveAccessibleName(/^Token rate of Codex: 100K tokens a minute/);
  });

  it('reads a quiet five minutes as a dash, keeping the hour', () => {
    const { button } = renderRate(rate(), 'oh-my-pi');
    expect(button()).toHaveTextContent(/oh-my-pi—$/);
    expect(button().querySelector('[data-idle]')).not.toBeNull();
    expect(button()).toHaveAccessibleName(
      'Token rate of oh-my-pi: nothing in the last 5 minutes, 10K in the last hour',
    );
  });

  it('marks a figure that misses running sessions, and says how many it counts', () => {
    const partial = rate({ coverage: { running: 3, counted: 2, agents: {} } });
    const { button } = renderRate(partial);
    expect(button()).toHaveTextContent('≈1.42M/min');
    expect(button()).toHaveAccessibleName(/; counting 2 of 3 running sessions$/);
  });

  it('draws nothing until the server has sent a rate', () => {
    renderRate(null);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens the details: chips, figures, the hour, each CLI, each token kind and how it is counted', () => {
    const { button } = renderRate(rate());
    fireEvent.click(button());
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'Token rate' });
    // A chip for every CLI spending now; oh-my-pi is quiet and gets none.
    const chips = within(
      within(dialog).getByRole('group', { name: 'Show the rate of' }),
    ).getAllByRole('button');
    expect(chips.map((c) => [c.textContent, c.getAttribute('aria-pressed')])).toEqual([
      ['All', 'true'],
      ['Claude Code', 'false'],
      ['Codex', 'false'],
    ]);
    expect(dialog).toHaveTextContent('5-min average1.42M/min');
    expect(dialog).toHaveTextContent('Last minute1.48M/min');
    expect(dialog).toHaveTextContent('60-min total6.41M');
    expect(
      within(dialog).getByRole('img', {
        name: 'Tokens a minute over the last hour: highest 1.53M, now 630K',
      }),
    ).toBeInTheDocument();
    const rows = within(within(dialog).getByRole('region', { name: 'By CLI' })).getAllByRole(
      'listitem',
    );
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Claude Code: 1.32M tokens a minute, 93% of the total',
      'Codex: 100K tokens a minute, 7% of the total',
      'oh-my-pi: — tokens a minute, 0% of the total',
    ]);
    expect(rows[2]).toHaveTextContent('quiet 8 min');
    const kinds = within(
      within(dialog).getByRole('region', { name: 'By token kind' }),
    ).getAllByRole('listitem');
    expect(kinds.map((k) => k.textContent)).toEqual([
      'Cache read1.26M88%',
      'Cache write111K8%',
      'Uncached input11.1K1%',
      'Output44.4K3%',
    ]);
    expect(dialog).toHaveTextContent(
      /Counting 2 of 2 running sessions\. Counted from the transcripts each CLI writes/,
    );
  });

  it('closes on Escape and hands focus back to the instrument', () => {
    const { button } = renderRate(rate());
    fireEvent.click(button());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it('filters by a CLI from its chip, and back to every CLI from All', () => {
    const { button, onAgent } = renderRate(rate(), 'codex');
    fireEvent.click(button());
    const group = screen.getByRole('group', { name: 'Show the rate of' });
    expect(within(group).getByRole('button', { name: 'Codex' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(group).getByRole('button', { name: 'Claude Code' }));
    expect(onAgent).toHaveBeenLastCalledWith('claude-code');
    fireEvent.click(within(group).getByRole('button', { name: 'All' }));
    expect(onAgent).toHaveBeenLastCalledWith(null);
  });

  it('keeps the chosen CLI’s chip while it is quiet', () => {
    const { button } = renderRate(rate(), 'oh-my-pi');
    fireEvent.click(button());
    const group = screen.getByRole('group', { name: 'Show the rate of' });
    expect(within(group).getByRole('button', { name: 'oh-my-pi' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('speaks Chinese', () => {
    const { button } = renderRate(rate(), null, vi.fn(), 'zh');
    expect(button()).toHaveTextContent('142万/分钟');
    fireEvent.click(button());
    const dialog = screen.getByRole('dialog', { name: 'Token 速率' });
    expect(dialog).toHaveTextContent('最近 60 分钟 · 本机所有 CLI');
    expect(dialog).toHaveTextContent('统计了 2 个运行中会话里的 2 个。');
  });
});

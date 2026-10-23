import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDemoQuota } from '../../../src/core/fixtures/demo.js';
import type { QuotaSnapshot } from '../../../src/core/model.js';
import { I18nContext, makeI18n } from '../i18n';
import { DEMO_NOW } from '../test/demo';
import { QuotaBar } from './QuotaBar';

const NOW = DEMO_NOW.getTime();

function renderBar(quotas: QuotaSnapshot[]) {
  return render(
    <I18nContext.Provider value={makeI18n('en')}>
      <QuotaBar quotas={quotas} now={NOW} />
    </I18nContext.Provider>,
  );
}

const withWindow = (i: number, over: Partial<QuotaSnapshot['windows'][number]>): QuotaSnapshot => {
  const q = createDemoQuota(DEMO_NOW);
  q.windows = q.windows.map((w, j) => (j === i ? { ...w, ...over } : w));
  return q;
};

describe('QuotaBar', () => {
  it('shows one compact meter per window', () => {
    renderBar([createDemoQuota(DEMO_NOW)]);
    const meters = screen.getAllByRole('meter');
    expect(meters.map((m) => m.textContent)).toEqual(['5h 62%', '7d 38%', 'Opus 51%']);
    expect(meters.map((m) => m.getAttribute('aria-valuenow'))).toEqual(['62', '38', '51']);
  });

  it('colours by usage: under 70% neutral, 70–90% amber, 90% and over red', () => {
    renderBar([withWindow(0, { usedPercent: 75 }), withWindow(0, { usedPercent: 93 })]);
    const levels = screen.getAllByRole('meter').map((m) => m.getAttribute('data-level'));
    expect(levels.slice(0, 3)).toEqual(['warn', 'ok', 'ok']);
    expect(levels[3]).toBe('danger');
  });

  it('puts the reset countdown in the tooltip, and says "reset" once it has passed', () => {
    renderBar([withWindow(1, { resetsAt: new Date(NOW - 60_000).toISOString() })]);
    const [five, seven] = screen.getAllByRole('meter');
    expect(five).toHaveAttribute('title', expect.stringContaining('resets in 1h37m'));
    expect(seven).toHaveAttribute('title', expect.stringContaining('Reset'));
  });

  it('shows a window whose reset time has passed as reset, not at its old level', () => {
    renderBar([
      withWindow(0, { usedPercent: 96, resetsAt: new Date(NOW - 20 * 60_000).toISOString() }),
    ]);
    const [five] = screen.getAllByRole('meter');
    expect(five).toHaveTextContent('5h Reset');
    expect(five).toHaveAttribute('data-level', 'ok');
    expect(five).not.toHaveAttribute('data-top');
    const top = screen.getAllByRole('meter').filter((m) => m.hasAttribute('data-top'));
    expect(top.map((m) => m.textContent)).toEqual(['Opus 51%']);
  });

  it('lets assistive technology hear the meters, not just "Plan quota"', () => {
    renderBar([createDemoQuota(DEMO_NOW)]);
    expect(screen.getByRole('button', { name: /Plan quota.*5h 62%.*7d 38%/ })).toBeInTheDocument();
  });

  it('marks the window closest to its limit for narrow screens', () => {
    renderBar([createDemoQuota(DEMO_NOW)]);
    const top = screen.getAllByRole('meter').filter((m) => m.hasAttribute('data-top'));
    expect(top.map((m) => m.textContent)).toEqual(['5h 62%']);
  });

  it('greys out data older than an hour and says how old it is', () => {
    const q = {
      ...createDemoQuota(DEMO_NOW),
      stale: true,
      fetchedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    };
    const { container } = renderBar([q]);
    expect(container.querySelector('[data-stale]')).not.toBeNull();
    expect(screen.getByText('Data from 3 hours ago')).toBeInTheDocument();
  });

  it('opens details: every window, reset times, data age, source, extra usage and the note', () => {
    const q: QuotaSnapshot = {
      ...createDemoQuota(DEMO_NOW),
      extraUsage: { used: 12.5, limit: 50, currency: 'USD' },
    };
    renderBar([q]);
    fireEvent.click(screen.getByRole('button', { name: /Plan quota/ }));
    const dialog = screen.getByRole('dialog', { name: 'Plan quota' });
    expect(within(dialog).getByText('5-hour window')).toBeInTheDocument();
    expect(within(dialog).getByText('Weekly')).toBeInTheDocument();
    expect(within(dialog).getByText('Weekly · Opus')).toBeInTheDocument();
    expect(within(dialog).getByText('62% used')).toBeInTheDocument();
    expect(within(dialog).getByText('Updated 4 minutes ago')).toBeInTheDocument();
    expect(within(dialog).getByText("Source: Claude Code's cache")).toBeInTheDocument();
    // Reset times: a day for the weekly windows three days out, and never seconds.
    const resets = [...dialog.querySelectorAll('div > span')]
      .map((e) => e.textContent ?? '')
      .filter((text) => text.startsWith('resets in'));
    expect(resets).toHaveLength(3);
    expect(resets[1]).toMatch(
      /^resets in 3d · resets [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, \d\d:\d\d$/,
    );
    for (const text of resets) expect(text).not.toMatch(/\d\d:\d\d:\d\d/);
    expect(within(dialog).getByText(/Extra usage/)).toHaveTextContent('Extra usage 12.5 / 50 USD');
    expect(dialog).toHaveTextContent('shared by all your devices');
  });

  it('names a source it does not know by its id', () => {
    renderBar([{ ...createDemoQuota(DEMO_NOW), source: 'some-new-feed' }]);
    fireEvent.click(screen.getByRole('button', { name: /Plan quota/ }));
    expect(screen.getByText('Source: some-new-feed')).toBeInTheDocument();
  });

  it('renders nothing without quota data', () => {
    const { container } = renderBar([]);
    expect(container).toBeEmptyDOMElement();
  });
});

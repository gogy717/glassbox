import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoQuota, createDemoQuotas } from '../../../src/core/fixtures/demo.js';
import type { QuotaSnapshot } from '../../../src/core/model.js';
import { I18nContext, type Locale, makeI18n } from '../i18n';
import { cjkInMono } from '../test/cjk';
import { DEMO_NOW } from '../test/demo';
import { formatBalance, QuotaBar } from './QuotaBar';
import css from './QuotaBar.module.css';

const NOW = DEMO_NOW.getTime();

function renderBar(quotas: QuotaSnapshot[], locale: Locale = 'en') {
  return render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <QuotaBar quotas={quotas} now={NOW} />
    </I18nContext.Provider>,
  );
}

const withWindow = (i: number, over: Partial<QuotaSnapshot['windows'][number]>): QuotaSnapshot => {
  const q = createDemoQuota(DEMO_NOW);
  q.windows = q.windows.map((w, j) => (j === i ? { ...w, ...over } : w));
  return q;
};

const demo = (provider: string) =>
  createDemoQuotas(DEMO_NOW).find((q) => q.provider === provider) as QuotaSnapshot;

const openDetails = () => {
  fireEvent.click(screen.getByRole('button', { name: /Plan quota/ }));
  return screen.getByRole('dialog', { name: 'Plan quota' });
};

const meterTexts = (container: HTMLElement) =>
  [...container.querySelectorAll('button > span[title]')].map((m) => m.textContent);

describe('QuotaBar', () => {
  it('shows one meter per provider, at its window closest to the limit', () => {
    const { container } = renderBar(createDemoQuotas(DEMO_NOW));
    expect(meterTexts(container)).toEqual([
      'Claude 62%',
      'ChatGPT 41%',
      'Grok 25%',
      'Copilot 74%',
      'DeepSeek ¥12.30',
    ]);
    const meters = screen.getAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-valuenow'))).toEqual(['62', '41', '25', '74']);
  });

  it('colours by usage: under 80% neutral, 80–95% amber, 95% and over red', () => {
    renderBar([
      withWindow(0, { usedPercent: 85 }),
      { ...withWindow(1, { usedPercent: 96 }), provider: 'openai' },
      { ...createDemoQuota(DEMO_NOW), provider: 'xai' },
    ]);
    const levels = screen.getAllByRole('meter').map((m) => m.getAttribute('data-level'));
    expect(levels).toEqual(['warn', 'danger', 'ok']);
  });

  it('puts the plan, the window and its reset countdown in the tooltip', () => {
    renderBar([createDemoQuota(DEMO_NOW)]);
    expect(screen.getByRole('meter')).toHaveAttribute(
      'title',
      'Anthropic · Max 5x · 5-hour window 62% used · resets in 1h37m',
    );
  });

  it('skips a window whose reset time has passed, and says "reset" once all have', () => {
    renderBar([
      withWindow(0, { usedPercent: 96, resetsAt: new Date(NOW - 20 * 60_000).toISOString() }),
      {
        ...withWindow(0, { resetsAt: new Date(NOW - 60_000).toISOString() }),
        provider: 'openai',
        windows: [
          {
            ...createDemoQuota(DEMO_NOW).windows[0],
            resetsAt: new Date(NOW - 60_000).toISOString(),
          },
        ] as QuotaSnapshot['windows'],
      },
    ]);
    const [claude, openai] = screen.getAllByRole('meter');
    expect(claude).toHaveTextContent('Claude 51%');
    expect(openai).toHaveTextContent('ChatGPT Reset');
    expect(openai).toHaveAttribute('data-level', 'ok');
    expect(openai).toHaveAttribute('data-reset');
  });

  it('shows a balance-only provider by its balance, in its currency', () => {
    const { container } = renderBar([demo('deepseek')]);
    expect(meterTexts(container)).toEqual(['DeepSeek ¥12.30']);
    expect(screen.queryByRole('meter')).toBeNull();
    const details = openDetails();
    expect(within(details).getByText('Balance ¥12.30')).toBeInTheDocument();
    expect(
      within(details).getByText("Source: DeepSeek's balance API (--fetch-quota)"),
    ).toBeVisible();
  });

  it('formats balances with the currency symbol, or the code when Intl does not know it', () => {
    expect(formatBalance({ amount: 12.3, currency: 'CNY' }, 'en')).toBe('¥12.30');
    expect(formatBalance({ amount: 1234.5, currency: 'USD' }, 'en')).toBe('$1,234.50');
    expect(formatBalance({ amount: 12.3, currency: 'credits' }, 'en')).toBe('12.30 credits');
  });

  it('drops a snapshot with neither windows nor a balance', () => {
    const { container } = renderBar([{ ...demo('deepseek'), balance: null }]);
    expect(container).toBeEmptyDOMElement();
  });

  it('lets assistive technology hear the meters, not just "Plan quota"', () => {
    renderBar(createDemoQuotas(DEMO_NOW).slice(0, 2));
    expect(
      screen.getByRole('button', { name: /Plan quota.*Claude 62%.*ChatGPT 41%/ }),
    ).toBeInTheDocument();
  });

  it('marks the provider closest to a limit, and counts the others, for narrow screens', () => {
    const { container } = renderBar(createDemoQuotas(DEMO_NOW));
    const top = container.querySelectorAll('[data-top]');
    expect([...top].map((m) => m.textContent)).toEqual(['Copilot 74%']);
    expect(screen.getByText('+4')).toBeInTheDocument();
    expect(container.querySelector('[data-many]')).not.toBeNull();
  });

  it('keeps the first provider for narrow screens when none has a current window', () => {
    const { container } = renderBar([demo('deepseek')]);
    expect(container.querySelector('[data-top]')).toHaveTextContent('DeepSeek ¥12.30');
    expect(screen.queryByText(/^\+/)).toBeNull();
    expect(container.querySelector('[data-many]')).toBeNull();
  });

  it('greys out each provider whose data is older than an hour, and says how old', () => {
    const old = {
      ...demo('xai'),
      stale: true,
      fetchedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    };
    renderBar([createDemoQuota(DEMO_NOW), old]);
    const [claude, grok] = screen.getAllByRole('meter');
    expect(claude).not.toHaveAttribute('data-stale');
    expect(grok).toHaveAttribute('data-stale');
    expect(grok).toHaveAttribute('title', expect.stringContaining('Data from 3\u202fh ago'));
    const details = openDetails();
    const section = within(details).getByRole('region', { name: 'xAI · SuperGrok' });
    expect(section).toHaveAttribute('data-stale');
    expect(within(section).getByText('Data from 3 h ago')).toBeInTheDocument();
  });

  it('groups the details by provider: plan, windows, resets, extra usage, age and source', () => {
    const claude: QuotaSnapshot = {
      ...createDemoQuota(DEMO_NOW),
      extraUsage: { used: 12.5, limit: 50, currency: 'USD' },
    };
    renderBar([claude, ...createDemoQuotas(DEMO_NOW).slice(1)]);
    const details = openDetails();
    const sections = within(details).getAllByRole('region');
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Anthropic · Max 5x',
      'OpenAI · Plus',
      'xAI · SuperGrok',
      'GitHub Copilot · Individual',
      'DeepSeek',
    ]);

    const [anthropic, openai, xai, copilot] = sections as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(within(anthropic).getByText('5-hour window')).toBeInTheDocument();
    expect(within(anthropic).getByText('Weekly')).toBeInTheDocument();
    expect(within(anthropic).getByText('Weekly · Opus')).toBeInTheDocument();
    expect(within(anthropic).getByText('62%').parentElement).toHaveTextContent('62% used');
    expect(within(anthropic).getByText('Updated 4 m ago')).toBeInTheDocument();
    expect(within(anthropic).getByText("Source: Claude Code's cache")).toBeInTheDocument();
    expect(within(anthropic).getByText(/Extra usage/)).toHaveTextContent(
      'Extra usage 12.5 / 50 USD',
    );
    expect(within(openai).getByText("Source: Codex's session log")).toBeInTheDocument();
    // The provider's own window names, and the monthly kind.
    expect(within(xai).getByText('SuperGrok Weekly Credits')).toBeInTheDocument();
    expect(within(xai).getByText("Source: oh-my-pi's cache")).toBeInTheDocument();
    expect(within(copilot).getByText('Premium Requests')).toBeInTheDocument();

    // Reset times: a day for the weekly windows three days out, and never seconds.
    const resets = [...anthropic.querySelectorAll('div > span')]
      .map((e) => e.textContent ?? '')
      .filter((text) => text.startsWith('resets in'));
    expect(resets).toHaveLength(3);
    expect(resets[1]).toMatch(
      /^resets in 3d · resets [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, \d\d:\d\d$/,
    );
    for (const text of resets) expect(text).not.toMatch(/\d\d:\d\d:\d\d/);
    expect(details).toHaveTextContent('shared by all your devices');
  });

  it('greys out a stale balance in the details too', () => {
    renderBar([{ ...demo('deepseek'), stale: true }]);
    const section = within(openDetails()).getByRole('region', { name: 'DeepSeek' });
    expect(section).toHaveAttribute('data-stale');
    expect(within(section).getByText('Balance ¥12.30')).toHaveClass(css.balance as string);
  });

  it('shows two snapshots of one provider side by side without mixing them up', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderBar([
        createDemoQuota(DEMO_NOW),
        { ...withWindow(0, { usedPercent: 80 }), source: 'anthropic-usage-api' },
      ]);
      expect(screen.getAllByRole('meter').map((m) => m.textContent)).toEqual([
        'Claude 62%',
        'Claude 80%',
      ]);
      expect(within(openDetails()).getAllByRole('region')).toHaveLength(2);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('names a window without a label by its kind, monthly included', () => {
    const q: QuotaSnapshot = {
      ...demo('github-copilot'),
      windows: [{ ...demo('github-copilot').windows[0], label: null }] as QuotaSnapshot['windows'],
    };
    renderBar([q]);
    expect(within(openDetails()).getByText('Monthly')).toBeInTheDocument();
  });

  it('names a provider and a source it does not know by their ids', () => {
    renderBar([
      { ...createDemoQuota(DEMO_NOW), provider: 'moonshot', plan: null, source: 'some-new-feed' },
    ]);
    expect(screen.getByRole('meter')).toHaveTextContent('moonshot 62%');
    const details = openDetails();
    expect(within(details).getByRole('region', { name: 'moonshot' })).toBeInTheDocument();
    expect(within(details).getByText('Source: some-new-feed')).toBeInTheDocument();
  });

  // Final review M6: the popover's figures in the mono face, its words in the UI face.
  it('sets each window’s usage in the details as a figure, its words and Chinese in the UI face', () => {
    renderBar([demo('anthropic')], 'zh');
    fireEvent.click(screen.getByRole('button', { name: /额度/ }));
    const details = screen.getByRole('dialog', { name: '额度' });
    expect(within(details).getByText('62%')).toHaveClass('figure');
    expect(within(details).getByText('62%').parentElement).toHaveTextContent('已用 62%');
    expect(cjkInMono(details)).toEqual([]);
  });

  it('speaks Chinese', () => {
    const copilot = demo('github-copilot');
    renderBar(
      [
        { ...copilot, windows: copilot.windows.map((w) => ({ ...w, label: null })) },
        demo('deepseek'),
      ],
      'zh',
    );
    fireEvent.click(screen.getByRole('button', { name: /额度/ }));
    const details = screen.getByRole('dialog', { name: '额度' });
    expect(within(details).getAllByText('每月')).toHaveLength(3);
    expect(within(details).getByText('余额 ¥12.30')).toBeInTheDocument();
    expect(within(details).getByText('来源：oh-my-pi 的缓存')).toBeInTheDocument();
    expect(
      within(details).getByText('来源：DeepSeek 余额接口（--fetch-quota）'),
    ).toBeInTheDocument();
  });

  it('marks a stale meter by its track, and says its age in words only where it stands alone', () => {
    const old = {
      ...demo('xai'),
      stale: true,
      fetchedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    };
    const { container, unmount } = renderBar([createDemoQuota(DEMO_NOW), old]);
    const [claude, grok] = screen.getAllByRole('meter');
    // Under its track, as formatRelative words it ("3 hours ago", or "3 h ago").
    expect(grok).toHaveTextContent(/25%3\s?h(ours)? ago$/);
    expect(claude).not.toHaveTextContent(/ago/);
    // Beside another meter the age is in the tooltip; alone, it is shown too.
    expect(container.querySelector('[data-single]')).toBeNull();
    unmount();
    const alone = renderBar([old]);
    expect(alone.container.querySelector('[data-single]')).not.toBeNull();
  });

  it('renders nothing without quota data', () => {
    const { container } = renderBar([]);
    expect(container).toBeEmptyDOMElement();
  });
});

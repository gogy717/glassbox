import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoQuota, createDemoQuotas } from '../../../src/core/fixtures/demo.js';
import type { QuotaSnapshot, QuotaStaleReason } from '../../../src/core/model.js';
import { I18nContext, type Locale, makeI18n } from '../i18n';
import { cjkInMono } from '../test/cjk';
import { DEMO_NOW } from '../test/demo';
import { formatBalance, QuotaBar, staleReasonText } from './QuotaBar';
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

  it('puts the plan, the window, its reset countdown and its pace in the tooltip', () => {
    renderBar([createDemoQuota(DEMO_NOW)]);
    // 97 minutes of 5 hours left: 68% of the window gone, 62% used.
    expect(screen.getByRole('meter')).toHaveAttribute(
      'title',
      'Anthropic · Max 5x · 5-hour window 62% used · resets in 1h37m · 68% of the 5 hours gone · on pace',
    );
    expect(screen.getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      'Claude 62% · 68% of the 5 hours gone · on pace',
    );
  });

  it('turns a meter amber when its limit comes before its reset, and says when', () => {
    renderBar([withWindow(0, { usedPercent: 75 })]);
    const meter = screen.getByRole('meter');
    // 75% used with 68% gone: under 80%, but the limit comes about 70 minutes from now.
    expect(meter).toHaveAttribute('data-level', 'warn');
    expect(meter.getAttribute('title')).toMatch(
      / · 68% of the 5 hours gone · at this pace, the limit around \d\d:\d\d$/,
    );
    expect(meter.getAttribute('aria-valuetext')).toMatch(
      /^Claude 75% · 68% of the 5 hours gone · at this pace, the limit around \d\d:\d\d$/,
    );
  });

  it('keeps red for 95% and over, and amber from 80%, whatever the pace', () => {
    renderBar([
      withWindow(0, { usedPercent: 96 }),
      { ...withWindow(0, { usedPercent: 82 }), provider: 'openai' },
    ]);
    expect(screen.getAllByRole('meter').map((m) => m.getAttribute('data-level'))).toEqual([
      'danger',
      'warn',
    ]);
  });

  it('gives each window a pace line under its reset, the forecast in its row’s colour', () => {
    renderBar(createDemoQuotas(DEMO_NOW));
    const details = openDetails();
    const paces = (name: string) =>
      [...within(details).getByRole('region', { name }).querySelectorAll(`.${css.pace}`)].map(
        (p) => p.textContent,
      );
    expect(paces('Anthropic · Max 5x')).toEqual([
      '68% of the 5 hours gone · on pace',
      '57% of the week gone · on pace',
      '57% of the week gone · on pace',
    ]);
    // Copilot's month runs to its reset on 1 November: 22 of 31 days gone, 74% used.
    const [premium, ...rest] = paces('GitHub Copilot · Individual');
    expect(premium).toMatch(
      /^71% of the month gone · at this pace, the limit around [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, \d\d:\d\d$/,
    );
    expect(rest).toEqual(['71% of the month gone · on pace', '71% of the month gone · on pace']);
    const copilot = within(details).getByRole('region', { name: 'GitHub Copilot · Individual' });
    expect(copilot.querySelector(`.${css.row}`)).toHaveAttribute('data-level', 'warn');
    expect(screen.getAllByRole('meter')[3]).toHaveAttribute('data-level', 'warn');
    // The figure in the mono face, its words in the UI face.
    expect(within(copilot).getAllByText('71%')[0]).toHaveClass('figure');
  });

  it('says a window has just reset in its first 5%, and gives stale numbers no pace', () => {
    const fresh = withWindow(1, {
      resetsAt: new Date(NOW + 7 * 24 * 3_600_000 - 5 * 60_000).toISOString(),
    });
    const old = { ...demo('xai'), stale: true };
    renderBar([fresh, old]);
    const details = openDetails();
    const anthropic = within(details).getByRole('region', { name: 'Anthropic · Max 5x' });
    expect([...anthropic.querySelectorAll(`.${css.pace}`)].map((p) => p.textContent)).toEqual([
      '68% of the 5 hours gone · on pace',
      '0% of the week gone · just reset',
      '57% of the week gone · on pace',
    ]);
    const xai = within(details).getByRole('region', { name: 'xAI · SuperGrok' });
    expect(xai.querySelector(`.${css.pace}`)).toBeNull();
    expect(screen.getAllByRole('meter')[1]?.getAttribute('title')).not.toMatch(/gone/);
  });

  it('says the pace in Chinese, its figures in the mono face', () => {
    renderBar([demo('anthropic')], 'zh');
    fireEvent.click(screen.getByRole('button', { name: /额度/ }));
    const details = screen.getByRole('dialog', { name: '额度' });
    const paces = [...details.querySelectorAll(`.${css.pace}`)].map((p) => p.textContent);
    expect(paces[0]).toBe('5 小时已过 68% · 用量正常');
    expect(paces[1]).toBe('一周已过 57% · 用量正常');
    expect(cjkInMono(details)).toEqual([]);
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
    expect(within(details).getByText("Source: DeepSeek's balance API")).toBeVisible();
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

  it('says on a line of its own why each stale provider is stale, and how it will refresh', () => {
    const stale = (q: QuotaSnapshot, staleReason: QuotaStaleReason): QuotaSnapshot => ({
      ...q,
      stale: true,
      staleReason,
    });
    renderBar([
      stale(demo('anthropic'), 'not-fetching'),
      stale(demo('openai'), 'cache-only'),
      stale(demo('xai'), 'sign-in-expired'),
      // Not stale: a reason the server would not send is not shown either.
      { ...demo('github-copilot'), staleReason: 'cache-only' },
      stale(demo('deepseek'), 'no-credentials'),
    ]);
    const details = openDetails();
    const why = [...details.querySelectorAll(`.${css.why}`)].map((p) => p.textContent);
    expect(why).toEqual([
      'Not fetched: glassbox was started with --no-fetch-quota (or a --fetch-quota list without it).',
      'Updates only while Codex runs: glassbox has no way to fetch it.',
      'Grok sign-in has expired; this refreshes after you run Grok CLI once.',
      'Not fetched: DEEPSEEK_API_KEY is not set.',
    ]);
    // Under the age, above the source.
    const xai = within(details).getByRole('region', { name: 'xAI · SuperGrok' });
    const lines = [...xai.querySelectorAll('p')].map((p) => p.textContent);
    expect(lines.slice(-3)).toEqual([
      expect.stringMatching(/^Data from /),
      'Grok sign-in has expired; this refreshes after you run Grok CLI once.',
      "Source: oh-my-pi's cache",
    ]);
    // In the meter's tooltip too.
    const grok = screen.getAllByRole('meter')[2];
    expect(grok).toHaveAttribute('title', expect.stringContaining('Grok sign-in has expired'));
  });

  it('names the missing sign-in, a failed request, and the cache an agent keeps', () => {
    const text = (q: Partial<QuotaSnapshot>) =>
      staleReasonText({ ...createDemoQuota(DEMO_NOW), stale: true, ...q }, makeI18n('en').t);
    expect(text({ staleReason: 'no-credentials' })).toBe(
      'Not fetched: Claude Code is not signed in on this machine.',
    );
    expect(text({ provider: 'xai', staleReason: 'no-credentials' })).toBe(
      'Not fetched: Grok CLI is not signed in on this machine.',
    );
    expect(text({ staleReason: 'sign-in-expired' })).toBe(
      'Claude sign-in has expired; this refreshes after you run Claude Code once.',
    );
    expect(text({ staleReason: 'fetch-failed' })).toBe(
      'Fetching it failed; glassbox tries again every 5 minutes (its log says why).',
    );
    expect(text({ provider: 'github-copilot', agent: 'oh-my-pi', staleReason: 'cache-only' })).toBe(
      'Updates only while oh-my-pi runs: glassbox has no way to fetch it.',
    );
    expect(text({ provider: 'moonshot', agent: null, staleReason: 'cache-only' })).toBe(
      'Updates only while the agent that caches it runs: glassbox has no way to fetch it.',
    );
    // No reason, or one this build does not know: nothing rather than a guess.
    expect(text({})).toBeNull();
    expect(text({ staleReason: 'some-new-reason' as QuotaStaleReason })).toBeNull();
    expect(text({ stale: false, staleReason: 'fetch-failed' })).toBeNull();
  });

  it('says why in Chinese, in the UI face', () => {
    renderBar([{ ...demo('xai'), stale: true, staleReason: 'sign-in-expired' }], 'zh');
    fireEvent.click(screen.getByRole('button', { name: /额度/ }));
    const details = screen.getByRole('dialog', { name: '额度' });
    expect(
      within(details).getByText('Grok 登录已过期，运行一次 Grok CLI 后会刷新。'),
    ).toBeInTheDocument();
    expect(cjkInMono(details)).toEqual([]);
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
    // Only the providers glassbox can ask are said to be asked.
    expect(details).toHaveTextContent('asks Anthropic, xAI and DeepSeek every 5 minutes');
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
    expect(within(details).getByText('来源：DeepSeek 余额接口')).toBeInTheDocument();
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

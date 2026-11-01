import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ModelRequest, Turn } from '../../../src/core/model.js';
import { PriceTableContext } from '../data/price-table';
import type { OpenSession } from '../data/store';
import { I18nContext, makeI18n } from '../i18n';
import { summarize } from '../lib/agents';
import { DASH, formatDuration } from '../lib/format';
import { priceTable } from '../lib/prices';
import { cjkInMono } from '../test/cjk';
import { DEMO_NOW, demoOpen } from '../test/demo';
import { moduleCssValue } from '../test/module-css';
import { SummaryBar } from './SummaryBar';
import css from './SummaryBar.module.css';

const sheet = join(import.meta.dirname, 'SummaryBar.module.css');

function show(open: OpenSession, locale: 'en' | 'zh' = 'en', props: object = {}) {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <SummaryBar open={open} agentId="main" {...props} />
    </I18nContext.Provider>,
  );
  return screen.getByRole('region', { name: locale === 'en' ? 'Summary' : '汇总' });
}

const cell = (bar: HTMLElement, name: string) =>
  bar.querySelector(`[data-cell="${name}"]`) as HTMLElement;
const hidden = (el: HTMLElement) => el.querySelector('.visually-hidden')?.textContent;
const read = (el: HTMLElement) => el.querySelector('[class*="read"]')?.textContent;

/** Each `@media (max-width: …)` block of the sheet: its width and what it holds. */
function mediaBlocks(text: string): { max: number; body: string }[] {
  const blocks: { max: number; body: string }[] = [];
  const head = /@media \(max-width: (\d+)px\) \{/g;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    let depth = 1;
    let i = head.lastIndex;
    for (; i < text.length && depth > 0; i++)
      depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
    blocks.push({ max: Number(m[1]), body: text.slice(head.lastIndex, i - 1) });
  }
  return blocks;
}

describe('SummaryBar cells', () => {
  // The demo's last turn runs: its active time and span run to the clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('reads the activity cell as a sentence and draws the strip beside the active time', () => {
    const open = demoOpen();
    const s = summarize(open, 'main', DEMO_NOW.getTime());
    const el = cell(show(open), 'activity');
    expect(hidden(el)).toBe(
      `${s.turns} prompts, ${s.requests} model calls, ${s.toolCalls} tool calls, active ${formatDuration(s.activeMs)}`,
    );
    expect(hidden(el)).toBe('3 prompts, 28 model calls, 32 tool calls, active 3m4s');
    const svg = el.querySelector('svg');
    expect(svg).toHaveAttribute('width', '200');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(el.querySelectorAll('[data-call]')).toHaveLength(s.requests);
    expect(el.querySelectorAll('[data-turn]')).toHaveLength(s.turns);
    expect(el.querySelectorAll('[data-tool]')).toHaveLength(s.toolCalls);
    // The legend counts under the strip, the readout and its label beside.
    expect(el.querySelector('[class*="legend"]')?.textContent).toBe('32832');
    expect(read(el)).toBe('3m4s');
    expect(el.textContent).toContain('Active');
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
    expect(read(cell(show(spread), 'activity'))).toMatch(/^\d+h\d+m · over 3 days$/);
    cleanup();
    expect(read(cell(show(spread, 'zh'), 'activity'))).toMatch(/ · 跨 3 天$/);
    expect(cjkInMono(document.body)).toEqual([]);
  });

  it('shows a dash, not 0ms, and no marks for an agent that has made no model call', () => {
    const el = cell(show(demoOpen(), 'en', { agentId: 'nobody' }), 'activity');
    expect(read(el)).toBe(DASH);
    expect(hidden(el)).toBe(`0 prompts, 0 model calls, 0 tool calls, active ${DASH}`);
    expect(el.querySelectorAll('[data-call], [data-turn], [data-tool]')).toHaveLength(0);
  });

  it('draws the cache hit as a ring, rounded down, with the exact share in the tooltip', () => {
    const open = demoOpen();
    const s = summarize(open, 'main', DEMO_NOW.getTime());
    const el = cell(show(open), 'cache');
    const ring = el.querySelector('svg[data-pct]');
    expect(ring).toHaveAttribute('data-tone', 'ok');
    expect(ring).toHaveAttribute('data-pct', String(Math.floor((s.cacheHitRate ?? 0) * 100)));
    expect(hidden(el)).toMatch(/^\d+(\.\d+)?% of 1,838,850 input tokens read from cache$/);
    expect(el.getAttribute('title')).toBe(hidden(el));
    expect(el.textContent).toContain('Cache hit');
  });

  it('never rounds the cache ring up to 100% while any input was uncached', () => {
    const open = demoOpen();
    const requests = new Map(
      [...open.requests].map(([id, r]) => [
        id,
        r.usage ? { ...r, usage: { ...r.usage, input: 1, cacheWrite: 0, cacheRead: 9_999 } } : r,
      ]),
    );
    const el = cell(show({ ...open, requests }), 'cache');
    expect(el.querySelector('svg[data-pct]')?.textContent).toBe('99%');
  });

  it('sets the token bars from the totals, and prints dashes before any usage', () => {
    const open = demoOpen();
    const s = summarize(open, 'main', DEMO_NOW.getTime());
    const el = cell(show(open), 'tokens');
    expect(hidden(el)).toMatch(/^Input 1,838,850, [\d,]+ cached; output 42,040, 27,050 thinking$/);
    // jsdom prints "86.0%" as "86%": compare the numbers.
    const width = (part: string) =>
      Number.parseFloat(el.querySelector<HTMLElement>(`[data-part="${part}"]`)?.style.width ?? '');
    expect(width('cached')).toBeCloseTo((s.cacheHitRate ?? 0) * 100, 1);
    expect(width('thinking')).toBeCloseTo((s.thinking / s.output) * 100, 1);
    expect(el.querySelector<HTMLElement>('[data-track]')?.style.width).toBe('100px');
    const totals = [...el.querySelectorAll('[data-total]')].map((n) => n.textContent);
    expect(totals).toEqual(['1.84M', '42K']);
    expect(el.querySelectorAll('[data-total]')[1]).toHaveAttribute('title', '42,040 (27,050)');
    cleanup();
    const none = show(demoOpen(), 'en', { agentId: 'nobody' });
    expect(hidden(cell(none, 'tokens'))).toBe(
      `Input ${DASH}, ${DASH} cached; output ${DASH}, ${DASH} thinking`,
    );
    expect(
      [...cell(none, 'tokens').querySelectorAll('[data-total]')].map((n) => n.textContent),
    ).toEqual([DASH, DASH]);
    expect(cell(none, 'cache').querySelector('svg')).toBeNull();
    expect(hidden(cell(none, 'cache'))).toBe(`Cache hit ${DASH}`);
  });

  it('speaks Chinese and keeps CJK out of the mono face', () => {
    const bar = show(demoOpen(), 'zh');
    expect(hidden(cell(bar, 'activity'))).toBe('3 轮提问，28 次模型调用，32 次工具调用，活跃 3m4s');
    expect(hidden(cell(bar, 'tokens'))).toMatch(
      /^输入 1,838,850，缓存命中 [\d,]+；输出 42,040，思考 27,050$/,
    );
    expect(hidden(cell(bar, 'cache'))).toMatch(/^输入 1,838,850 token 中 \d+(\.\d+)?% 命中缓存$/);
    expect(
      [...cell(bar, 'tokens').querySelectorAll('[data-total]')].map((n) => n.textContent),
    ).toEqual(['184万', '4.2万']);
    for (const word of ['活跃', '缓存命中率', 'API', '输入', '输出'])
      expect(bar.textContent).toContain(word);
    expect(cjkInMono(document.body)).toEqual([]);
  });

  it('says whether anything looks stuck right after Data complete, for the agent it shows', () => {
    const navigate = vi.fn();
    show(demoOpen(), 'en', { navigate });
    const diagnostics = screen.getByRole('button', { name: /Data diagnostics/ });
    const trouble = screen.getByRole('button', { name: 'Signs of trouble · No trouble' });
    expect(diagnostics.parentElement?.nextElementSibling).toBe(trouble.parentElement);
  });

  it('tightens when the cells and the diagnostics do not fit, at any screen width', () => {
    // A fresh element each time: React skips a render of the very same one.
    const ui = () => (
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" />
      </I18nContext.Provider>
    );
    const { rerender } = render(ui());
    const bar = screen.getByRole('region', { name: 'Summary' });
    // jsdom has no layout: the first cell stands for the whole row's width.
    const size = (row: number, client: number) => {
      Object.defineProperty(bar.firstElementChild, 'offsetWidth', {
        configurable: true,
        value: row,
      });
      Object.defineProperty(bar, 'clientWidth', { configurable: true, value: client });
      rerender(ui());
    };
    const strip = () => cell(bar, 'activity').querySelector('svg');
    const track = () => cell(bar, 'tokens').querySelector<HTMLElement>('[data-track]');
    expect(bar).not.toHaveAttribute('data-tight');
    // Beside the sidebar, a 1280 px window gives the bar 1012 px; the cells and the words need more.
    size(1100, 1012);
    expect(bar).toHaveAttribute('data-tight');
    expect(strip()).toHaveAttribute('width', '150');
    expect(track()?.style.width).toBe('80px');
    expect(moduleCssValue(sheet, css, cell(bar, 'cost'), 'padding')).toBe('6px 10px');
    // Tight, the bar measures short. Widening to what it all needs sets it wide again.
    size(900, 1080);
    expect(bar).toHaveAttribute('data-tight');
    size(900, 1100);
    expect(bar).not.toHaveAttribute('data-tight');
    expect(strip()).toHaveAttribute('width', '200');
    expect(track()?.style.width).toBe('100px');
  });

  it('adds a rate cell only below 900px, where the top bar drops the rate, and wraps there', () => {
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
    const bar = show(demoOpen(), 'en', { rate, rateAgent: 'codex' });
    const el = cell(bar, 'rate');
    expect(el).toHaveAttribute('data-narrow-only');
    expect(read(el)).toBe('≈90K/min');
    expect(hidden(el)).toBe('Token rate ≈90K/min');
    expect(moduleCssValue(sheet, css, el, 'display')).toBe('none');
    const narrow = mediaBlocks(readFileSync(sheet, 'utf8')).find((b) => b.max === 900)?.body ?? '';
    expect(narrow).toMatch(/\.cell\[data-narrow-only\] \{\s*display: flex;/);
    // Short of room even when tight, at any width, the bar takes a second row.
    expect(moduleCssValue(sheet, css, bar, 'flex-wrap')).toBe('wrap');
    // In Chinese it reads "≈9万/分钟", the 万 and 分钟 out of the mono face.
    cleanup();
    const zh = show(demoOpen(), 'zh', { rate, rateAgent: 'codex' });
    expect(zh).toHaveTextContent('≈9万/分钟');
    expect(cjkInMono(document.body)).toEqual([]);
  });

  it('hides the right-hand words when tight, but never a sign of trouble', () => {
    const ui = () => (
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={demoOpen()} agentId="main" />
      </I18nContext.Provider>
    );
    const { rerender } = render(ui());
    const bar = screen.getByRole('region', { name: 'Summary' });
    Object.defineProperty(bar.firstElementChild, 'offsetWidth', {
      configurable: true,
      value: 1100,
    });
    Object.defineProperty(bar, 'clientWidth', { configurable: true, value: 1012 });
    rerender(ui());
    expect(bar).toHaveAttribute('data-tight');
    const display = (el: Element | null) =>
      el ? moduleCssValue(sheet, css, el, 'display') : 'missing';
    const words = [...bar.querySelectorAll('[data-word]')].map((w) => w.textContent);
    expect(words).toEqual(['Data complete', 'No trouble', 'Receipt']);
    for (const w of bar.querySelectorAll('[data-word]')) expect(display(w)).toBe('none');
    // The icons keep their words for the ear and the pointer.
    expect(screen.getByRole('button', { name: 'Signs of trouble · No trouble' })).toHaveAttribute(
      'title',
      'Signs of trouble',
    );
    expect(screen.getByRole('button', { name: 'Receipt' })).toBeInTheDocument();
    // Three days on, the demo's running prompt is a sign: its words stay.
    cleanup();
    vi.useRealTimers();
    const later = show(demoOpen());
    const trouble = within(later).getByRole('button', { name: /Signs of trouble · / });
    expect(trouble).not.toHaveAccessibleName('Signs of trouble · No trouble');
    expect(trouble.querySelector('[data-word]')).toBeNull();
  });

  it('has no disclosure: nothing is folded away or scrolled sideways', () => {
    const bar = show(demoOpen());
    expect(within(bar).queryByRole('button', { name: /figures/ })).toBeNull();
    expect(moduleCssValue(sheet, css, bar, 'overflow-x')).toBeUndefined();
  });
});

/** The demo with the model of every `n`th request (all of them by default) set to `model`. */
function withModel(model: string, n = 1): OpenSession {
  const open = demoOpen();
  const requests = new Map(
    [...open.requests].map(([id, r], i) => [id, i % n === 0 ? { ...r, model } : r]),
  );
  return { ...open, requests };
}

const TITLE = 'What these tokens would cost on the API, estimated from the price table in Settings';

// Proposal 6: the tokens as dollars, as the API would have billed them.
describe('SummaryBar API cost', () => {
  afterEach(cleanup);
  const cost = (locale: 'en' | 'zh' = 'en') =>
    cell(screen.getByRole('region', { name: locale === 'en' ? 'Summary' : '汇总' }), 'cost');

  it('estimates what the tokens would cost on the API, as the last cell before the diagnostics', () => {
    const bar = show(demoOpen());
    // 26 calls of claude-opus-5-5 at its list prices.
    expect(read(cost())).toBe('≈ $3.21');
    expect(hidden(cost())).toBe('API cost (est.) ≈ $3.21');
    expect(cost()).toHaveAttribute('title', TITLE);
    expect(cost().textContent).toContain('API');
    const cells = [...bar.querySelectorAll('[data-cell]')].map((c) => c.getAttribute('data-cell'));
    expect(cells).toEqual(['activity', 'context', 'cache', 'tokens', 'cost']);
  });

  it('prices by the table in force, Settings’ prices over the defaults', () => {
    const doubled = { input: 8, cacheWrite: 10, cacheWrite1h: 16, cacheRead: 0.4, output: 40 };
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <PriceTableContext.Provider value={priceTable({ 'claude-opus-5-5': doubled })}>
          <SummaryBar open={demoOpen()} agentId="main" />
        </PriceTableContext.Provider>
      </I18nContext.Provider>,
    );
    expect(read(cost())).toBe('≈ $6.42');
  });

  it('shows a dash when no model has a price, and names the models left out', () => {
    show(withModel('gpt-5.5-codex'));
    expect(read(cost())).toBe(DASH);
    expect(cost()).toHaveAttribute('title', `${TITLE} · Left out, no price: gpt-5.5-codex`);
    cleanup();
    show(withModel('gpt-5.5-codex', 2));
    expect(read(cost())).toMatch(/^≈ \$\d\.\d\d$/);
    expect(cost()).toHaveAttribute('title', `${TITLE} · Left out, no price: gpt-5.5-codex`);
  });

  it('shows a dash before any call reported usage, and speaks Chinese', () => {
    show(demoOpen(), 'zh', { agentId: 'nobody' });
    expect(read(cost('zh'))).toBe(DASH);
    expect(hidden(cost('zh'))).toBe(`API 费用（估）${DASH}`);
    cleanup();
    show(demoOpen(), 'zh');
    expect(read(cost('zh'))).toBe('≈ $3.21');
    expect(cjkInMono(document.body)).toEqual([]);
  });
});

// A request that has not reported usage yet draws hollow, and the strip says so.
describe('SummaryBar strip', () => {
  it('draws a call in flight hollow', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const open = demoOpen();
    const before = cell(show(open), 'activity').querySelectorAll('[data-call="hollow"]').length;
    cleanup();
    const [id, r] = [...open.requests].find(([, r]) => r.agentId === 'main' && r.usage) as [
      string,
      ModelRequest,
    ];
    const requests = new Map(open.requests).set(id, { ...r, usage: null });
    const el = cell(show({ ...open, requests }), 'activity');
    expect(el.querySelectorAll('[data-call="hollow"]')).toHaveLength(before + 1);
  });
});

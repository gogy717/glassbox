/// <reference types="node" />
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest } from '../../../src/core/model.js';
import { emptyUsage } from '../../../src/core/usage.js';
import { contextUse } from '../../../src/shared/context-use.js';
import type { OpenSession } from '../data/store';
import { I18nContext, makeI18n } from '../i18n';
import { DEMO_NOW, demoOpen } from '../test/demo';
import { moduleCssValue } from '../test/module-css';
import { SummaryBar } from './SummaryBar';
import css from './SummaryBar.module.css';

/** The demo with its main agent's latest finished call reading `tokens`, of `model`. */
function reading(tokens: number, model = 'claude-opus-5-5'): OpenSession {
  const open = demoOpen();
  const id = contextUse(open.requests.values(), 'main')?.requestId as string;
  const latest = open.requests.get(id) as ModelRequest;
  const usage = { ...emptyUsage(), input: 6, cacheWrite: 994, cacheRead: tokens - 1_000 };
  return { ...open, requests: new Map(open.requests).set(id, { ...latest, model, usage }) };
}

function cell(open: OpenSession, locale: 'en' | 'zh' = 'en') {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <SummaryBar open={open} agentId="main" />
    </I18nContext.Provider>,
  );
  const bar = screen.getByRole('region', { name: locale === 'en' ? 'Summary' : '汇总' });
  return bar.querySelector('[data-cell="context"]') as HTMLElement;
}

const sheet = join(import.meta.dirname, 'SummaryBar.module.css');
const color = (el: Element | null) => (el ? moduleCssValue(sheet, css, el, 'color') : 'missing');
const read = (el: HTMLElement) => el.querySelector('[class*="read"]')?.textContent;
const ring = (el: HTMLElement) => el.querySelector('svg[data-pct]');

describe('SummaryBar context cell', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('draws the agent’s context as a ring of its window, in the warning tone from 85%', () => {
    const el = cell(reading(184_000));
    expect(ring(el)).toHaveAttribute('data-pct', '92');
    expect(ring(el)).toHaveAttribute('data-tone', 'warn');
    expect(ring(el)?.textContent).toBe('92%');
    expect(read(el)).toBe('184K of 200K');
    expect(el).toHaveAttribute('data-tone', 'warn');
    expect(color(el.querySelector('[class*="read"]'))).toBe('var(--warning)');
    // What compaction does, said where the ring is.
    expect(el.getAttribute('title')).toMatch(/200K window.*compacts/);
    expect(el.querySelector('.visually-hidden')).toHaveTextContent(
      'Context 184,000 of 200,000 · 92%',
    );
    expect(el.querySelector('.visually-hidden')?.textContent).toBe(
      'Context 184,000 of 200,000 · 92%',
    );
    expect(el.textContent).toContain('Context');
  });

  it('is muted below 70%, plain between, and the share is rounded down as the sign’s is', () => {
    const low = cell(reading(60_000));
    expect(low).toHaveAttribute('data-tone', 'muted');
    expect(ring(low)).toHaveAttribute('data-tone', 'muted');
    expect(color(low.querySelector('[class*="read"]'))).toBe('var(--muted)');
    cleanup();
    const mid = cell(reading(169_999));
    expect(mid).not.toHaveAttribute('data-tone');
    expect(ring(mid)).toHaveAttribute('data-tone', 'plain');
    expect(ring(mid)?.textContent).toBe('84%');
  });

  it('gives no ring and no tone for a model whose window is not known', () => {
    const el = cell(reading(184_000, 'gpt-6.1-sol'));
    expect(ring(el)).toBeNull();
    expect(read(el)).toBe('184K');
    expect(el).not.toHaveAttribute('data-tone');
    expect(el.getAttribute('title')).toMatch(/not known/);
    expect(el.querySelector('.visually-hidden')?.textContent).toBe('Context 184,000');
  });

  it('speaks Chinese', () => {
    const el = cell(reading(184_000), 'zh');
    expect(read(el)).toBe('18.4万 / 20万');
    expect(el.querySelector('.visually-hidden')?.textContent).toBe(
      '上下文 184,000 / 200,000 · 92%',
    );
    expect(el.textContent).toContain('上下文');
  });
});

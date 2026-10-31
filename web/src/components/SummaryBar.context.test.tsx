/// <reference types="node" />
import { join } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
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

function figure(open: OpenSession, locale: 'en' | 'zh' = 'en') {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <SummaryBar open={open} agentId="main" />
    </I18nContext.Provider>,
  );
  const bar = screen.getByRole('region', { name: locale === 'en' ? 'Summary' : '汇总' });
  const label = within(bar).getByText(locale === 'en' ? 'Context' : '上下文');
  return label.parentElement as HTMLElement;
}

const sheet = join(import.meta.dirname, 'SummaryBar.module.css');
const color = (el: Element | null) => (el ? moduleCssValue(sheet, css, el, 'color') : 'missing');

describe('SummaryBar context figure', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEMO_NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('says the agent’s context of its window and the share, in the warning tone from 85%', () => {
    const el = figure(reading(184_000));
    expect(el.querySelector('[data-value]')).toHaveTextContent('184K of 200K · 92%');
    expect(el).toHaveAttribute('data-tone', 'warn');
    expect(color(el.querySelector('[data-value]'))).toBe('var(--warning)');
    // What compaction does, said where the figure is.
    expect(el.getAttribute('title')).toMatch(/200K window.*compacts/);
    expect(el.querySelector('.visually-hidden')).toHaveTextContent('184,000 of 200,000 · 92%');
  });

  it('is muted below 70%, plain between, and the share is rounded down as the sign’s is', () => {
    expect(figure(reading(60_000))).toHaveAttribute('data-tone', 'muted');
    cleanup();
    const mid = figure(reading(169_999));
    expect(mid).not.toHaveAttribute('data-tone');
    expect(mid.querySelector('[data-value]')).toHaveTextContent('of 200K · 84%');
  });

  it('gives no share and no tone for a model whose window is not known', () => {
    const el = figure(reading(184_000, 'gpt-6.1-sol'));
    expect(el.querySelector('[data-value]')?.textContent).toBe('184K');
    expect(el).not.toHaveAttribute('data-tone');
    expect(el.getAttribute('title')).toMatch(/not known/);
  });

  it('speaks Chinese', () => {
    const el = figure(reading(184_000), 'zh');
    expect(el.querySelector('[data-value]')).toHaveTextContent('18.4万 / 20万 · 92%');
  });
});

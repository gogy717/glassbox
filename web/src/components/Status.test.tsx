/// <reference types="node" />
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nContext, type Locale, makeI18n } from '../i18n';
import { moduleCssValue } from '../test/module-css';
import { LiveDot, StatusMark, Ticking, type UiStatus } from './Status';
import classes from './Status.module.css';

const cssValue = (el: Element, prop: string) =>
  moduleCssValue(join(import.meta.dirname, 'Status.module.css'), classes, el, prop);

const RING = '0 0 0 3px var(--warning-tint)';
const HOLLOW = 'inset 0 0 0 1px var(--faint)';

const inLocale = (locale: Locale, node: ReactNode) =>
  render(<I18nContext.Provider value={makeI18n(locale)}>{node}</I18nContext.Provider>);

describe('Ticking', () => {
  it('shows a dash rather than NaN for a malformed start time', () => {
    const { container } = inLocale(
      'en',
      <Ticking since="not a time" labelKey="flow.thinkingNow" />,
    );
    expect(container).toHaveTextContent('Thinking · —');
  });

  it('sets the clock alone as a figure, so the words keep the UI face (A3)', () => {
    const since = new Date(Date.now() - 83_000).toISOString();
    const en = inLocale('en', <Ticking since={since} labelKey="flow.thinkingNow" />);
    expect(en.container).toHaveTextContent('Thinking · 1:23');
    const figure = en.container.querySelector('.figure');
    expect(figure).toHaveTextContent(/^1:23$/);
    // zh: the CJK words sit outside the mono figure.
    const zh = inLocale('zh', <Ticking since={since} labelKey="flow.thinkingNow" />);
    expect(zh.container).toHaveTextContent('思考中 · 已 1:23');
    expect(zh.container.querySelector('.figure')).toHaveTextContent(/^1:23$/);
  });
});

describe('LiveDot', () => {
  it('is decoration next to its state’s name, and names the state when it stands alone', () => {
    const { container, rerender } = render(<LiveDot kind="status" state="complete" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
    rerender(<LiveDot kind="status" state="complete" label="Complete" />);
    const dot = screen.getByRole('img', { name: 'Complete' });
    expect(dot).toHaveAttribute('title', 'Complete');
    expect(dot).toHaveAttribute('data-state', 'complete');
  });

  it('rings only what needs you: a live “waiting”, or approval; a status’s “waiting” is hollow', () => {
    const dot = (node: ReactNode) => render(node).container.firstElementChild as Element;
    // A session waiting for you.
    const live = dot(<LiveDot state="waiting" />);
    expect(live).toHaveAttribute('data-kind', 'live');
    expect(cssValue(live, 'box-shadow')).toBe(RING);
    expect(cssValue(live, 'background')).toBe('var(--warning)');
    // A tool waiting for approval.
    expect(cssValue(dot(<LiveDot kind="status" state="approval" />), 'box-shadow')).toBe(RING);
    // A sub-agent started and never seen to end: hollow, no colour, no pulse.
    for (const state of ['waiting', 'unknown'] as const) {
      const status = dot(<LiveDot kind="status" state={state} />);
      expect(cssValue(status, 'box-shadow'), state).toBe(HOLLOW);
      expect(cssValue(status, 'background'), state).toBe('transparent');
      expect(cssValue(status, 'animation'), state).toBeUndefined();
    }
    // A live state of unknown is a plain faint dot.
    const unknown = dot(<LiveDot state="unknown" />);
    expect(cssValue(unknown, 'box-shadow')).toBeUndefined();
    expect(cssValue(unknown, 'background')).toBe('var(--faint)');
  });
});

describe('StatusMark', () => {
  const renderMark = (status: UiStatus, props: { compact?: boolean; label?: string } = {}) =>
    inLocale('en', <StatusMark status={status} {...props} />);

  it.each([
    ['running', 'Running', 'dot'],
    ['approval', 'Waiting for you', 'dot'],
    ['complete', 'Complete', 'glyph'],
    ['error', 'Failed', 'glyph'],
    ['interrupted', 'Interrupted', 'dot'],
    ['waiting', 'Waiting', 'dot'],
  ] as const)('%s: a %s mark and its word, no pill', (status, word, kind) => {
    const { container } = renderMark(status);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark).toHaveAttribute('data-state', status);
    expect(screen.getByText(word)).toHaveAttribute('data-status-label');
    // A check or an × for the ends, a dot for the states in between; never an icon in a pill.
    expect(mark.querySelector('svg') !== null).toBe(kind === 'glyph');
  });

  it.each([
    ['running', 'var(--accent)'],
    ['approval', 'var(--warning)'],
    ['error', 'var(--error)'],
    ['complete', 'var(--muted)'],
    ['interrupted', 'var(--muted)'],
    ['waiting', 'var(--muted)'],
  ] as const)('%s: only running, waiting for you and failed colour the word', (status, colour) => {
    const { container } = renderMark(status);
    expect(cssValue(container.firstElementChild as Element, 'color')).toBe(colour);
  });

  it('marks interrupted with an amber dot, and rings only waiting for you', () => {
    const dotOf = (status: UiStatus) =>
      renderMark(status).container.querySelector(`[data-state="${status}"] > span`) as Element;
    expect(cssValue(dotOf('interrupted'), 'background')).toBe('var(--warning)');
    expect(cssValue(dotOf('interrupted'), 'box-shadow')).toBeUndefined();
    expect(cssValue(dotOf('approval'), 'box-shadow')).toBe(RING);
    expect(cssValue(dotOf('waiting'), 'box-shadow')).toBe(HOLLOW);
  });

  it('in a dense list shows a check or an × alone, named by its word', () => {
    renderMark('complete', { compact: true });
    const mark = screen.getByRole('img', { name: 'Complete' });
    expect(mark).toHaveAttribute('title', 'Complete');
    expect(screen.queryByText('Complete')).toBeNull();
    renderMark('error', { compact: true });
    expect(screen.getByRole('img', { name: 'Failed' }).querySelector('svg')).not.toBeNull();
  });

  it.each([
    ['running', 'Running'],
    ['approval', 'Waiting for you'],
    ['interrupted', 'Interrupted'],
    ['waiting', 'Waiting'],
  ] as const)(
    'keeps the word for %s even when compact: its dot differs only by colour',
    (status, word) => {
      renderMark(status, { compact: true });
      expect(screen.getByText(word)).toHaveAttribute('data-status-label');
      expect(screen.queryByRole('img')).toBeNull();
    },
  );

  it('shows a given label in place of the state’s word, compact or not', () => {
    renderMark('running', { label: 'Replying' });
    expect(screen.getByText('Replying')).toHaveAttribute('data-status-label');
    expect(screen.queryByText('Running')).toBeNull();
    renderMark('complete', { label: 'Done', compact: true });
    expect(screen.getByRole('img', { name: 'Done' })).toHaveAttribute('title', 'Done');
  });
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { useFakeLayout } from '../test/layout';
import { TextBlock } from './TextBlock';

const renderText = (text: string | null) =>
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <TextBlock label="Result" text={text} />
    </I18nContext.Provider>,
  );

describe('TextBlock', () => {
  useFakeLayout();

  it('shows short text as is', () => {
    renderText('src/server/store.ts:41:export function sortSessions(');
    expect(
      screen.getByText('src/server/store.ts:41:export function sortSessions('),
    ).toBeInTheDocument();
  });

  it('pretty-prints text that is JSON', () => {
    const { container } = renderText('{"summary":"ok","n":2}');
    expect(container.querySelector('pre')?.textContent).toBe('{\n  "summary": "ok",\n  "n": 2\n}');
  });

  it('says "not recorded" for missing or empty text', () => {
    renderText(null);
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
  });

  it('truncates 2 MB of text inline and shows all of it, virtualised, on request', () => {
    const line = `${'y'.repeat(99)}\n`;
    const huge = line.repeat(20_000); // 2,000,000 characters
    const { container } = renderText(huge);
    expect(container.querySelector('pre')?.textContent?.length ?? 0).toBeLessThanOrEqual(20_000);
    fireEvent.click(screen.getByRole('button', { name: 'Show all (2,000,000 characters)' }));
    const dialog = screen.getByRole('dialog', { name: 'Result' });
    const rendered = dialog.querySelectorAll('[data-line]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(500);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';

/** A dialog that cannot draw. */
function Broken(): never {
  throw new Error('no canvas');
}

type DialogModule = Record<string, unknown>;

/** The summary bar, loaded fresh with the receipt dialog's module mocked as `dialog` says. */
async function bar(dialog: () => Promise<DialogModule>) {
  vi.resetModules();
  vi.doMock('./ReceiptDialog', dialog);
  const { SummaryBar } = await import('../SummaryBar');
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <SummaryBar open={demoOpen()} agentId="main" rate={null} />
    </I18nContext.Provider>,
  );
  return screen.getByRole('button', { name: 'Receipt' });
}

describe('the receipt, when it cannot open', () => {
  afterEach(() => {
    vi.doUnmock('./ReceiptDialog');
    vi.useRealTimers();
  });

  it('says so in the bar, and leaves the session view standing', async () => {
    const button = await bar(async () => ({ ReceiptDialog: Broken }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(button);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('no canvas');
    expect(screen.getByRole('region', { name: 'Summary' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says it is loading when the code takes a while to arrive', async () => {
    vi.useFakeTimers();
    const button = await bar(() => new Promise<DialogModule>(() => {}));
    fireEvent.click(button);
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});

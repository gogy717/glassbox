import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { SummaryBar } from '../SummaryBar';

function renderBar(locale: 'en' | 'zh' = 'en') {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <SummaryBar open={demoOpen()} agentId="main" rate={null} />
    </I18nContext.Provider>,
  );
  return screen.getByRole('button', { name: locale === 'en' ? 'Receipt' : '小票' });
}

async function openDialog() {
  const button = renderBar();
  button.focus();
  fireEvent.click(button);
  const dialog = await screen.findByRole('dialog', { name: 'Receipt' });
  return { button, dialog };
}

const clipboard = {
  writeText: vi.fn(async (_text: string) => {}),
  write: vi.fn(async (_items: unknown[]) => {}),
};

describe('the receipt dialog', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    clipboard.writeText.mockClear();
    clipboard.write.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens from the summary bar, its image described by the receipt’s text (R5)', async () => {
    const { dialog } = await openDialog();
    const img = within(dialog).getByRole('img');
    // The slip itself by default, the size that stays readable on a phone.
    expect(img).toHaveAccessibleName(/^Receipt, 1080 × \d{4}; its text follows$/);
    expect(within(dialog).getByRole('radio', { name: 'Tall' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    const text = document.getElementById(img.getAttribute('aria-describedby') as string);
    expect(text).toHaveTextContent('npx github:gogy717/glassbox');
    expect(img).toHaveAccessibleDescription(/Model calls/);
    // The choices are W1's switches: one radio group each.
    for (const name of ['Size', 'Paper', 'Language', 'Hide names'])
      expect(within(dialog).getByRole('radiogroup', { name })).toBeInTheDocument();
  });

  it('remembers its choices, and shows the size chosen (R1)', async () => {
    const { dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Story 9:16' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: '中文' }));
    fireEvent.click(
      within(within(dialog).getByRole('radiogroup', { name: 'Hide names' })).getByRole('radio', {
        name: 'On',
      }),
    );
    expect(within(dialog).getByRole('img')).toHaveAccessibleName(/1080 × 1920/);
    expect(document.getElementById('receipt-text')).toHaveTextContent('未命名会话');
    expect(JSON.parse(localStorage.getItem('glassbox.receipt') ?? '{}')).toMatchObject({
      size: 'story',
      locale: 'zh',
      hideNames: true,
    });
    cleanup();
    const again = await openDialog();
    expect(within(again.dialog).getByRole('radio', { name: 'Story 9:16' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('closes on Escape and gives focus back to the button (R5)', async () => {
    const { button, dialog } = await openDialog();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('says a text copy failed in its own words', async () => {
    const { dialog } = await openDialog();
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy as text' }));
    await within(dialog).findByText('Could not copy the text: denied');
  });

  it('prints the session as it was when the dialog opened, whatever arrives since (F9)', async () => {
    const open = demoOpen();
    const { rerender } = render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={open} agentId="main" rate={null} />
      </I18nContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Receipt' }));
    const img = within(await screen.findByRole('dialog')).getByRole('img');
    const before = img.getAttribute('src');
    const more = { ...open, requests: new Map([...open.requests].slice(0, 3)) };
    rerender(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={more} agentId="main" rate={null} />
      </I18nContext.Provider>,
    );
    expect(within(screen.getByRole('dialog')).getByRole('img').getAttribute('src')).toBe(before);
  });

  it('has nothing to print before the first model call, and says so', () => {
    const open = { ...demoOpen(), requests: new Map() };
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <SummaryBar open={open} agentId="main" rate={null} />
      </I18nContext.Provider>,
    );
    const button = screen.getByRole('button', { name: 'Receipt' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('title', 'Nothing to print yet');
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('copies the receipt as text', async () => {
    const { dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy as text' }));
    await within(dialog).findByText('Text copied');
    const copied = clipboard.writeText.mock.calls[0]?.[0] as string;
    expect(copied.startsWith('```\nglassbox')).toBe(true);
    expect(copied).toContain('npx github:gogy717/glassbox');
  });

  describe('making the image', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    let xhrSpy: ReturnType<typeof vi.spyOn>;
    const canvases: { w: number; h: number }[] = [];
    let clicked: HTMLAnchorElement[] = [];

    beforeEach(() => {
      fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
      canvases.length = 0;
      clicked = [];
      // jsdom draws no images: decoding one just succeeds.
      Object.defineProperty(HTMLImageElement.prototype, 'decode', {
        value: async () => {},
        configurable: true,
      });
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
        this: HTMLCanvasElement,
      ) {
        canvases.push({ w: this.width, h: this.height });
        return { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
      } as never);
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) =>
        cb(new Blob(['png'], { type: 'image/png' })),
      );
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push(this);
      });
      URL.createObjectURL = vi.fn(() => 'blob:receipt');
      URL.revokeObjectURL = vi.fn();
    });

    it('downloads a 1080 × 1350 PNG named for the project, asking the network for nothing (R6)', async () => {
      const { dialog } = await openDialog();
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Post 4:5' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Download PNG' }));
      await within(dialog).findByText('Downloaded');
      expect(canvases).toEqual([{ w: 1080, h: 1350 }]);
      // Kept in the page until the browser has taken it (Firefox and Safari need that).
      expect(clicked[0]?.isConnected).toBe(true);
      expect(clicked[0]?.download).toMatch(/^glassbox-receipt-glassbox-\d{8}-\d{4}\.png$/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhrSpy).not.toHaveBeenCalled();
    });

    it('copies the PNG, the clipboard item made in the click, and falls back to a download', async () => {
      const items: Record<string, unknown>[] = [];
      vi.stubGlobal(
        'ClipboardItem',
        class {
          constructor(data: Record<string, unknown>) {
            items.push(data);
          }
        },
      );
      const { dialog } = await openDialog();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy image' }));
      // Made synchronously in the click, with the PNG still a promise (what Safari asks).
      expect(items[0]?.['image/png']).toBeInstanceOf(Promise);
      await within(dialog).findByText('Image copied');
      expect(clipboard.write).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();

      // A browser without image clipboard: the same button downloads.
      vi.stubGlobal('ClipboardItem', undefined);
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Copy image' }));
      });
      await within(dialog).findByText(
        'The clipboard would not take the image: downloaded it instead',
      );
      expect(clicked).toHaveLength(1);
    });

    it('downloads the same PNG when the clipboard refuses it, or throws', async () => {
      vi.stubGlobal('ClipboardItem', class {});
      const { dialog } = await openDialog();
      clipboard.write.mockRejectedValueOnce(new Error('NotAllowedError'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy image' }));
      await within(dialog).findByText(/downloaded it instead/);
      expect(clicked).toHaveLength(1);
      clipboard.write.mockImplementationOnce(() => {
        throw new Error('no user gesture');
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy image' }));
      await waitFor(() => expect(clicked).toHaveLength(2));
      expect(clicked[1]?.download).toBe(clicked[0]?.download);
    });
  });
});

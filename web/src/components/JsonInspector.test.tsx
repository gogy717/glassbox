import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { useFakeLayout } from '../test/layout';
import { JsonInspector } from './JsonInspector';

function renderJson(data: object, label = 'messages') {
  return render(
    <I18nContext.Provider value={makeI18n('en')}>
      <JsonInspector label={label} data={data} />
    </I18nContext.Provider>,
  );
}

const writeText = vi.fn(async (_text: string) => {});

/** `{ l1: { l2: … { lN: 'end' } } }`: the row of key `ln` sits n levels deep. */
function nested(levels: number): object {
  let value: unknown = 'end';
  for (let n = levels; n >= 1; n--) value = { [`l${n}`]: value };
  return value as object;
}

/** Levels 1 and 2 start collapsed; deeper levels then open by themselves. */
function openDeep(scope: HTMLElement) {
  fireEvent.click(within(scope).getByText('l1:'));
  fireEvent.click(within(scope).getByText('l2:'));
}

const rowOf = (scope: HTMLElement, n: number) =>
  within(scope).getByText(`l${n}:`).closest('[role=treeitem]');

describe('JsonInspector', () => {
  useFakeLayout();
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });
  afterEach(() => vi.useRealTimers());

  it('opens the top level and messages/tools, but leaves each message collapsed', () => {
    renderJson({
      messages: [
        { role: 'user', content: 'hello there' },
        { role: 'assistant', content: 'hi' },
      ],
      model: 'claude-opus-5-5',
    });
    expect(screen.getByText(/messages/)).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-5-5/)).toBeInTheDocument();
    expect(screen.queryByText(/hello there/)).toBeNull();
  });

  it('clips very long strings in the tree but copies the full data', async () => {
    const big = 'x'.repeat(5_000);
    renderJson({ text: big }, 'result');
    const tree = screen.getByRole('tree');
    expect(tree.textContent?.length).toBeLessThan(2_500);
    expect(tree).toHaveTextContent('… (3,000 more characters)');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ text: big }, null, 2));
  });

  it('labels expand and collapse controls in the UI language', () => {
    render(
      <I18nContext.Provider value={makeI18n('zh')}>
        <JsonInspector label="x" data={{ messages: [{ a: 1 }] }} />
      </I18nContext.Provider>,
    );
    expect(screen.getAllByRole('button', { name: '展开' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: '收起' }).length).toBeGreaterThan(0);
  });

  it('stops indenting past 24 levels and labels each deeper row with its level', async () => {
    renderJson(nested(30));
    const tree = screen.getByRole('tree');
    openDeep(tree);
    await waitFor(() => expect(rowOf(tree, 30)).toHaveAttribute('data-json-level', 'Level 30'));
    expect(rowOf(tree, 24)).toHaveAttribute('data-json-level', 'Level 24');
    expect(rowOf(tree, 23)).not.toHaveAttribute('data-json-level');
    expect(rowOf(tree, 2)).not.toHaveAttribute('data-json-level');
    // Not the generic data-level: the quota bar uses that, and picked up these rows' styles.
    expect(rowOf(tree, 30)).not.toHaveAttribute('data-level');
  });

  it('does not watch the tree of JSON that never gets 24 levels deep', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    renderJson(nested(23));
    openDeep(screen.getByRole('tree'));
    expect(observe).not.toHaveBeenCalled();
    observe.mockRestore();
  });

  it('labels deep rows of the maximised tree too, in the UI language', async () => {
    render(
      <I18nContext.Provider value={makeI18n('zh')}>
        <JsonInspector label="x" data={nested(26)} />
      </I18nContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    const dialog = screen.getByRole('dialog');
    openDeep(dialog);
    await waitFor(() => expect(rowOf(dialog, 26)).toHaveAttribute('data-json-level', '第 26 层'));
  });

  it('confirms a copy for one second', async () => {
    vi.useFakeTimers();
    renderJson({ a: 1 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('maximises into a dialog that returns focus when closed', () => {
    renderJson({ a: 1 }, 'tools');
    const max = screen.getByRole('button', { name: 'Maximize' });
    fireEvent.click(max);
    const dialog = screen.getByRole('dialog', { name: 'tools · JSON' });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(max).toHaveFocus();
  });

  it('offers the raw JSON text in the dialog, virtualised', () => {
    const data = { lines: Array.from({ length: 5_000 }, (_, i) => `line ${i}`) };
    renderJson(data, 'big');
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    const dialog = screen.getByRole('dialog', { name: 'big · JSON' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Raw' }));
    const rendered = dialog.querySelectorAll('[data-line]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(500);
    expect(rendered[0]?.textContent).toBe('{');
  });
});

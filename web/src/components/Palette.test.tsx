import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { Palette, type PaletteItem, rankItems } from './Palette';

const item = (label: string, more: Partial<PaletteItem> = {}): PaletteItem => ({
  id: label,
  kind: 'action',
  label,
  run: vi.fn(),
  ...more,
});

const labels = (items: PaletteItem[]) => items.map((i) => i.label);

describe('rankItems', () => {
  const items = [
    item('shopfront / Fix flaky login test', { kind: 'session' }),
    item('glassbox / Live viewer research', { kind: 'session' }),
    item('Prompt 2 · Research how a live viewer', {
      kind: 'prompt',
      keywords: 'Research how a live viewer could read Claude Code sessions',
    }),
    item('Stats', { kind: 'page' }),
    item('Theme: dark'),
    item('Switch to Chinese'),
  ];

  it('finds every word of the query, in any order and any case, and nothing else', () => {
    expect(labels(rankItems(items, 'VIEWER live'))).toEqual([
      'glassbox / Live viewer research',
      'Prompt 2 · Research how a live viewer',
    ]);
    expect(rankItems(items, 'fix dark')).toEqual([]);
    // A prompt is found by what it asked, beyond the words its line shows.
    expect(labels(rankItems(items, 'claude code'))).toEqual([
      'Prompt 2 · Research how a live viewer',
    ]);
  });

  it('puts a match at the start of the line first, then at the start of a word, then inside one', () => {
    const st = [item('mist'), item('the stars'), item('stats')];
    expect(labels(rankItems(st, 'st'))).toEqual(['stats', 'the stars', 'mist']);
    // Alike, they keep the order given.
    expect(labels(rankItems(items, 'res'))).toEqual([
      'glassbox / Live viewer research',
      'Prompt 2 · Research how a live viewer',
    ]);
  });

  it('puts the words found together, as typed, before the same words apart', () => {
    const apart = item('viewer of the live feed');
    const together = item('the live viewer');
    expect(labels(rankItems([apart, together], 'live viewer'))).toEqual([
      'the live viewer',
      'viewer of the live feed',
    ]);
  });
});

function renderPalette(items: PaletteItem[], onClose = vi.fn()) {
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <Palette items={items} onClose={onClose} />
    </I18nContext.Provider>,
  );
  return { onClose, field: screen.getByRole('combobox', { name: 'Jump to…' }) };
}

describe('Palette', () => {
  const sessions = Array.from({ length: 10 }, (_, i) =>
    item(`p${i} / Session ${i}`, {
      id: `s${i}`,
      kind: 'session',
      live: i === 0 ? 'waiting' : 'idle',
    }),
  );
  const prompts = Array.from({ length: 7 }, (_, i) =>
    item(`Prompt ${7 - i} · step ${7 - i}`, { id: `t${i}`, kind: 'prompt' }),
  );
  const rest = [
    item('Home', { kind: 'page' }),
    item('Files', { kind: 'tab' }),
    item('New session'),
  ];

  it('is a dialog with one field over a listbox, the first option active', () => {
    const { field } = renderPalette([...sessions.slice(0, 2), ...rest]);
    expect(screen.getByRole('dialog', { name: 'Jump to…' })).toHaveAttribute('aria-modal', 'true');
    expect(field).toHaveFocus();
    const list = screen.getByRole('listbox');
    expect(field).toHaveAttribute('aria-controls', list.id);
    expect(field).toHaveAttribute('aria-expanded', 'true');
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);
    expect(field).toHaveAttribute('aria-activedescendant', options[0]?.id);
    // Each says what it is; a session its state too.
    expect(options[0]).toHaveTextContent(/p0 \/ Session 0Session$/);
    expect(
      within(options[0] as HTMLElement).getByRole('img', { name: 'Waiting for you' }),
    ).toBeVisible();
    expect(options.slice(2).map((o) => o.textContent)).toEqual([
      'HomePage',
      'FilesTab',
      'New sessionAction',
    ]);
  });

  it('opens on the likeliest few: eight sessions and the five newest prompts, then the rest', () => {
    renderPalette([...sessions, ...prompts, ...rest]);
    const shown = screen.getAllByRole('option').map((o) => o.textContent);
    expect(shown).toHaveLength(8 + 5 + 3);
    expect(shown[7]).toMatch(/^p7 \/ Session 7/);
    expect(shown[8]).toMatch(/^Prompt 7 · step 7/);
    expect(shown[12]).toMatch(/^Prompt 3 · step 3/);
  });

  it('moves with the arrows, round the ends, and runs the active option on Enter', () => {
    const items = [item('One'), item('Two'), item('Three')];
    const { field, onClose } = renderPalette(items);
    const active = () => screen.getByRole('option', { selected: true }).textContent;
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(active()).toBe('ThreeAction');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(active()).toBe('OneAction');
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(active()).toBe('ThreeAction');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(items[2]?.run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(items[0]?.run).not.toHaveBeenCalled();
  });

  it('filters as you type, best first, the first match active; says so when nothing matches', () => {
    const { field } = renderPalette([...sessions.slice(0, 3), ...rest]);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.change(field, { target: { value: 'session 2' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'p2 / Session 2Session',
    ]);
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Session 2');
    fireEvent.change(field, { target: { value: 'nothing like it' } });
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent('Nothing matches');
    fireEvent.keyDown(field, { key: 'Enter' });
  });

  it('runs an option clicked, the field keeping focus as it is pressed', () => {
    const items = [item('One'), item('Two')];
    renderPalette(items);
    const two = screen.getByRole('option', { name: /Two/ });
    expect(fireEvent.mouseDown(two)).toBe(false);
    fireEvent.click(two);
    expect(items[1]?.run).toHaveBeenCalledOnce();
  });

  it('closes on Esc and on ⌘K or Ctrl+K, and keeps Tab in its field', () => {
    const { field, onClose } = renderPalette([item('One')]);
    expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(false);
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.keyDown(field, { key: 'k', metaKey: true });
    fireEvent.keyDown(field, { key: 'k', ctrlKey: true });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('gives focus back to where it was when it closes', () => {
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <Host items={[item('One')]} />
      </I18nContext.Provider>,
    );
    const opener = screen.getByRole('button', { name: 'Jump' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('combobox')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});

/** Its owner: a button that opens it, and closes it when asked. */
function Host({ items }: { items: PaletteItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Jump
      </button>
      {open && <Palette items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

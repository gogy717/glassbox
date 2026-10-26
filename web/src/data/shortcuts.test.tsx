import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Command,
  canRun,
  KEYMAP,
  keyLabel,
  runCommand,
  SEQUENCE_MS,
  useCommand,
  useShortcuts,
} from './shortcuts';

/** The page as the app has it: the key map listened for, a few commands carried out, fields. */
function Page({ ran, commands }: { ran: Command[]; commands: Command[] }) {
  useShortcuts();
  return (
    <>
      {commands.map((c) => (
        <Carry key={c} command={c} ran={ran} />
      ))}
      <input aria-label="Search" />
      <textarea aria-label="Message" />
      {/* biome-ignore lint/a11y/useSemanticElements: editable text, as a rich editor has it */}
      <div
        contentEditable
        suppressContentEditableWarning
        aria-label="Editor"
        role="textbox"
        tabIndex={0}
      >
        x
      </div>
      <button type="button">Elsewhere</button>
    </>
  );
}

function Carry({ command, ran }: { command: Command; ran: Command[] }) {
  useCommand(command, () => ran.push(command));
  return null;
}

/** A receipt button's part: it counts the times it was asked, with the state it sees then. */
function Receipt({ ran }: { ran: string[] }) {
  const [n, setN] = useState(0);
  useCommand('receipt', () => {
    ran.push(`receipt ${n}`);
    setN(n + 1);
  });
  return null;
}

const ALL: Command[] = [
  'palette',
  'help',
  'search',
  'goHome',
  'goStats',
  'goInbox',
  'tab:steps',
  'nextPrompt',
  'allowItem',
  'denyItem',
  'openItem',
];

function setup(commands = ALL) {
  const ran: Command[] = [];
  render(<Page ran={ran} commands={commands} />);
  return ran;
}

/** A key pressed on the page; false when something prevented its default. */
const press = (key: string, init: KeyboardEventInit = {}, on: Element = document.body) =>
  fireEvent.keyDown(on, { key, ...init });

describe('useShortcuts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('sends each key’s command: ? the help, / the search, a digit its tab, j the next prompt', () => {
    const ran = setup();
    press('?', { shiftKey: true });
    press('/');
    press('2');
    press('j');
    expect(ran).toEqual(['help', 'search', 'tab:steps', 'nextPrompt']);
  });

  it('answers the Inbox’s item with y and n, opens it with o, and goes there with g i', () => {
    const ran = setup();
    press('y');
    press('n');
    press('o');
    press('g');
    press('i');
    expect(ran).toEqual(['allowItem', 'denyItem', 'openItem', 'goInbox']);
  });

  it('answers once for a key held down, while a held j goes on down the list', () => {
    const ran = setup();
    for (const key of ['y', 'n', 'o']) press(key, { repeat: true });
    press('j', { repeat: true });
    press('j', { repeat: true });
    expect(ran).toEqual(['nextPrompt', 'nextPrompt']);
  });

  it('does nothing while typing in a field, a text area or an editable element', () => {
    const ran = setup();
    for (const name of ['Search', 'Message', 'Editor']) {
      const field = screen.getByRole('textbox', { name });
      field.focus();
      for (const key of ['?', '/', '2', 'j', 'y', 'n', 'o', 'g', 'h']) press(key, {}, field);
    }
    expect(ran).toEqual([]);
    // Off the field again, a key works.
    press('j', {}, screen.getByRole('button', { name: 'Elsewhere' }));
    expect(ran).toEqual(['nextPrompt']);
  });

  it('goes Home on g then h within a second, and not later or with another key between', () => {
    const ran = setup();
    press('g');
    press('h');
    expect(ran).toEqual(['goHome']);
    press('g');
    act(() => vi.advanceTimersByTime(SEQUENCE_MS + 1));
    press('h');
    press('g');
    press('x');
    press('h');
    expect(ran).toEqual(['goHome']);
    // Shift on its way to a key does not break the pair; g then t is Stats.
    press('g');
    press('Shift', { shiftKey: true });
    press('t');
    expect(ran).toEqual(['goHome', 'goStats']);
  });

  it('leaves a key alone with Ctrl, ⌘ or Alt held, and opens the palette with Ctrl+K or ⌘K', () => {
    const ran = setup();
    press('2', { ctrlKey: true });
    press('j', { metaKey: true });
    press('?', { altKey: true, shiftKey: true });
    expect(ran).toEqual([]);
    expect(press('k', { metaKey: true })).toBe(false);
    // From a field too: it is the one key that carries a modifier.
    const field = screen.getByRole('textbox', { name: 'Search' });
    field.focus();
    press('k', { ctrlKey: true }, field);
    press('K', { ctrlKey: true, shiftKey: true }, field);
    expect(ran).toEqual(['palette', 'palette']);
  });

  it('does nothing while a modal dialog is open, or while an input method composes', () => {
    const ran = setup();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    press('?', { shiftKey: true });
    press('k', { metaKey: true });
    modal.remove();
    press('j', { isComposing: true });
    expect(ran).toEqual([]);
    press('j');
    expect(ran).toEqual(['nextPrompt']);
  });

  it('takes a key from the page only when something carries its command out', () => {
    setup(['help']);
    expect(press('?', { shiftKey: true })).toBe(false);
    // No tab strip on this page: the digit is the browser's.
    expect(press('1')).toBe(true);
    expect(press('k', { metaKey: true })).toBe(true);
  });

  it('reads CapsLock as the key itself, but a shifted letter as another key', () => {
    const ran = setup();
    press('J');
    press('J', { shiftKey: true });
    expect(ran).toEqual(['nextPrompt']);
  });
});

describe('useCommand and runCommand', () => {
  it('reaches the part of the page that carries a command out, only while it is there', () => {
    const ran: string[] = [];
    expect(canRun('receipt')).toBe(false);
    expect(runCommand('receipt')).toBe(false);
    const { unmount } = render(<Receipt ran={ran} />);
    expect(canRun('receipt')).toBe(true);
    act(() => {
      runCommand('receipt');
    });
    act(() => {
      runCommand('receipt');
    });
    // The latest handler runs, with the state it sees now.
    expect(ran).toEqual(['receipt 0', 'receipt 1']);
    unmount();
    expect(canRun('receipt')).toBe(false);
  });
});

describe('KEYMAP', () => {
  it('names every binding once, with words for the help', () => {
    const keys = KEYMAP.flatMap((row) => row.bindings.map((b) => b.keys.join(' ')));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        'Mod+k',
        '/',
        '1',
        '5',
        'j',
        'k',
        'g h',
        'g s',
        'g t',
        'g i',
        'y',
        'n',
        'o',
        '?',
        'Escape',
      ]),
    );
    expect(keyLabel('Mod+k')).toBe('Ctrl K');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keyLabel('g')).toBe('g');
  });
});

/**
 * Keyboard shortcuts: the key map in one place (`KEYMAP`, which the ? overlay lists), the hook
 * that listens for it (`useShortcuts`), and the commands a key or the palette sends to whichever
 * part of the page carries them out (`useCommand`, `runCommand`): the tabs switch themselves, the
 * prompt list moves its own selection, a receipt button opens its own dialog, the Inbox answers
 * its own items. A key whose command nothing carries out stays the browser's.
 */
import { useEffect, useRef } from 'react';
import type { MessageKey } from '../i18n';
import { TABS, type Tab } from '../router';

export type Command =
  | 'palette'
  | 'help'
  | 'search'
  | 'goHome'
  | 'goSession'
  | 'goStats'
  | 'goInbox'
  | 'goRules'
  | `tab:${Tab}`
  | 'nextPrompt'
  | 'previousPrompt'
  | 'allowItem'
  | 'denyItem'
  | 'openItem'
  | 'receipt';

/** One key, or two in a row ("g h"). `Mod+k` is ⌘K on a Mac and Ctrl+K elsewhere. */
export interface Binding {
  keys: readonly string[];
  /** Null for a key each overlay handles itself (Esc closes it). */
  command: Command | null;
  /**
   * Held down, the key does it once: an answer, which the repeats would otherwise give each next
   * item as it arms.
   */
  once?: boolean;
}

/** A line of the ? overlay: what its keys do. */
export interface KeyRow {
  label: MessageKey;
  bindings: readonly Binding[];
}

export const KEYMAP: readonly KeyRow[] = [
  { label: 'keys.palette', bindings: [{ keys: ['Mod+k'], command: 'palette' }] },
  { label: 'keys.search', bindings: [{ keys: ['/'], command: 'search' }] },
  {
    label: 'keys.tabs',
    bindings: TABS.map((tab, i) => ({ keys: [String(i + 1)], command: `tab:${tab}` as const })),
  },
  // Down and up the list the page has: a session's prompt list, or the Inbox.
  {
    label: 'keys.prompts',
    bindings: [
      { keys: ['j'], command: 'nextPrompt' },
      { keys: ['k'], command: 'previousPrompt' },
    ],
  },
  // The Inbox's item focus is on: its own buttons say which key presses them.
  {
    label: 'keys.answer',
    bindings: [
      { keys: ['y'], command: 'allowItem', once: true },
      { keys: ['n'], command: 'denyItem', once: true },
    ],
  },
  { label: 'keys.openItem', bindings: [{ keys: ['o'], command: 'openItem', once: true }] },
  { label: 'keys.home', bindings: [{ keys: ['g', 'h'], command: 'goHome' }] },
  { label: 'keys.session', bindings: [{ keys: ['g', 's'], command: 'goSession' }] },
  { label: 'keys.stats', bindings: [{ keys: ['g', 't'], command: 'goStats' }] },
  { label: 'keys.inbox', bindings: [{ keys: ['g', 'i'], command: 'goInbox' }] },
  { label: 'keys.rules', bindings: [{ keys: ['g', 'r'], command: 'goRules' }] },
  { label: 'keys.help', bindings: [{ keys: ['?'], command: 'help' }] },
  { label: 'keys.close', bindings: [{ keys: ['Escape'], command: null }] },
];

/** The second key of a pair counts within this long of the first. */
export const SEQUENCE_MS = 1000;

const BINDINGS = KEYMAP.flatMap((row) => row.bindings);
/** Keys that start a pair: alone, they wait for the next one. */
const STARTS = new Set(BINDINGS.filter((b) => b.keys.length === 2).map((b) => b.keys[0]));
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** A key as the overlay and the top bar write it: ⌘K or Ctrl K, Esc, the rest as typed. */
export function keyLabel(key: string): string {
  if (key === 'Mod+k') return isMac() ? '⌘K' : 'Ctrl K';
  if (key === 'Escape') return 'Esc';
  return key;
}

/** The palette's keys for `aria-keyshortcuts`. */
export const paletteKeys = () => (isMac() ? 'Meta+K' : 'Control+K');

/** Typing: in a field, a text area, a select or editable text. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return true;
  // jsdom knows no isContentEditable; browsers answer above.
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

const bus = new EventTarget();
const carriers = new Map<Command, number>();

/** Whether some part of the page carries `command` out right now (`useCommand`). */
export const canRun = (command: Command): boolean => (carriers.get(command) ?? 0) > 0;

/** Sends `command` to the part of the page that carries it out; false when none does. */
export function runCommand(command: Command): boolean {
  if (!canRun(command)) return false;
  bus.dispatchEvent(new Event(command));
  return true;
}

/** Carries `command` out with `run` while mounted and `enabled`; the latest `run` is the one. */
export function useCommand(command: Command, run: () => void, enabled = true): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!enabled) return;
    const onCommand = () => latest.current();
    bus.addEventListener(command, onCommand);
    carriers.set(command, (carriers.get(command) ?? 0) + 1);
    return () => {
      bus.removeEventListener(command, onCommand);
      carriers.set(command, (carriers.get(command) ?? 1) - 1);
    };
  }, [command, enabled]);
}

/**
 * Listens for the key map on the document while mounted, and sends each key's command. A key is
 * taken from the page (its default prevented) only when something carries its command out. Never
 * while typing or while an input method composes, never with Ctrl, ⌘ or Alt held (⌘K / Ctrl+K
 * aside, which works from a field too, but for Ctrl+K in a Mac's text field: delete to the line's
 * end), and never while a modal dialog is open: it has keys of its own. A pair ("g h") counts when
 * its second key comes within SEQUENCE_MS of the first.
 */
export function useShortcuts(): void {
  useEffect(() => {
    let pending: { key: string; at: number } | null = null;
    const send = (e: KeyboardEvent, command: Command | null) => {
      if (command && runCommand(command)) e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || MODIFIERS.has(e.key)) return;
      if (document.querySelector('[aria-modal="true"]')) {
        pending = null;
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        pending = null;
        if (e.ctrlKey && !e.metaKey && isMac() && typing(e.target)) return;
        send(e, 'palette');
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) {
        pending = null;
        return;
      }
      // CapsLock types J for j; a shifted letter is another key.
      const key = e.key.length === 1 && !e.shiftKey ? e.key.toLowerCase() : e.key;
      const now = Date.now();
      const first = pending && now - pending.at <= SEQUENCE_MS ? pending.key : null;
      pending = null;
      const pair =
        first &&
        BINDINGS.find((b) => b.keys.length === 2 && b.keys[0] === first && b.keys[1] === key);
      if (pair) return send(e, pair.command);
      if (STARTS.has(key)) {
        pending = { key, at: now };
        return;
      }
      const single = BINDINGS.find((b) => b.keys.length === 1 && b.keys[0] === key);
      if (single?.once && e.repeat) return;
      send(e, single?.command ?? null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

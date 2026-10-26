import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LiveState } from '../../../src/core/model.js';
import { useI18n } from '../i18n';
import css from './Palette.module.css';
import { LiveDot } from './Status';

export type PaletteKind = 'session' | 'prompt' | 'page' | 'tab' | 'action';

/** Something the palette can jump to or do. */
export interface PaletteItem {
  /** Unique among the items. */
  id: string;
  kind: PaletteKind;
  /** Its line: "glassbox / Fix the build", "Prompt 12 · Run the tests", "Stats". */
  label: string;
  /** Words it is found by besides its line: a session's agent, a prompt's whole text. */
  keywords?: string;
  /** A session's state, for its dot. */
  live?: LiveState;
  run(): void;
}

/** With nothing typed, at most this many of a kind: the likeliest, as the items come. */
const FIRST: Partial<Record<PaletteKind, number>> = { session: 8, prompt: 5 };
/** With a query, at most this many matches. */
const MAX_MATCHES = 50;

/** Each item's lowercased line and words, made once: the items are made per open, typing per key. */
const texts = new WeakMap<PaletteItem, { label: string; all: string }>();
const textOf = (item: PaletteItem) => {
  let text = texts.get(item);
  if (!text) {
    const label = item.label.toLowerCase();
    text = { label, all: `${label} ${item.keywords?.toLowerCase() ?? ''}` };
    texts.set(item, text);
  }
  return text;
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The items that match `query`, best first: every word of it is found in an item's line or its
 * words, in any order and any case. A word at the start of the line counts most, then one at the
 * start of a word, then one inside a word; the words found together as typed count for more. Alike,
 * the items keep the order given.
 */
export function rankItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  const starts = words.map((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(w)}`, 'u'));
  const phrase = words.join(' ');
  const scored: { item: PaletteItem; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    const text = textOf(item);
    let score = 0;
    for (const [i, w] of words.entries()) {
      if (!text.all.includes(w)) return;
      score += text.label.startsWith(w) ? 3 : starts[i]?.test(text.all) ? 2 : 1;
    }
    if (words.length > 1 && text.label.includes(phrase)) score += 2;
    scored.push({ item, score, at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.item);
}

/** What the palette lists before anything is typed: each kind cut at its FIRST count. */
function firstItems(items: readonly PaletteItem[]): PaletteItem[] {
  const seen = new Map<PaletteKind, number>();
  return items.filter((item) => {
    const n = (seen.get(item.kind) ?? 0) + 1;
    seen.set(item.kind, n);
    return n <= (FIRST[item.kind] ?? Number.POSITIVE_INFINITY);
  });
}

interface Props {
  /** Everything it can jump to or do, the likeliest first within each kind. */
  items: readonly PaletteItem[];
  onClose(): void;
}

/**
 * ⌘K: one field over a list, filtered as you type (`rankItems`). The arrow keys move through the
 * list, round its ends; Enter runs the option, as a click does; Esc, ⌘K or a click outside closes
 * it. Focus stays in the field, the active option named by it (WAI-ARIA combobox with a listbox),
 * and goes back to where it was when the palette closes.
 */
export function Palette({ items, onClose }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const shown = useMemo(
    () => (query.trim() ? rankItems(items, query).slice(0, MAX_MATCHES) : firstItems(items)),
    [items, query],
  );
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const optionId = (i: number) => `${id}-option-${i}`;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    field.current?.focus();
    return () => opener?.focus();
  }, []);
  // The active option stays in view as the arrows move it.
  useEffect(() => {
    document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [id, active]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // An input method composing (Chinese, Japanese) owns Enter, Esc and the arrows.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const n = shown.length;
    const toggle =
      (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n > 0) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === 'Escape' || toggle) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') e.preventDefault();
  };

  return createPortal(
    <div className={css.overlay} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={css.palette}
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        // Focus stays in the field, and so do its keys, whatever else inside is pressed: an
        // option, the list's edge, "Nothing matches".
        onMouseDown={(e) => e.target !== field.current && e.preventDefault()}
      >
        <input
          ref={field}
          className={css.field}
          type="text"
          role="combobox"
          aria-label={t('palette.title')}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={shown[active] ? optionId(active) : undefined}
          placeholder={t('palette.placeholder')}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={t('palette.matches')}
          className={css.list}
          hidden={shown.length === 0}
        >
          {shown.map((item, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the field's keys move through the options and pick one
            <div
              key={item.id}
              id={optionId(i)}
              role="option"
              // Never focused: the field keeps focus (the dialog's mousedown).
              tabIndex={-1}
              aria-selected={i === active}
              className={css.option}
              onPointerMove={() => setActive(i)}
              onClick={() => choose(item)}
            >
              {item.live && <LiveDot state={item.live} label={t(`live.${item.live}`)} />}
              <span className={css.label}>{item.label}</span>
              <span className={css.kind}>{t(`palette.kind.${item.kind}`)}</span>
            </div>
          ))}
        </div>
        {shown.length === 0 && (
          <p className={css.none} role="status">
            {t('palette.none')}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

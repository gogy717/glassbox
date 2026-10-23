import { type KeyboardEvent, type RefObject, useState } from 'react';

/** What an item of a roving list spreads onto its button. */
export interface RovingItemProps {
  tabIndex: 0 | -1;
  'data-roving': string;
  onFocus(): void;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
}

/**
 * One tab stop for a long list of buttons (WAI-ARIA roving tabindex): Tab enters at the item
 * last focused, else the current one, else the first; the arrow keys, Home and End move between
 * the items in `container`, in DOM order, without wrapping. Both axes move, so the same list works
 * as a column and as a horizontal strip.
 */
export function useRovingFocus(
  container: RefObject<HTMLElement | null>,
  ids: readonly string[],
  currentId: string | null,
): (id: string) => RovingItemProps {
  const [focused, setFocused] = useState<string | null>(null);
  const stop =
    focused !== null && ids.includes(focused)
      ? focused
      : currentId !== null && ids.includes(currentId)
        ? currentId
        : (ids[0] ?? null);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const items = [...(container.current?.querySelectorAll<HTMLElement>('[data-roving]') ?? [])];
    const i = items.indexOf(e.currentTarget);
    if (i < 0) return;
    const next =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? Math.min(i + 1, items.length - 1)
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? Math.max(i - 1, 0)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };

  return (id) => ({
    tabIndex: id === stop ? 0 : -1,
    'data-roving': id,
    onFocus: () => setFocused(id),
    onKeyDown,
  });
}

import type { KeyboardEvent } from 'react';
import css from './Switch.module.css';

/** One choice of a `Switch`. */
export interface SwitchOption<V extends string> {
  value: V;
  /** The word shown. */
  label: string;
  /**
   * Shown struck through and never chosen, but still reachable with the arrow keys, so its
   * `title` (why it is unavailable) is read out on focus as well as shown on hover.
   */
  disabled?: boolean;
  /** Tooltip, e.g. why a disabled choice is unavailable. */
  title?: string;
}

/**
 * The two-word switch (D1): two (or three) words side by side, the chosen one underlined in ink.
 * It replaces the segmented controls with a raised thumb. A radio group: one tab stop, on the
 * chosen word (on the first word when none is chosen); the arrow keys, Home and End move the
 * focus over every word and choose the enabled ones.
 *
 * A disabled word is `aria-disabled`, not natively disabled: it stays focusable, so a keyboard or
 * screen reader user reaches it and hears its `title` (the reason) as its description, as a
 * pointer user sees it on hover. It is never chosen; if it is the current value, it keeps its
 * underline under the strike-through.
 *
 * - `label`: the group's accessible name ("View", "Order").
 * - `value` / `onChange(value)`: controlled; `onChange` fires only for a different, enabled word.
 * - `onChoose(value)`: optional; fires for every explicit pick of an enabled word, the current
 *   one included, so a click on the chosen word can confirm it.
 * - `options`: the words, in order; see `SwitchOption`.
 * - `size`: 'small' (11px, in dense heads) or 'medium' (12px, the default).
 * - `variant`: 'words' (the default), or 'segmented' for a page-level choice that sits with the
 *   top bar's instruments: bordered segments 30px high, the chosen one filled (D4), as the page
 *   nav is drawn.
 */
export function Switch<V extends string>({
  label,
  value,
  options,
  onChange,
  onChoose,
  size = 'medium',
  variant = 'words',
}: {
  label: string;
  value: V;
  options: readonly SwitchOption<V>[];
  onChange(value: V): void;
  onChoose?(value: V): void;
  size?: 'small' | 'medium';
  variant?: 'words' | 'segmented';
}) {
  const choose = (o: SwitchOption<V>) => {
    if (o.disabled) return;
    onChoose?.(o.value);
    if (o.value !== value) onChange(o.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const n = options.length;
    // From the focused word: the chosen one, or a disabled word the arrows stopped on.
    const i = options.findIndex((o) => o.value === e.currentTarget.dataset.value);
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? options[(i + 1) % n]
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? options[i <= 0 ? n - 1 : i - 1]
          : e.key === 'Home'
            ? options[0]
            : e.key === 'End'
              ? options[n - 1]
              : undefined;
    if (!next) return;
    e.preventDefault();
    choose(next);
    // Focus follows, as in a native radio group; on a disabled word it only brings the reason.
    const group = e.currentTarget.parentElement;
    group?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  // The chosen word holds the tab stop, enabled or not; with none chosen, the first word does.
  const stop = options.some((o) => o.value === value) ? value : options[0]?.value;
  return (
    <div
      className={css.switch}
      role="radiogroup"
      aria-label={label}
      data-size={size}
      data-variant={variant}
    >
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a two-word switch styled as words, not radios
        <button
          key={o.value}
          type="button"
          role="radio"
          className={css.word}
          data-value={o.value}
          aria-checked={o.value === value}
          aria-disabled={o.disabled || undefined}
          title={o.title}
          tabIndex={o.value === stop ? 0 : -1}
          onClick={() => choose(o)}
          onKeyDown={onKeyDown}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

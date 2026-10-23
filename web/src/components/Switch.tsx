import type { KeyboardEvent } from 'react';
import css from './Switch.module.css';

/** One choice of a `Switch`. */
export interface SwitchOption<V extends string> {
  value: V;
  /** The word shown. */
  label: string;
  /** Shown struck through and skipped by the keyboard; say why in `title`. */
  disabled?: boolean;
  /** Tooltip, e.g. why a disabled choice is unavailable. */
  title?: string;
}

/**
 * The two-word switch (D1): two (or three) words side by side, the chosen one underlined in ink.
 * It replaces the segmented controls with a raised thumb. A radio group: one tab stop on the
 * chosen word; the arrow keys, Home and End move the choice, skipping disabled words.
 *
 * - `label`: the group's accessible name ("View", "Order").
 * - `value` / `onChange(value)`: controlled; `onChange` fires only for a different, enabled word.
 * - `options`: the words, in order; see `SwitchOption`.
 * - `size`: 'small' (11px, in dense heads) or 'medium' (12px, the default).
 */
export function Switch<V extends string>({
  label,
  value,
  options,
  onChange,
  size = 'medium',
}: {
  label: string;
  value: V;
  options: readonly SwitchOption<V>[];
  onChange(value: V): void;
  size?: 'small' | 'medium';
}) {
  const enabled = options.filter((o) => !o.disabled);
  const choose = (v: V) => {
    if (v !== value) onChange(v);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = enabled.findIndex((o) => o.value === value);
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? enabled[(i + 1) % enabled.length]
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? enabled[(i - 1 + enabled.length) % enabled.length]
          : e.key === 'Home'
            ? enabled[0]
            : e.key === 'End'
              ? enabled.at(-1)
              : undefined;
    if (!next) return;
    e.preventDefault();
    choose(next.value);
    // Focus follows the choice, as in a native radio group.
    const group = e.currentTarget.parentElement;
    group?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  // If the value matches no enabled word, the first enabled word keeps the tab stop.
  const stop = enabled.some((o) => o.value === value) ? value : enabled[0]?.value;
  return (
    <div className={css.switch} role="radiogroup" aria-label={label} data-size={size}>
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
          disabled={o.disabled}
          title={o.title}
          tabIndex={o.value === stop ? 0 : -1}
          onClick={() => choose(o.value)}
          onKeyDown={onKeyDown}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

import {
  type CSSProperties,
  cloneElement,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import css from './Tooltip.module.css';

/** How long the pointer (or focus) rests on the anchor before the tip shows (D1). */
export const TOOLTIP_DELAY_MS = 400;

/**
 * D1's tooltip: 11px text in a hairline-strong, radius-6 box, shown 400 ms after the pointer
 * rests on its anchor or focus lands on it, with no transition. Leaving, blurring or Escape hides
 * it. The text describes the anchor (aria-describedby), as a title would, but styled and quick.
 * It is placed `fixed`, so a scrolling container does not clip it.
 *
 * - `label`: the text.
 * - `placement`: above the anchor ('top', the default) or below it ('bottom').
 * - `children`: one element that takes `aria-describedby`. A disabled control fires no pointer
 *   events, so give that one a native `title` instead.
 */
export function Tooltip({
  label,
  placement = 'top',
  children,
}: {
  label: string;
  placement?: 'top' | 'bottom';
  children: ReactElement<{ 'aria-describedby'?: string }>;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [at, setAt] = useState<CSSProperties | null>(null);
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setAt({
        left: r.left + r.width / 2,
        top: placement === 'top' ? r.top - 6 : r.bottom + 6,
      });
    }, TOOLTIP_DELAY_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setAt(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only show a description
    <span
      ref={anchor}
      className={css.anchor}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && at) {
          e.stopPropagation();
          hide();
        }
      }}
    >
      {cloneElement(children, { 'aria-describedby': id })}
      <span
        id={id}
        role="tooltip"
        className={css.tip}
        data-placement={placement}
        hidden={!at}
        style={at ?? undefined}
      >
        {label}
      </span>
    </span>
  );
}

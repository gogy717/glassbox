import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import css from './TurnTitle.module.css';

interface Props {
  text: string;
  /** Names the turn for screen readers inside the heading, where a visible label sits above it. */
  label?: string;
  className?: string;
  /** Controls on the toggle's line, after it (the execution chain's Copy as Markdown). */
  actions?: ReactNode;
}

/**
 * The open turn's heading (execution chain, steps): the whole prompt clamped to a few lines, and
 * when it does not fit, a toggle to read all of it with its line breaks. Callers key it by turn,
 * so opening another turn starts folded.
 */
export function TurnTitle({ text, label, className, actions }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  // Whether the clamp hides anything depends on the width, so measure again on every resize.
  // biome-ignore lint/correctness/useExhaustiveDependencies: new text can overflow at the same size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <div className={`${css.title} ${className ?? ''}`}>
      <h2 ref={ref} id={id} className={css.text} data-expanded={expanded}>
        {label && label !== text && (
          <>
            <span className="visually-hidden">{`${label}:`}</span>{' '}
          </>
        )}
        {text}
      </h2>
      {(clamped || expanded || actions) && (
        <div className={css.actions}>
          {(clamped || expanded) && (
            <button
              type="button"
              className={css.toggle}
              aria-expanded={expanded}
              aria-controls={id}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? (
                <ChevronUp size={12} aria-hidden="true" />
              ) : (
                <ChevronDown size={12} aria-hidden="true" />
              )}
              {t(expanded ? 'flow.promptLess' : 'flow.promptMore')}
            </button>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

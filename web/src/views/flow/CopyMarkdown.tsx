import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Turn } from '../../../../src/core/model.js';
import type { OpenSession } from '../../data/store';
import { useI18n } from '../../i18n';
import css from './CopyMarkdown.module.css';
import { turnMarkdown } from './turn-markdown';

/** How long the button says Copied, or that it could not, before it is itself again. */
const SAID_MS = 1500;

/**
 * "Copy as Markdown", beside the open prompt's Show full prompt: the prompt as a quote, its final
 * reply and its calls (`turnMarkdown`), built only when pressed.
 */
export function CopyMarkdown({ open, turn }: { open: OpenSession; turn: Turn }) {
  const { t } = useI18n();
  const [said, setSaid] = useState<'copied' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    let result: 'copied' | 'failed' = 'copied';
    try {
      await navigator.clipboard.writeText(turnMarkdown(open, turn, t));
    } catch {
      // No clipboard (permissions, an insecure context): say so rather than nothing.
      result = 'failed';
    }
    setSaid(result);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), SAID_MS);
  };
  return (
    <button type="button" className={css.copy} onClick={copy}>
      {said === 'copied' ? (
        <Check size={12} aria-hidden="true" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
      {t(
        said === 'copied'
          ? 'flow.copiedMarkdown'
          : said === 'failed'
            ? 'flow.copyFailed'
            : 'flow.copyMarkdown',
      )}
    </button>
  );
}

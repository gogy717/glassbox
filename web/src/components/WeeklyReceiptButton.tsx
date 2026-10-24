import { Receipt } from 'lucide-react';
import { Suspense, useRef, useState } from 'react';
import type { WeekWindowKind } from '../../../src/shared/week.js';
import { lazyView } from '../lib/lazy-view';
import { ReceiptBoundary, ReceiptLoading } from './ReceiptEntry';
import css from './WeeklyReceiptButton.module.css';

// The session receipt's chunk: the weekly receipt is drawn by the same code.
const WeeklyReceiptDialog = lazyView(() =>
  import('./receipt/ReceiptDialog').then((m) => m.WeeklyReceiptDialog),
);

/**
 * Prints this machine's week as a receipt: the Stats page's main action (D4), and the shared
 * dialog once pressed, on the window the page shows. It works with no session at all: the week
 * then says it had none. Probe sessions count only when the sidebar shows them.
 */
export function WeeklyReceiptButton({
  showProbes = false,
  start = 'week',
  label,
}: {
  showProbes?: boolean;
  /** The window the dialog opens on. */
  start?: WeekWindowKind;
  /** Its word, in the page's own strings ("Print weekly receipt"). */
  label: string;
}) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={css.button}
        aria-haspopup="dialog"
        onClick={() => setShown(true)}
      >
        <Receipt size={14} aria-hidden="true" />
        {label}
      </button>
      {shown && (
        <ReceiptBoundary onReset={() => setShown(false)}>
          <Suspense fallback={<ReceiptLoading />}>
            <WeeklyReceiptDialog
              returnFocusTo={ref}
              onClose={() => setShown(false)}
              showProbes={showProbes}
              start={start}
            />
          </Suspense>
        </ReceiptBoundary>
      )}
    </>
  );
}

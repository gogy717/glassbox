import { Receipt } from 'lucide-react';
import { Suspense, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { lazyView } from '../lib/lazy-view';
import { ReceiptBoundary, ReceiptLoading } from './ReceiptEntry';
import css from './WeeklyReceiptButton.module.css';

// The session receipt's chunk: the weekly receipt is drawn by the same code.
const WeeklyReceiptDialog = lazyView(() =>
  import('./receipt/ReceiptDialog').then((m) => m.WeeklyReceiptDialog),
);

/**
 * Prints this machine's week as a receipt: the Now board's button, and the dialog once pressed,
 * on This week. It works with no session at all: the week then says it had none. Probe sessions
 * count only when the sidebar shows them.
 */
export function WeeklyReceiptButton({ showProbes = false }: { showProbes?: boolean }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      {/* Named by its word, which narrow screens hide: the icon alone still says it. */}
      <button
        ref={ref}
        type="button"
        className={css.button}
        aria-label={t('receipt.week')}
        title={t('receipt.week')}
        aria-haspopup="dialog"
        onClick={() => setShown(true)}
      >
        <Receipt size={14} aria-hidden="true" />
        <span className={css.label} aria-hidden="true">
          {t('receipt.week')}
        </span>
      </button>
      {shown && (
        <ReceiptBoundary onReset={() => setShown(false)}>
          <Suspense fallback={<ReceiptLoading />}>
            <WeeklyReceiptDialog
              returnFocusTo={ref}
              onClose={() => setShown(false)}
              showProbes={showProbes}
            />
          </Suspense>
        </ReceiptBoundary>
      )}
    </>
  );
}

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
 * Prints this machine's week as a receipt: the Now board's button, and the dialog once pressed.
 * It works with no session at all: the week then says it had none.
 */
export function WeeklyReceiptButton() {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={css.button}
        aria-label={t('receipt.week')}
        aria-haspopup="dialog"
        onClick={() => setShown(true)}
      >
        <Receipt size={14} aria-hidden="true" />
        <span className={css.label}>{t('receipt.week')}</span>
      </button>
      {shown && (
        <ReceiptBoundary onReset={() => setShown(false)}>
          <Suspense fallback={<ReceiptLoading />}>
            <WeeklyReceiptDialog returnFocusTo={ref} onClose={() => setShown(false)} />
          </Suspense>
        </ReceiptBoundary>
      )}
    </>
  );
}

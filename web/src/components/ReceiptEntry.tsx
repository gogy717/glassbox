import { Component, type ReactNode, useEffect, useState } from 'react';
import { I18nContext, useI18n } from '../i18n';
import { ChunkLoadError } from '../lib/lazy-view';
import css from './ReceiptEntry.module.css';

/**
 * A receipt's own boundary: when its code does not load (a stale chunk after an upgrade) or it
 * cannot draw, a line beside its button says so; the view around it stays.
 */
export class ReceiptBoundary extends Component<
  { children: ReactNode; onReset(): void },
  { error: Error | null }
> {
  static override contextType = I18nContext;
  declare context: React.ContextType<typeof I18nContext>;
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { t } = this.context;
    const chunk = error instanceof ChunkLoadError;
    return (
      <span role="alert" className={css.note}>
        {chunk ? t('error.chunk') : t('error.view', { msg: error.message })}{' '}
        <button
          type="button"
          className={css.retry}
          onClick={() => (chunk ? location.reload() : this.props.onReset())}
        >
          {t(chunk ? 'error.reload' : 'error.retry')}
        </button>
      </span>
    );
  }
}

/** Says a receipt is loading only when loading takes long enough to notice. */
export function ReceiptLoading() {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(id);
  }, []);
  return shown ? (
    <span role="status" className={css.note}>
      {t('receipt.loading')}
    </span>
  ) : null;
}

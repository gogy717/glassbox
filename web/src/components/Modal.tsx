import { X } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { trapTab } from './focusTrap';
import css from './Modal.module.css';

interface Props {
  label: string;
  onClose(): void;
  /** Extra controls in the header, left of the close button. */
  actions?: ReactNode;
  /** Where focus goes on close. Safari does not focus buttons on click, so the opener says so. */
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** 'large' for inspecting data (default), 'compact' for short forms. */
  size?: 'large' | 'compact';
  children: ReactNode;
}

/** A large inspection dialog. Focus starts on Close and returns to the opener when it closes. */
export function Modal({ label, onClose, actions, returnFocusTo, size = 'large', children }: Props) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnRef = useRef(returnFocusTo);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => (returnRef.current?.current ?? opener)?.focus?.();
  }, []);

  return createPortal(
    <div className={css.overlay} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={css.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-size={size}
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
          trapTab(e, dialogRef.current);
        }}
      >
        <div className={css.head}>
          <span className={css.title}>{label}</span>
          {actions}
          <button
            ref={closeRef}
            type="button"
            className={css.close}
            aria-label={t('json.close')}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className={css.body}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

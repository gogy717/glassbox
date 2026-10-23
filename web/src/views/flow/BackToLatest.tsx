import { ArrowDown } from 'lucide-react';
import { useI18n } from '../../i18n';
import css from './BackToLatest.module.css';

/**
 * Resumes follow mode: a link-like button at the end of the follow-paused bar, never floating
 * over the calls.
 */
export function BackToLatest({ onClick }: { onClick(): void }) {
  const { t } = useI18n();
  return (
    <button type="button" className={css.back} onClick={onClick}>
      {t('follow.back')}
      <ArrowDown size={13} aria-hidden="true" />
    </button>
  );
}

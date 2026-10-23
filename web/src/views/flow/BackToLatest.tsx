import { ArrowDown } from 'lucide-react';
import { useI18n } from '../../i18n';
import css from './BackToLatest.module.css';

/**
 * Resumes follow mode. It sits in the open turn's header (execution chain, steps) rather than
 * floating over the calls, so it never covers what is being read.
 */
export function BackToLatest({ onClick }: { onClick(): void }) {
  const { t } = useI18n();
  return (
    <button type="button" className={css.back} onClick={onClick}>
      <ArrowDown size={13} aria-hidden="true" />
      {t('follow.back')}
    </button>
  );
}

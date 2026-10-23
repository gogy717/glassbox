import { Eye } from 'lucide-react';
import { useI18n } from '../../i18n';
import css from './BackToLatest.module.css';

/**
 * Resumes follow mode. It sits in the open turn's header (execution chain, steps) rather than
 * floating over the calls, so it never covers what is being read. The eye is the top bar's
 * follow icon: no arrow, as the latest turn is on top of the list and the latest call below.
 */
export function BackToLatest({ onClick }: { onClick(): void }) {
  const { t } = useI18n();
  return (
    <button type="button" className={css.back} onClick={onClick}>
      <Eye size={13} aria-hidden="true" />
      {t('follow.back')}
    </button>
  );
}

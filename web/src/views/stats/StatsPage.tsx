import type { WeekWindowKind } from '../../../../src/shared/week.js';
import { Switch } from '../../components/Switch';
import { useI18n } from '../../i18n';
import css from './StatsPage.module.css';

interface Props {
  /** The window in the route: this week, or the last 7 days. */
  window: WeekWindowKind;
  /** Another window picked: the route changes in place, so Back leaves the page. */
  onWindow(window: WeekWindowKind): void;
}

/**
 * The Stats page (D4): this machine's week, the weekly receipt's interactive sibling. Its head
 * holds the window switch; under it the overview strip, then the cards in thirds: when the agents
 * worked (two) beside the hour (one), by CLI, top projects and longest sessions, tokens (two)
 * beside right now (one). Laid out like Home, beside the session list, with no composer.
 */
export function StatsPage({ window: kind, onWindow }: Props) {
  const { t } = useI18n();
  return (
    <div className={css.stats}>
      <h1 className="visually-hidden">{t('nav.stats')}</h1>
      <div className={css.head}>
        <Switch
          variant="segmented"
          label={t('stats.window')}
          value={kind}
          onChange={onWindow}
          options={[
            { value: 'week', label: t('stats.thisWeek') },
            { value: '7d', label: t('stats.last7') },
          ]}
        />
      </div>
      <div className={css.cards} aria-hidden="true">
        <div className={css.card} data-span="all" data-region="overview" />
        <div className={css.card} data-span="2" data-region="grid" />
        <div className={css.card} data-region="hour" />
        <div className={css.card} data-region="clis" />
        <div className={css.card} data-region="projects" />
        <div className={css.card} data-region="longest" />
        <div className={css.card} data-span="2" data-region="tokens" />
        <div className={css.card} data-region="now" />
      </div>
    </div>
  );
}

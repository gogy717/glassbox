import { ChevronDown } from 'lucide-react';
import type { RunPermissionMode } from '../../../../src/shared/runs.js';
import { useI18n } from '../../i18n';
import css from './Composer.module.css';

/** "Permissions · Default (ask each time) ▾": a ghost button over a native select. */
export function PermissionModeSelect({
  value,
  onChange,
}: {
  value: RunPermissionMode;
  onChange(v: RunPermissionMode): void;
}) {
  const { t } = useI18n();
  return (
    <label className={css.select}>
      <span className={css.selectLabel} aria-hidden="true">
        {t('composer.permMode')} ·
      </span>
      <select
        aria-label={t('composer.permMode')}
        value={value}
        onChange={(e) => onChange(e.target.value as RunPermissionMode)}
      >
        <option value="default">{t('composer.permDefault')}</option>
        <option value="acceptEdits">{t('composer.permAcceptEdits')}</option>
        <option value="plan">{t('composer.permPlan')}</option>
      </select>
      <ChevronDown size={12} aria-hidden="true" />
    </label>
  );
}

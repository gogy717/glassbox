import { useI18n } from '../../../i18n';
import { type DetailPrefs, useDetailPrefs } from './prefs';
import { Segmented } from './text';

/** Readable / JSON: one choice for every detail panel, remembered per viewer. */
export function ViewToggle() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useDetailPrefs();
  return (
    <Segmented<DetailPrefs['view']>
      label={t('detail.view')}
      value={prefs.view}
      options={[
        { value: 'readable', label: t('detail.viewReadable') },
        { value: 'json', label: t('detail.viewJson') },
      ]}
      onChange={(view) => setPrefs({ view })}
    />
  );
}

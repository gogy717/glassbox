import { Switch } from '../../../components/Switch';
import { useI18n } from '../../../i18n';
import { type DetailPrefs, useDetailPrefs } from './prefs';

/** Readable / JSON: one choice for every detail panel, remembered per viewer. */
export function ViewToggle() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useDetailPrefs();
  return (
    <Switch<DetailPrefs['view']>
      size="small"
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

/** Rendered / Source for model replies' markdown: one choice everywhere, remembered. */
export function MarkdownToggle() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useDetailPrefs();
  return (
    <Switch<DetailPrefs['markdown']>
      size="small"
      label={t('detail.markdown')}
      value={prefs.markdown}
      options={[
        { value: 'rendered', label: t('detail.mdRendered') },
        { value: 'source', label: t('detail.mdSource') },
      ]}
      onChange={(markdown) => setPrefs({ markdown })}
    />
  );
}

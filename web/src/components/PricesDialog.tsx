import { X } from 'lucide-react';
import { type RefObject, useState } from 'react';
import { type MessageKey, useI18n } from '../i18n';
import { DEFAULT_PRICES, PRICE_KINDS, PRICES_AS_OF, type Price, priceTable } from '../lib/prices';
import { Modal } from './Modal';
import css from './PricesDialog.module.css';

const KIND_LABEL: Record<(typeof PRICE_KINDS)[number], MessageKey> = {
  input: 'prices.input',
  cacheWrite: 'prices.cacheWrite',
  cacheWrite1h: 'prices.cacheWrite1h',
  cacheRead: 'prices.cacheRead',
  output: 'prices.output',
};

const FREE: Price = { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };

interface Props {
  /** The person's own prices, by model id (`Prefs.prices`). */
  prices: Record<string, Price>;
  onPrices(prices: Record<string, Price>): void;
  onClose(): void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}

/**
 * "API prices (estimate)" (proposal 6): the table every cost is worked out from, a row per model,
 * its prices as inputs. A price is kept as soon as it reads as a number of zero or more; a model
 * is added with no price at all (zeros) for the person to fill in, and reset or removed again.
 */
export function PricesDialog({ prices, onPrices, onClose, returnFocusTo }: Props) {
  const { t, intl } = useI18n();
  // Inputs keep what is typed; a reset draws them again from the table.
  const [drawn, setDrawn] = useState(0);
  const [adding, setAdding] = useState('');
  const table = priceTable(prices);
  const edited = Object.keys(prices).length > 0;
  const models = [
    ...Object.keys(DEFAULT_PRICES),
    ...Object.keys(prices).filter((m) => !(m in DEFAULT_PRICES)),
  ];
  const asOf = new Intl.DateTimeFormat(intl, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    Date.parse(`${PRICES_AS_OF}T00:00:00Z`),
  );

  const change = (model: string, kind: (typeof PRICE_KINDS)[number], text: string) => {
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value) || value < 0) return;
    const { asOf: _, ...row } = table[model] ?? { ...FREE, asOf: null };
    onPrices({ ...prices, [model]: { ...row, [kind]: value } });
  };
  const add = () => {
    const model = adding.trim();
    setAdding('');
    if (model && !(model in table)) onPrices({ ...prices, [model]: FREE });
  };
  const remove = (model: string) => {
    const { [model]: _, ...rest } = prices;
    onPrices(rest);
  };

  return (
    <Modal
      label={t('settings.prices')}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      size="compact"
    >
      <div className={css.body}>
        <p className={css.intro}>{t('prices.intro')}</p>
        <div className={css.scroll}>
          <table className={css.table} key={drawn}>
            <thead>
              <tr>
                <th scope="col">{t('prices.model')}</th>
                {PRICE_KINDS.map((k) => (
                  <th key={k} scope="col">
                    {t(KIND_LABEL[k])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const added = !(model in DEFAULT_PRICES);
                return (
                  <tr key={model}>
                    <th scope="row" className={css.model}>
                      <span className={css.id}>{model}</span>
                      {!added && model in prices && (
                        <span className={css.edited}>{t('prices.edited')}</span>
                      )}
                      {added && (
                        <button
                          type="button"
                          className={css.remove}
                          aria-label={t('prices.remove', { model })}
                          title={t('prices.remove', { model })}
                          onClick={() => remove(model)}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      )}
                    </th>
                    {PRICE_KINDS.map((k) => (
                      <td key={k}>
                        <input
                          type="number"
                          className={`${css.price} figure`}
                          min={0}
                          step="any"
                          inputMode="decimal"
                          defaultValue={table[model]?.[k] ?? 0}
                          aria-label={t('prices.cell', { model, kind: t(KIND_LABEL[k]) })}
                          onChange={(e) => change(model, k, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <form
          className={css.add}
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            type="text"
            className={css.addInput}
            value={adding}
            aria-label={t('prices.add')}
            placeholder={t('prices.addHint')}
            onChange={(e) => setAdding(e.target.value)}
          />
          <button type="submit" className={css.button}>
            {t('prices.addButton')}
          </button>
        </form>
        <p className={css.note}>{t('prices.asOf', { date: asOf })}</p>
        <div className={css.foot}>
          {/* Unavailable, not disabled: a disabled button would drop focus out of the dialog. */}
          <button
            type="button"
            className={css.button}
            aria-disabled={edited ? undefined : 'true'}
            onClick={() => {
              if (!edited) return;
              onPrices({});
              setDrawn((n) => n + 1);
            }}
          >
            {t('prices.reset')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

import { createContext, useContext } from 'react';
import { en } from './en';
import { type MessageKey, zh } from './zh';

export type Locale = 'zh' | 'en';
export type { MessageKey };
export type Params = Record<string, string | number>;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { zh, en };

/**
 * Fills `{name}` from params. `{name|one|other}` picks a noun for the count in `name`: "1 tool",
 * "2 tools". Only a plain number counts ("1,024"); "1.2K" and the like read as plural.
 */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const text = dictionaries[locale][key];
  if (!params) return text;
  return text.replace(
    /\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g,
    (m, name: string, one?: string, other?: string) => {
      if (!(name in params)) return m;
      const value = String(params[name]);
      if (one === undefined || other === undefined) return value;
      const n = /^[\d,]+(\.\d+)?$/.test(value) ? Number(value.replace(/,/g, '')) : Number.NaN;
      return new Intl.PluralRules(locale).select(n) === 'one' ? one : other;
    },
  );
}

export type T = (key: MessageKey, params?: Params) => string;

export interface I18n {
  locale: Locale;
  /** BCP-47 tag for Intl number/date formatting. */
  intl: string;
  t: T;
}

export function makeI18n(locale: Locale): I18n {
  return {
    locale,
    intl: locale === 'zh' ? 'zh-CN' : 'en',
    t: (key, params) => translate(locale, key, params),
  };
}

export const I18nContext = createContext<I18n>(makeI18n('en'));

export const useI18n = () => useContext(I18nContext);

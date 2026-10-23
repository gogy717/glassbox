import { createContext, useContext } from 'react';
import { en } from './en';
import { type MessageKey, zh } from './zh';

export type Locale = 'zh' | 'en';
export type { MessageKey };
export type Params = Record<string, string | number>;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { zh, en };

/** `{name}`, or `{name|one|other}`: a noun picked by the count in `name`. */
const PLACEHOLDER = /\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g;

/** The noun for a count: only a plain number counts ("1,024"); "1.2K" and the like read as plural. */
function plural(locale: Locale, value: string, one: string, other: string): string {
  const n = /^[\d,]+(\.\d+)?$/.test(value) ? Number(value.replace(/,/g, '')) : Number.NaN;
  return new Intl.PluralRules(locale).select(n) === 'one' ? one : other;
}

/**
 * Fills `{name}` from params. `{name|one|other}` picks a noun for the count in `name`: "1 tool",
 * "2 tools".
 */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const text = dictionaries[locale][key];
  if (!params) return text;
  return text.replace(PLACEHOLDER, (m, name: string, one?: string, other?: string) => {
    if (!(name in params)) return m;
    const value = String(params[name]);
    return one === undefined || other === undefined ? value : plural(locale, value, one, other);
  });
}

/** A param's value in a translated text, kept apart (see `translateParts`). */
export interface ParamPart {
  param: string;
  value: string;
}

/**
 * As `translate`, but the value of each param named in `apart` (all of them by default) comes
 * back as a part of its own, so the caller can set it apart: a figure in the mono face inside a
 * sentence in the UI face, say. Plurals still follow the real value.
 */
export function translateParts(
  locale: Locale,
  key: MessageKey,
  params: Params,
  apart: readonly string[] = Object.keys(params),
): (string | ParamPart)[] {
  const out: (string | ParamPart)[] = [];
  let text = '';
  let last = 0;
  const template = dictionaries[locale][key];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const [whole, name = '', one, other] = m;
    text += template.slice(last, m.index);
    last = m.index + whole.length;
    if (!(name in params)) text += whole;
    else if (one !== undefined && other !== undefined)
      text += plural(locale, String(params[name]), one, other);
    else if (apart.includes(name)) {
      if (text) out.push(text);
      text = '';
      out.push({ param: name, value: String(params[name]) });
    } else text += String(params[name]);
  }
  text += template.slice(last);
  if (text) out.push(text);
  return out;
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

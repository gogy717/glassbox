/**
 * What tokens would cost on the API: a price table in US dollars per million tokens, and the cost
 * of a request from its own usage and model. The person is on a subscription, so every figure
 * made from this is an estimate of the same tokens at API list prices, never what they paid.
 * A model without a price costs nothing and is said to have none: no number is ever guessed.
 */
import type { TokenUsage } from '../../../src/core/model.js';
import type { T } from '../i18n';

/** USD per million tokens. */
export interface Price {
  /** Uncached input. */
  input: number;
  /** Writes to the 5-minute cache, and writes whose duration the agent did not record. */
  cacheWrite: number;
  /** Writes to the 1-hour cache. */
  cacheWrite1h: number;
  /** Cache hits and refreshes. */
  cacheRead: number;
  output: number;
}

export interface PriceEntry extends Price {
  /** The day the price was read off the provider's price list; null for a price set in Settings. */
  asOf: string | null;
}

/** By model id. An entry prices that id and its dated snapshots ("claude-opus-4-5-20251101"). */
export type PriceTable = Readonly<Record<string, PriceEntry>>;

export const PRICE_KINDS = ['input', 'cacheWrite', 'cacheWrite1h', 'cacheRead', 'output'] as const;

/** When the prices below were read off https://platform.claude.com/docs/en/about-claude/pricing. */
export const PRICES_AS_OF = '2026-10-26';

const list = (
  input: number,
  cacheWrite: number,
  cacheWrite1h: number,
  cacheRead: number,
  output: number,
): PriceEntry => ({ input, cacheWrite, cacheWrite1h, cacheRead, output, asOf: PRICES_AS_OF });

/**
 * Anthropic's list prices for the models on its price list. Claude Haiku 5.5 has a second, higher
 * card for prompts over 100K tokens; this table keeps the first, so long Haiku 5.5 prompts are
 * under-priced. OpenAI, xAI and other models have no entry: their prices are not known here.
 */
export const DEFAULT_PRICES: PriceTable = {
  'claude-fable-5-1': list(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': list(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': list(10, 12.5, 20, 1, 50),
  'claude-mythos-5': list(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': list(4, 5, 8, 0.2, 20),
  'claude-opus-5': list(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-8': list(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-7': list(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': list(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': list(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-1': list(15, 18.75, 30, 1.5, 75),
  'claude-opus-4': list(15, 18.75, 30, 1.5, 75),
  'claude-sonnet-5-5': list(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': list(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': list(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': list(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4': list(3, 3.75, 6, 0.3, 15),
  'claude-haiku-5-5': list(0.1, 0.125, 0.2, 0.01, 0.5),
  'claude-haiku-4-5': list(1, 1.25, 2, 0.1, 5),
  'claude-3-5-haiku': list(0.8, 1, 1.6, 0.08, 4),
};

/** The table in force: the defaults, with the person's own prices (Settings) over them. */
export function priceTable(overrides: Readonly<Record<string, Price>> | undefined): PriceTable {
  const table: Record<string, PriceEntry> = { ...DEFAULT_PRICES };
  for (const [model, p] of Object.entries(overrides ?? {})) table[model] = { ...p, asOf: null };
  return table;
}

/**
 * A model id without what clouds and tools add to it: a provider path ("anthropic/…"), Bedrock's
 * region and vendor ("us.anthropic.…"), a context-size tag ("…[1m]").
 */
const bare = (model: string) =>
  model
    .trim()
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '')
    .replace(/\[[^\]]*\]$/, '');

/**
 * After an entry's id, what still names that model: a snapshot's date, "-latest", Vertex's
 * "@date", Bedrock's "-v1:0". Anything else is another model ("claude-opus-5" is not "-5-5").
 */
const SAME_MODEL = /^(?:-\d{8}|-latest|@|-v\d|:)/;

/** The entry pricing `model`: the longest id that names it. Null when none does. */
export function priceOf(model: string | null, table: PriceTable): PriceEntry | null {
  if (!model) return null;
  const id = bare(model);
  let best: { key: string; entry: PriceEntry } | null = null;
  for (const [key, entry] of Object.entries(table)) {
    const k = key.toLowerCase();
    const names = id === k || (id.startsWith(k) && SAME_MODEL.test(id.slice(k.length)));
    if (names && (!best || k.length > best.key.length)) best = { key: k, entry };
  }
  return best?.entry ?? null;
}

const usedAny = (u: TokenUsage) =>
  u.input + u.cacheRead + u.cacheWrite + u.cacheWrite5m + u.cacheWrite1h + u.output > 0;

/**
 * USD for one request: uncached × input + cache reads × read + cache writes × write (an hour's at
 * the 1-hour rate) + output × output, from its own usage and model. 0 without usage; null when
 * its model (or the lack of one) has no price.
 */
export function costOf(
  usage: TokenUsage | null,
  model: string | null,
  table: PriceTable,
): number | null {
  if (!usage) return 0;
  const p = priceOf(model, table);
  if (!p) return null;
  // Writes the agent did not split by duration are priced as the API's default, 5 minutes.
  const write5m = Math.max(0, usage.cacheWrite - usage.cacheWrite1h);
  return (
    (usage.input * p.input +
      usage.cacheRead * p.cacheRead +
      write5m * p.cacheWrite +
      usage.cacheWrite1h * p.cacheWrite1h +
      usage.output * p.output) /
    1_000_000
  );
}

/** Request costs added up. */
export interface Cost {
  /** USD, of the priced requests. */
  usd: number;
  /** Whether any request with tokens was priced; when none was there is no figure ("—"). */
  priced: boolean;
  /** Some tokens went unpriced (a model without a price, or no model): `usd` leaves them out. */
  partial: boolean;
  /** The models that used tokens and have no price, by id. */
  unpriced: string[];
}

/** The cost of requests, each from its own usage and model. */
export function sumCost(
  requests: Iterable<{ usage: TokenUsage | null; model: string | null }>,
  table: PriceTable,
): Cost {
  let usd = 0;
  let priced = false;
  let partial = false;
  const unpriced = new Set<string>();
  for (const r of requests) {
    if (!r.usage || !usedAny(r.usage)) continue;
    const c = costOf(r.usage, r.model, table);
    if (c === null) {
      partial = true;
      if (r.model) unpriced.add(r.model);
    } else {
      usd += c;
      priced = true;
    }
  }
  return { usd, priced, partial, unpriced: [...unpriced].sort() };
}

/** The cost of usage already added up by model (`WeekFigures.usageByModel`: '' for no model). */
export const costByModel = (byModel: Readonly<Record<string, TokenUsage>>, table: PriceTable) =>
  sumCost(
    Object.entries(byModel).map(([model, usage]) => ({ model: model || null, usage })),
    table,
  );

/**
 * A cost figure's tooltip: what it is, and what it leaves out ("Left out, no price:
 * gpt-5.5-codex"). The Stats page and the receipts word it in their own dictionaries.
 */
export function costTitle(cost: Cost, t: T): string {
  if (!cost.partial) return t('cost.title');
  const models = cost.unpriced.length > 0 ? cost.unpriced.join(', ') : t('cost.noModel');
  return `${t('cost.title')} · ${t('cost.leftOut', { models })}`;
}

/** A cost as a row says it: "≈$0.42"; "no price" when none of its tokens has one; null without tokens. */
export function costText(cost: Cost, t: T, locale: string): string | null {
  if (cost.priced) return `≈${formatUsdShort(cost.usd, locale)}`;
  return cost.partial ? t('cost.noPrice') : null;
}

const usd = (digits: number, locale: string) =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** "$412.30": dollars to the cent. */
export const formatUsd = (amount: number, locale: string) => usd(2, locale).format(amount);

/** For a row: "$0.83" under $10, "$12" and "$1,235" above, "<$0.01" for a fraction of a cent. */
export function formatUsdShort(amount: number, locale: string): string {
  if (amount > 0 && amount < 0.005) return `<${usd(2, locale).format(0.01)}`;
  return usd(amount < 9.995 ? 2 : 0, locale).format(amount);
}

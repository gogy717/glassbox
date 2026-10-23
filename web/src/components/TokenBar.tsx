import type { TokenUsage } from '../../../src/core/model.js';
import { totalTokens } from '../../../src/core/usage.js';
import { useI18n } from '../i18n';
import { formatNumber } from '../lib/format';
import css from './TokenBar.module.css';

const BUCKETS = ['cacheRead', 'cacheWrite', 'input', 'output', 'thinking'] as const;
type Bucket = (typeof BUCKETS)[number];

const LABEL_KEYS = {
  cacheRead: 'tokens.cacheRead',
  cacheWrite: 'tokens.cacheWrite',
  input: 'tokens.input',
  output: 'tokens.output',
  thinking: 'tokens.thinking',
} as const;

/** Bucket sizes for drawing: thinking is carved out of output so the bar still sums to total. */
function segments(u: TokenUsage): [Bucket, number][] {
  return [
    ['cacheRead', u.cacheRead],
    ['cacheWrite', u.cacheWrite],
    ['input', u.input],
    ['output', Math.max(0, u.output - u.thinking)],
    ['thinking', Math.min(u.thinking, u.output)],
  ];
}

/** Stacked horizontal bar: cache read · cache write · uncached input · output (thinking hatched). */
export function TokenBar({
  usage,
  scale,
  height = 10,
}: {
  usage: TokenUsage;
  scale?: number;
  height?: number;
}) {
  const { t, intl } = useI18n();
  const total = totalTokens(usage);
  const max = Math.max(scale ?? total, 1);
  const share = total / max;
  return (
    <span className={css.track} style={{ height }} aria-hidden="true">
      {/* Short bars drop the 2px separators, which would otherwise outweigh the data. */}
      <span
        className={css.bar}
        data-compact={share < 0.15 || undefined}
        style={{ width: `${share * 100}%` }}
      >
        {segments(usage).map(([bucket, n]) =>
          n > 0 ? (
            <span
              key={bucket}
              className={css.seg}
              data-bucket={bucket}
              style={{ flexGrow: n }}
              title={`${t(LABEL_KEYS[bucket])} ${formatNumber(n, intl)}`}
            />
          ) : null,
        )}
      </span>
    </span>
  );
}

/** Legend with values, so identity and amounts never rely on colour alone. */
export function TokenLegend({ usage }: { usage: TokenUsage }) {
  const { t, intl } = useI18n();
  const values: Record<Bucket, number> = {
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    input: usage.input,
    output: usage.output,
    thinking: usage.thinking,
  };
  return (
    <ul className={css.legend}>
      {BUCKETS.map((b) => (
        <li key={b} data-sub={b === 'thinking' || undefined}>
          <span className={css.swatch} data-bucket={b} aria-hidden="true" />
          <span className={css.legendLabel}>{t(LABEL_KEYS[b])}</span>
          <span className={`${css.legendValue} figure`}>{formatNumber(values[b], intl)}</span>
        </li>
      ))}
    </ul>
  );
}

import { Search } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import type { ModelRequest, RequestDetail, ToolCall } from '../../../../../src/core/model.js';
import {
  type BillUnavailable,
  type ContextPart,
  type PartKind,
  partTexts,
  type RequestBill,
  requestBill,
} from '../../../../../src/shared/context-bill.js';
import { CompactFigure, UiCjk } from '../../../components/CompactFigure';
import { FigureText } from '../../../components/FigureText';
import { useSessionAgent } from '../../../data/session-agent';
import { type MessageKey, useI18n } from '../../../i18n';
import { formatCompact, formatPercent } from '../../../lib/format';
import { summarizeInput } from '../../../lib/tool-category';
import css from './context.module.css';

/** Parts listed at first, and added each time "Show more" is pressed. */
const PAGE = 50;
/** Parts drawn on their own in the bar: the largest, down to this share. */
const SEGMENTS = 20;
const SEGMENT_SHARE = 0.02;

/**
 * Who put a part in the context, the bar's colour: the agent (its system prompt and tools), the
 * person, the model, the tools. Four, so they stay apart for every eye (tokens.test.ts).
 */
export type PartGroup = 'fixed' | 'user' | 'model' | 'results' | 'gap';
const GROUPS: readonly PartGroup[] = ['fixed', 'user', 'model', 'results', 'gap'];
export const GROUP: Record<PartKind, PartGroup> = {
  system: 'fixed',
  tool: 'fixed',
  other: 'fixed',
  user: 'user',
  reply: 'model',
  call: 'model',
  result: 'results',
  gap: 'gap',
};
const GROUP_KEYS: Record<PartGroup, MessageKey> = {
  fixed: 'context.group.fixed',
  user: 'context.group.user',
  model: 'context.group.model',
  results: 'context.group.results',
  gap: 'context.group.gap',
};
const KIND_KEYS: Record<PartKind, MessageKey> = {
  system: 'context.kind.system',
  tool: 'context.kind.tool',
  user: 'context.kind.user',
  reply: 'context.kind.reply',
  call: 'context.kind.call',
  result: 'context.kind.result',
  other: 'context.kind.other',
  gap: 'context.kind.gap',
};
/** The roles a message of another kind is named by. */
export const ROLE_KEYS: Record<string, MessageKey> = {
  system: 'detail.roleSystem',
  developer: 'detail.roleDeveloper',
  tool: 'detail.roleTool',
};

const UNAVAILABLE: Record<BillUnavailable, MessageKey> = {
  'not-recorded': 'context.unavailable.notRecorded',
  'no-messages': 'context.unavailable.noMessages',
  'no-results': 'context.unavailable.noResults',
  'not-reconstructed': 'context.unavailable.notReconstructed',
  empty: 'context.unavailable.empty',
  'no-usage': 'context.unavailable.noUsage',
};

interface Row {
  part: ContextPart;
  group: PartGroup;
  /** What it is: "Tool result", "System prompt". */
  word: string;
  /** Which one: the call, the tool, the message's opening words; '' when the word says it. */
  label: string;
  /** Commands, paths and tool names: set in the mono face. */
  mono: boolean;
  /** The call to open, when it is in the session. */
  call: ToolCall | undefined;
  share: number;
  /** Lower-case text a filter matches. */
  find: string;
}

export interface ContextViewProps {
  req: ModelRequest;
  detail: RequestDetail | null;
  /** The session's calls: a call or result names its call as the execution chain does. */
  calls?: ReadonlyMap<string, ToolCall>;
  /** Opens a call's card: a result links to the call it answers. */
  onOpenCall?(call: ToolCall): void;
  /** Told the bill shown, for the panel's Copy. */
  onBill?(bill: RequestBill): void;
}

/**
 * What the request's context was made of (`context-bill.ts`): a bar of its parts, the largest
 * first, coloured by who put each there, with its legend in words; then every part by size, its
 * estimated tokens and share, a filter over them, and a call's or a result's link to the call.
 * Every figure is an estimate and says so. Memoised as the readable view is.
 */
export const ContextView = memo(function ContextView({
  req,
  detail,
  calls,
  onOpenCall,
  onBill,
}: ContextViewProps) {
  const { t, intl } = useI18n();
  const agent = useSessionAgent();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const bill = useMemo(
    () => requestBill({ hasDetail: req.hasDetail, usage: req.usage }, detail),
    [req.hasDetail, req.usage, detail],
  );
  useEffect(() => onBill?.(bill), [bill, onBill]);
  const q = query.trim().toLowerCase();
  // What each part holds, lower-cased once a filter is typed: it matches text as well as names.
  const searching = q !== '';
  const texts = useMemo(() => {
    if (!searching || !detail) return null;
    const out = new Map<string, string>();
    for (const [key, text] of partTexts(detail)) out.set(key, text.toLowerCase());
    return out;
  }, [searching, detail]);

  const rows = useMemo((): Row[] => {
    if (bill.status !== 'ok') return [];
    const out = bill.parts.map((part): Row => {
      const call = part.callId ? calls?.get(part.callId) : undefined;
      const group = GROUP[part.kind];
      const role = part.role ?? '';
      const word =
        part.kind === 'other'
          ? t('context.kind.other', { role: ROLE_KEYS[role] ? t(ROLE_KEYS[role]) : role })
          : t(KIND_KEYS[part.kind]);
      let label = '';
      let mono = false;
      if (part.kind === 'tool') {
        label = part.tool ?? '';
        mono = true;
      } else if (part.kind === 'call' || part.kind === 'result') {
        const gist = call ? summarizeInput(call) : (part.target ?? '');
        label =
          [part.tool ?? call?.name ?? '', gist].filter(Boolean).join(' ') || (part.callId ?? '');
        mono = true;
      } else if (part.kind === 'gap') {
        const m = part.missing;
        label = [
          m && m.messages > 0 ? t('context.gapMessages', { n: m.messages }) : '',
          m?.system ? t('context.gapSystem') : '',
          m?.tools ? t('context.gapTools') : '',
        ]
          .filter(Boolean)
          .join(' · ');
      } else if (part.kind !== 'system') {
        label = part.text ?? (part.kind === 'reply' ? t('context.thinking') : '');
      }
      const find = [word, label, part.path ?? '', part.tool ?? ''].join('\n').toLowerCase();
      return { part, group, word, label, mono, call, share: part.tokens / bill.total, find };
    });
    // Largest first; parts of one size keep the order they were sent in.
    return out.sort((a, b) => b.part.tokens - a.part.tokens);
  }, [bill, calls, t]);

  if (bill.status !== 'ok')
    return <p className={css.message}>{t(UNAVAILABLE[bill.reason], { agent })}</p>;

  const matching = q
    ? rows.filter((r) => r.find.includes(q) || texts?.get(r.part.key)?.includes(q))
    : rows;
  const listed = matching.slice(0, shown);
  const approx = (n: number) => `≈${formatCompact(n, intl)}`;
  const gap = rows.some((r) => r.part.kind === 'gap' && r.part.tokens > 0);

  return (
    <div className={css.view}>
      <div className={css.head}>
        <p className={css.total}>
          <FigureText
            k="context.total"
            params={{ n: Math.round(bill.total).toLocaleString(intl) }}
          />
        </p>
        <label className={css.search}>
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t('context.filter')}
            aria-label={t('context.filter')}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
          />
        </label>
      </div>

      <Bar rows={rows} approx={approx} />
      <Legend rows={rows} approx={approx} />

      <div className={css.listHead}>
        <span className={css.count}>
          {q ? (
            <FigureText k="context.matches" params={{ n: matching.length, total: rows.length }} />
          ) : (
            <FigureText k="context.count" params={{ n: rows.length }} />
          )}
        </span>
        <span className={css.colTokens}>{t('context.colTokens')}</span>
        <span className={css.colShare}>{t('context.colShare')}</span>
      </div>
      {matching.length === 0 ? (
        <p className={css.noMatch}>{t('context.noMatch', { q: query.trim() })}</p>
      ) : (
        <ol className={css.list} aria-label={t('context.colPart')}>
          {listed.map((r) => (
            <PartRow key={r.part.key} row={r} approx={approx} onOpenCall={onOpenCall} />
          ))}
        </ol>
      )}
      {matching.length > listed.length && (
        <button type="button" className={css.more} onClick={() => setShown((s) => s + PAGE)}>
          {t('context.showMore', {
            n: Math.min(PAGE, matching.length - listed.length).toLocaleString(intl),
          })}
        </button>
      )}
      <p className={css.note}>
        {t(bill.measured ? 'context.measured' : 'context.unmeasured')}
        {gap && ` ${t('context.gapNote')}`}
      </p>
    </div>
  );
});

function PartRow({
  row: r,
  approx,
  onOpenCall,
}: {
  row: Row;
  approx(n: number): string;
  onOpenCall?(call: ToolCall): void;
}) {
  const { t, intl } = useI18n();
  const call = r.call;
  const text = r.mono ? <UiCjk text={r.label} /> : r.label;
  return (
    <li className={css.row}>
      <span className={css.swatch} data-group={r.group} aria-hidden="true" />
      <span className={css.what}>
        <span className={css.word}>{r.word}</span>
        {r.label &&
          (call && onOpenCall ? (
            <button
              type="button"
              className={`${css.label} ${css.link}`}
              data-mono={r.mono || undefined}
              title={t('context.openCall')}
              onClick={() => onOpenCall(call)}
            >
              {text}
            </button>
          ) : (
            <span className={css.label} data-mono={r.mono || undefined}>
              {text}
            </span>
          ))}
        {r.part.last && (
          <span className={css.added} title={t('context.addedTitle')}>
            {t('context.added')}
          </span>
        )}
      </span>
      <span className={css.tokens}>
        <CompactFigure value={approx(r.part.tokens)} />
      </span>
      <span className={`${css.share} figure`}>{formatPercent(r.share, intl)}</span>
    </li>
  );
}

/**
 * The parts as one bar, the largest first, each coloured by its group: the large ones on their
 * own, the many small ones gathered per group after them, so the colours still add up.
 */
function Bar({ rows, approx }: { rows: Row[]; approx(n: number): string }) {
  const { t, intl } = useI18n();
  const own = rows.filter((r, i) => i < SEGMENTS && r.share >= SEGMENT_SHARE);
  const rest = new Map<PartGroup, { tokens: number; n: number; share: number }>();
  for (const r of rows.slice(own.length)) {
    const g = rest.get(r.group) ?? { tokens: 0, n: 0, share: 0 };
    rest.set(r.group, { tokens: g.tokens + r.part.tokens, n: g.n + 1, share: g.share + r.share });
  }
  const pct = (share: number) => formatPercent(share, intl);
  return (
    <div className={css.bar} aria-hidden="true">
      {own.map((r) => (
        <span
          key={r.part.key}
          className={css.seg}
          data-group={r.group}
          style={{ flexGrow: r.part.tokens }}
          title={[r.word, r.label, approx(r.part.tokens), pct(r.share)].filter(Boolean).join(' · ')}
        />
      ))}
      {GROUPS.filter((g) => (rest.get(g)?.tokens ?? 0) > 0).map((g) => {
        const s = rest.get(g) as { tokens: number; n: number; share: number };
        return (
          <span
            key={`rest:${g}`}
            className={css.seg}
            data-group={g}
            data-rest
            style={{ flexGrow: s.tokens }}
            title={[
              t(GROUP_KEYS[g]),
              t('context.others', { n: s.n }),
              approx(s.tokens),
              pct(s.share),
            ].join(' · ')}
          />
        );
      })}
    </div>
  );
}

/** The groups in words, with their sums, so no part is told by colour alone. */
function Legend({ rows, approx }: { rows: Row[]; approx(n: number): string }) {
  const { t, intl } = useI18n();
  const sums = new Map<PartGroup, { tokens: number; share: number }>();
  for (const r of rows) {
    const s = sums.get(r.group) ?? { tokens: 0, share: 0 };
    sums.set(r.group, { tokens: s.tokens + r.part.tokens, share: s.share + r.share });
  }
  return (
    <ul className={css.legend} aria-label={t('context.legend')}>
      {GROUPS.filter((g) => sums.has(g)).map((g) => {
        const s = sums.get(g) as { tokens: number; share: number };
        return (
          <li key={g}>
            <span className={css.swatch} data-group={g} aria-hidden="true" />
            <span className={css.legendLabel}>{t(GROUP_KEYS[g])}</span>
            <span className={css.legendValue}>
              <CompactFigure value={approx(s.tokens)} />
            </span>
            <span className={`${css.legendShare} figure`}>{formatPercent(s.share, intl)}</span>
          </li>
        );
      })}
    </ul>
  );
}

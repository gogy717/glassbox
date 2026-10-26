import { memo, useMemo, useRef } from 'react';
import { FigureText } from '../../components/FigureText';
import { useRovingFocus } from '../../data/useRovingFocus';
import { type T, useI18n } from '../../i18n';
import { mcpTool } from '../../lib/tool-category';
import type { CardKey } from '../../router';
import css from './SearchResults.module.css';
import type { SearchGroup, SearchHit } from './search';
import type { TurnItem } from './TurnList';

interface Props {
  /** In the order of the prompts, as `searchSession` gives them. */
  groups: SearchGroup[];
  /** The list's items, for each group's label and title. */
  items: TurnItem[];
  selectedId: string | null;
  /** The card open in the open prompt: its hits are where the page is. */
  openCard: { requestId: string; card: CardKey } | null;
  onSelect(turnId: string): void;
  onHit(hit: SearchHit, turnId: string): void;
}

/** Hits drawn at most, the newest first: past this, typing more says more than scrolling. */
const MAX_HITS = 200;

/** What a hit is in, as its name says it: Prompt, Reply, the tool, or the tool's result. */
function kindWords(hit: SearchHit, t: T): string {
  if (hit.kind === 'tool') return hit.tool ?? '';
  if (hit.kind === 'result') return t('flow.hitResultOf', { tool: hit.tool ?? '' });
  return t(hit.kind === 'prompt' ? 'flow.hitPrompt' : 'flow.hitReply');
}

/**
 * What a hit is in, in a word: Prompt, Reply, the tool's name, or Result. The column cuts long
 * words; the tooltip has them whole, and a result's tool.
 */
function Kind({ hit }: { hit: SearchHit }) {
  const { t } = useI18n();
  const name = hit.tool ?? '';
  if (hit.kind === 'tool')
    // An MCP tool by its own name, its server in the tooltip.
    return (
      <span className={css.kind} data-kind="tool" title={name}>
        {mcpTool(name)?.tool ?? name}
      </span>
    );
  if (hit.kind === 'result')
    return (
      <span className={css.kind} data-kind="result" title={kindWords(hit, t)}>
        {t('flow.hitResult')}
      </span>
    );
  return (
    <span className={css.kind} data-kind={hit.kind}>
      {kindWords(hit, t)}
    </span>
  );
}

/**
 * A hit's match amid its context, kept in view on one line: what follows gives way at its end,
 * what comes before at its start. That part is aligned to its box's end, so it overflows to the
 * left, where the box cuts it. The search's own "…" (it cut there already) stands ahead of the
 * box, where the box cannot cut it.
 */
function Snippet({ hit }: { hit: SearchHit }) {
  const cut = hit.before.startsWith('…');
  return (
    <span className={css.snippet}>
      {cut && (
        <span className={css.cut} data-cut>
          …
        </span>
      )}
      <span className={css.before}>
        <span>{cut ? hit.before.slice(1) : hit.before}</span>
      </span>
      <mark className={css.match}>{hit.match}</mark>
      <span className={css.after}>{hit.after}</span>
    </span>
  );
}

/**
 * Everything the page holds that matches, newest prompt first like the list it replaces: each
 * prompt's head ("Prompt 12 · 3 hits", then its title), then a line a hit, its match marked in
 * the middle of what surrounds it. A head opens its prompt; a hit opens where it is. One tab
 * stop, as the list: the arrow keys move over the heads and the hits. The newest `MAX_HITS` are
 * drawn, each head keeping its whole count, and a line says how to narrow the rest. Heads and
 * hits are named in words of their own: a name made of their parts can lose the spaces at the
 * parts' edges ("flaky" and "login" heard as one word).
 */
export const SearchResults = memo(function SearchResults({
  groups,
  items,
  selectedId,
  openCard,
  onSelect,
  onHit,
}: Props) {
  const { t } = useI18n();
  const listRef = useRef<HTMLUListElement>(null);
  const byId = useMemo(() => new Map(items.map((it) => [it.turn.id, it])), [items]);
  // Newest first, up to `MAX_HITS` lines: a group may show only its first hits.
  const { shown, total } = useMemo(() => {
    let room = MAX_HITS;
    let total = 0;
    const shown: { g: SearchGroup; hits: SearchHit[] }[] = [];
    for (const g of [...groups].reverse()) {
      total += g.hits.length;
      if (room > 0) shown.push({ g, hits: g.hits.slice(0, room) });
      room -= g.hits.length;
    }
    return { shown, total };
  }, [groups]);
  const ids = useMemo(
    () => shown.flatMap(({ g, hits }) => [g.turn.id, ...hits.map((_, i) => `${g.turn.id}#${i}`)]),
    [shown],
  );
  const roving = useRovingFocus(listRef, ids, selectedId);

  return (
    <>
      <ul ref={listRef} className={css.results} aria-label={t('flow.searchResults')}>
        {shown.map(({ g, hits }) => {
          const item = byId.get(g.turn.id);
          const selected = g.turn.id === selectedId;
          const group = { label: item?.label ?? '', n: g.hits.length };
          const title = item && item.title !== item.label ? item.title : null;
          const name = t('flow.hitGroup', group);
          return (
            <li key={g.turn.id} data-turn={g.turn.id}>
              <button
                type="button"
                className={css.head}
                data-group
                {...roving(g.turn.id)}
                aria-current={selected ? 'true' : undefined}
                aria-label={title ? `${name}: ${title}` : name}
                title={g.turn.prompt || undefined}
                onClick={() => onSelect(g.turn.id)}
              >
                <span className={css.label}>
                  <FigureText k="flow.hitGroup" params={group} figures={['n']} />
                </span>
                {title && <span className={css.title}>{title}</span>}
              </button>
              <ul className={css.hits}>
                {hits.map((h, i) => (
                  <li key={`${h.kind}:${h.requestId}:${h.card}`}>
                    <button
                      type="button"
                      className={css.hit}
                      {...roving(`${g.turn.id}#${i}`)}
                      aria-current={
                        selected &&
                        openCard !== null &&
                        h.requestId === openCard.requestId &&
                        h.card === openCard.card
                          ? 'true'
                          : undefined
                      }
                      aria-label={`${kindWords(h, t)}: ${h.before}${h.match}${h.after}`}
                      onClick={() => onHit(h, g.turn.id)}
                    >
                      <Kind hit={h} />
                      <Snippet hit={h} />
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      {total > MAX_HITS && (
        <p className={css.capped}>
          <FigureText k="flow.hitsCapped" params={{ shown: MAX_HITS, total }} />
        </p>
      )}
    </>
  );
});

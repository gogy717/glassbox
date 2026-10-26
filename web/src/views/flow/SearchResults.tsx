import { memo, useMemo, useRef } from 'react';
import { FigureText } from '../../components/FigureText';
import { useRovingFocus } from '../../data/useRovingFocus';
import { useI18n } from '../../i18n';
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

/** What a hit is in, in a word: Prompt, Reply, the tool's name, or Result. */
function Kind({ hit }: { hit: SearchHit }) {
  const { t } = useI18n();
  const name = hit.tool ?? '';
  if (hit.kind === 'tool') {
    // An MCP tool by its own name; the server is in the tooltip.
    const mcp = mcpTool(name);
    return (
      <span className={css.kind} data-kind="tool" title={mcp ? name : undefined}>
        {mcp?.tool ?? name}
      </span>
    );
  }
  if (hit.kind === 'result')
    return (
      <span className={css.kind} data-kind="result" title={t('flow.hitResultOf', { tool: name })}>
        {t('flow.hitResult')}
      </span>
    );
  return (
    <span className={css.kind} data-kind={hit.kind}>
      {t(hit.kind === 'prompt' ? 'flow.hitPrompt' : 'flow.hitReply')}
    </span>
  );
}

/**
 * Everything the page holds that matches, newest prompt first like the list it replaces: each
 * prompt's head ("Prompt 12 · 3 hits", then its title), then a line a hit, its match marked in
 * the middle of what surrounds it. A head opens its prompt; a hit opens where it is. One tab
 * stop, as the list: the arrow keys move over the heads and the hits.
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
  const newestFirst = useMemo(() => [...groups].reverse(), [groups]);
  const ids = useMemo(
    () => newestFirst.flatMap((g) => [g.turn.id, ...g.hits.map((_, i) => `${g.turn.id}#${i}`)]),
    [newestFirst],
  );
  const roving = useRovingFocus(listRef, ids, selectedId);

  return (
    <ul ref={listRef} className={css.results} aria-label={t('flow.searchResults')}>
      {newestFirst.map((g) => {
        const item = byId.get(g.turn.id);
        const selected = g.turn.id === selectedId;
        return (
          <li key={g.turn.id} data-turn={g.turn.id}>
            <button
              type="button"
              className={css.head}
              data-group
              {...roving(g.turn.id)}
              aria-current={selected ? 'true' : undefined}
              title={g.turn.prompt || undefined}
              onClick={() => onSelect(g.turn.id)}
            >
              <span className={css.label}>
                <FigureText
                  k="flow.hitGroup"
                  params={{ label: item?.label ?? '', n: g.hits.length }}
                  figures={['n']}
                />
              </span>
              {item && item.title !== item.label && (
                <span className={css.title}>
                  <span className="visually-hidden">: </span>
                  {item.title}
                </span>
              )}
            </button>
            <ul className={css.hits}>
              {g.hits.map((h, i) => (
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
                    onClick={() => onHit(h, g.turn.id)}
                  >
                    <Kind hit={h} />
                    <span className="visually-hidden">: </span>
                    {/* The match stays in view: what comes before it gives way at its start,
                        what follows at its end. */}
                    <span className={css.snippet}>
                      <span className={css.before}>
                        <bdi>{h.before}</bdi>
                      </span>
                      <mark className={css.match}>{h.match}</mark>
                      <span className={css.after}>{h.after}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
});

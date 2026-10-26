import { Search } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Turn } from '../../../../src/core/model.js';
import { FigureText } from '../../components/FigureText';
import { StatusMark, type UiStatus } from '../../components/Status';
import { useApprovalsContext } from '../../data/approvals';
import { usePriceTable } from '../../data/price-table';
import { useSessionAgentKind } from '../../data/session-agent';
import type { OpenSession } from '../../data/store';
import { useNow } from '../../data/useNow';
import { useRovingFocus } from '../../data/useRovingFocus';
import { useI18n } from '../../i18n';
import { formatClock, formatDay, localDayIndex } from '../../lib/format';
import { type Cost, costTitle, formatUsdShort, sumCost } from '../../lib/prices';
import type { Route } from '../../router';
import {
  callStatus,
  isLocalCommand,
  isOutsideTurn,
  requestsOf,
  toolsOf,
  truncatePrompt,
  turnStatus,
  turnsOf,
} from './flow-model';
import css from './TurnList.module.css';

export interface TurnItem {
  turn: Turn;
  /** What it is called: "Prompt 2", or "Calls outside prompts". */
  label: string;
  /** For the turn list: one line, the prompt shortened, without the label. */
  title: string;
  /** For the open turn's heading: the whole prompt, line breaks kept, without the label. */
  prompt: string;
  calls: number;
  tools: number;
  status: UiStatus;
  /** A local slash command (no model call): listed compactly. */
  command: boolean;
  /** What its calls would cost on the API, an estimate from the price table. */
  cost: Cost;
}

/** The agent's turns with display titles, counts and statuses (shared by the flow and steps tabs). */
export function useTurnItems(open: OpenSession, agentId: string): TurnItem[] {
  const { t } = useI18n();
  const approvals = useApprovalsContext();
  const agent = useSessionAgentKind();
  const prices = usePriceTable();
  return useMemo(
    () =>
      turnsOf(open, agentId).map((turn) => {
        const reqs = requestsOf(open, turn);
        let tools = 0;
        const statuses = reqs.map((r) => {
          const ts = toolsOf(open, r);
          tools += ts.length;
          return callStatus(r, ts, approvals);
        });
        const label = turnLabel(turn, t);
        const prompt = turnPrompt(turn, t);
        const status = turnStatus(turn, statuses);
        return {
          turn,
          label,
          title: prompt ? truncatePrompt(prompt) : label,
          prompt: prompt || label,
          calls: reqs.length,
          tools,
          status,
          command: isLocalCommand(turn, reqs.length, status, agent),
          cost: sumCost(reqs, prices),
        };
      }),
    [open, agentId, t, approvals, agent, prices],
  );
}

type Translate = ReturnType<typeof useI18n>['t'];

/** What a turn is called: its number, unless it is the bucket of calls outside any turn. */
function turnLabel(turn: Turn, t: Translate): string {
  if (isOutsideTurn(turn)) return t('flow.outsideTurns');
  return t('flow.turnLabel', { n: turn.index });
}

/** What a turn asked, in a sentence of its own; empty when it asked nothing that can be shown. */
function turnPrompt(turn: Turn, t: Translate): string {
  if (isOutsideTurn(turn)) return '';
  if (turn.origin === 'task-notification') return t('flow.taskNotification');
  // Claude Code's own "usage limit has reset, continue" message: said as what it is (W6a).
  if (turn.origin === 'auto-continuation') return t('flow.autoContinuation');
  return turn.prompt.trim();
}

/**
 * Follow mode shows the newest turn; otherwise the turn in the URL, the linked request's, or the
 * turn that was on screen when follow paused (`stickyId`).
 */
export function selectTurn(
  items: TurnItem[],
  open: OpenSession,
  agentId: string,
  route: Route,
  follow: boolean,
  stickyId: string | null = null,
  latest: TurnItem | undefined = items.at(-1),
): TurnItem | undefined {
  const linked = route.requestId ? open.requests.get(route.requestId) : undefined;
  const pinnedId = follow ? null : (route.turnId ?? linked?.turnId ?? stickyId);
  return items.find((it) => it.turn.id === pinnedId && it.turn.agentId === agentId) ?? latest;
}

/**
 * `selectTurn` plus memory: when follow pauses (scrolling up, opening a card) the turn on screen
 * stays put even if a newer turn arrives, so the reader keeps their place. `latest` is the turn
 * follow shows: the newest, or the newest that passes the list's filter.
 */
export function useSelectedTurn(
  items: TurnItem[],
  open: OpenSession,
  agentId: string,
  route: Route,
  follow: boolean,
  latest: TurnItem | undefined = items.at(-1),
): TurnItem | undefined {
  const [sticky, setSticky] = useState<{ agentId: string; turnId: string } | null>(null);
  const stickyId = sticky?.agentId === agentId ? sticky.turnId : null;
  const current = selectTurn(items, open, agentId, route, follow, stickyId, latest);
  const currentId = current?.turn.id ?? null;
  useEffect(() => {
    if (follow || !currentId) setSticky(null);
    else setSticky((s) => (s && s.agentId === agentId ? s : { agentId, turnId: currentId }));
  }, [follow, currentId, agentId]);
  return current;
}

/** Space kept between a revealed card and the list's edge (the list's own padding). */
const EDGE_PX = 10;

/** Scrolls `list` itself, never an ancestor, just enough to show `el`, on either axis. */
function reveal(list: HTMLElement, el: HTMLElement): void {
  const l = list.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < l.top) list.scrollTop -= l.top - r.top + EDGE_PX;
  else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom + EDGE_PX;
  if (r.left < l.left) list.scrollLeft -= l.left - r.left + EDGE_PX;
  else if (r.right > l.right) list.scrollLeft += r.right - l.right + EDGE_PX;
}

/** Each item's lowercased label and prompt, made once: items are memoised, typing is not. */
const haystacks = new WeakMap<TurnItem, string>();

function matcher(query: string): ((it: TurnItem) => boolean) | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return (it) => {
    let h = haystacks.get(it);
    if (h === undefined) {
      h = `${it.label} ${it.prompt}`.toLowerCase();
      haystacks.set(it, h);
    }
    return h.includes(q);
  };
}

/**
 * The turns whose heading matches `query` (case-insensitive): the label and the prompt the row
 * shows, never tool output. All of them for an empty query.
 */
export function filterTurns(items: TurnItem[], query: string): TurnItem[] {
  const matches = matcher(query);
  return matches ? items.filter(matches) : items;
}

/** The newest turn that passes `query`: the newest of all for an empty one. */
export function newestMatch(items: TurnItem[], query: string): TurnItem | undefined {
  const matches = matcher(query);
  return matches ? items.findLast(matches) : items.at(-1);
}

interface Props {
  /** Chronological, as `useTurnItems` returns them. */
  items: TurnItem[];
  selectedId: string | null;
  onSelect(turnId: string): void;
  /** With `onQuery`, a filter field above the list (`filterTurns`). */
  query?: string;
  onQuery?(query: string): void;
}

/** A line of the list: a day's heading, a turn (`folded` under a run of commands), or that run. */
type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'turn'; item: TurnItem; folded: boolean }
  | { kind: 'fold'; key: string; items: TurnItem[]; expanded: boolean };

/**
 * The rows of `newestFirst`: a heading where the day changes, once the list spans more than one
 * day; and two or more local commands in a row folded under one line ("3 commands") until it is
 * opened. A fold holding the selected turn is open. A turn whose start is unknown heads no day.
 */
function listRows(
  newestFirst: TurnItem[],
  selectedId: string | null,
  opened: ReadonlyMap<string, boolean>,
  dayOf: (it: TurnItem) => number,
  labelOf: (it: TurnItem) => string,
): Row[] {
  const days = new Set(newestFirst.map(dayOf).filter((d) => Number.isFinite(d)));
  const rows: Row[] = [];
  let day = Number.NaN;
  for (let i = 0; i < newestFirst.length; ) {
    const it = newestFirst[i] as TurnItem;
    const d = dayOf(it);
    if (days.size > 1 && Number.isFinite(d) && d !== day) {
      day = d;
      rows.push({ kind: 'day', key: `day:${d}`, label: labelOf(it) });
    }
    if (!it.command) {
      rows.push({ kind: 'turn', item: it, folded: false });
      i++;
      continue;
    }
    // The run of commands on this day, newest first.
    const run = [it];
    for (let j = i + 1; j < newestFirst.length; j++) {
      const next = newestFirst[j] as TurnItem;
      if (!next.command || dayOf(next) !== d) break;
      run.push(next);
    }
    if (run.length === 1) rows.push({ kind: 'turn', item: it, folded: false });
    else {
      // Keyed by its oldest command, so the fold keeps its state as newer ones join it.
      const key = `fold:${(run.at(-1) as TurnItem).turn.id}`;
      const expanded = opened.get(key) ?? run.some((r) => r.turn.id === selectedId);
      rows.push({ kind: 'fold', key, items: run, expanded });
      if (expanded) for (const r of run) rows.push({ kind: 'turn', item: r, folded: true });
    }
    i += run.length;
  }
  return rows;
}

/**
 * The agent's turns, newest first: the turn being followed, or the one that just arrived, is on
 * top (on the left in the narrow, horizontal layout). Numbers stay chronological, and the DOM is
 * in display order so keyboard order matches what is seen.
 */
export const TurnList = memo(function TurnList({
  items,
  selectedId,
  onSelect,
  query = '',
  onQuery,
}: Props) {
  const { t, intl } = useI18n();
  const listRef = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => filterTurns(items, query), [items, query]);
  const newestFirst = useMemo(() => [...shown].reverse(), [shown]);
  // The day headings ("Today", "Yesterday") move at midnight: the clock is read each minute.
  const now = useNow(60_000);
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const rows = useMemo(() => {
    const today = localDayIndex(now);
    const dayOf = (it: TurnItem) => localDayIndex(Date.parse(it.turn.startedAt));
    const labelOf = (it: TurnItem) => {
      const day = dayOf(it);
      if (day === today) return t('day.today');
      if (day === today - 1) return t('day.yesterday');
      return formatDay(Date.parse(it.turn.startedAt), now, intl);
    };
    return listRows(newestFirst, selectedId, opened, dayOf, labelOf);
  }, [newestFirst, selectedId, opened, now, t, intl]);
  // One tab stop for the whole list; the arrow keys move between turns (and folds), not headings.
  const ids = useMemo(
    () =>
      rows.flatMap((r) =>
        r.kind === 'turn' ? [r.item.turn.id] : r.kind === 'fold' ? [r.key] : [],
      ),
    [rows],
  );
  const roving = useRovingFocus(listRef, ids, selectedId);

  // Follow moves the selection to each new turn and a link may select an old one: keep it in view.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !selectedId) return;
    for (const li of list.children)
      if (li instanceof HTMLElement && li.dataset.turn === selectedId) reveal(list, li);
  }, [selectedId]);

  return (
    <nav className={css.pane} aria-label={t('flow.turns')}>
      <div className={css.head}>
        {t('flow.turns')}
        <span>
          {shown.length === items.length ? (
            <span className="figure">{items.length}</span>
          ) : (
            <FigureText k="flow.turnsShown" params={{ n: shown.length, total: items.length }} />
          )}
        </span>
      </div>
      {onQuery && (
        <label className={css.filter}>
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t('flow.filterTurns')}
            aria-label={t('flow.filterTurns')}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                onQuery('');
              }
            }}
          />
        </label>
      )}
      {newestFirst.length === 0 && items.length > 0 && (
        <p className={css.none}>{t('flow.noTurnMatch')}</p>
      )}
      <ul
        ref={listRef}
        className={css.list}
        aria-label={t('flow.turns')}
        hidden={newestFirst.length === 0 && items.length > 0}
      >
        {rows.map((row) => {
          if (row.kind === 'day')
            return (
              <li key={row.key} className={css.day}>
                <span className="section-label">{row.label}</span>
              </li>
            );
          if (row.kind === 'fold') {
            const commands = row.items.map((it) => it.turn.prompt.trim());
            return (
              <li key={row.key} data-fold={row.key}>
                {/* One line for the run: the commands, their count, the newest one's clock. Open,
                    the line keeps its count and the commands follow it, each a row of its own. */}
                <button
                  type="button"
                  className={css.row}
                  {...roving(row.key)}
                  data-command
                  aria-expanded={row.expanded}
                  title={commands.join('\n')}
                  onClick={() => setOpened((m) => new Map(m).set(row.key, !row.expanded))}
                >
                  <span className={`${css.num} figure`} aria-hidden="true" />
                  <span className={css.title} data-title>
                    {row.expanded ? '' : commands.join(' · ')}
                  </span>
                  <span className={css.command}>
                    <FigureText k="flow.commands" params={{ n: row.items.length }} />
                  </span>
                  <span className={`${css.clock} figure`}>
                    {formatClock((row.items[0] as TurnItem).turn.startedAt)}
                  </span>
                </button>
              </li>
            );
          }
          const it = row.item;
          const clock = formatClock(it.turn.startedAt);
          // Dense list: complete and failed are their glyph alone; the dot states keep their
          // word, as a dot would differ by colour only.
          const mark = <StatusMark status={it.status} compact />;
          return (
            <li key={it.turn.id} data-turn={it.turn.id}>
              <button
                type="button"
                className={css.row}
                {...roving(it.turn.id)}
                aria-current={it.turn.id === selectedId ? 'true' : undefined}
                data-command={it.command || undefined}
                data-folded={row.folded || undefined}
                title={it.turn.prompt}
                onClick={() => onSelect(it.turn.id)}
              >
                {/* The number column says "Prompt N" on screen; screen readers hear the words. */}
                {!it.command && it.title !== it.label && (
                  <span className="visually-hidden">{`${it.label} `}</span>
                )}
                <span className={`${css.num} figure`} aria-hidden="true">
                  {it.command || isOutsideTurn(it.turn) ? '' : it.turn.index}
                </span>
                {/* Not a prompt to the model, so not numbered like one: the command says what it was. */}
                <span className={css.title} data-title>
                  {it.command ? it.turn.prompt.trim() : it.title}
                </span>
                <span className={`${css.clock} figure`}>{clock}</span>
                {it.command ? (
                  <>
                    <span className={css.command}>{t('flow.localCommand')}</span>
                    {/* Part of the row's text, so screen readers read it; shown on hover and focus. */}
                    <span className={css.hint}>{t('flow.localCommandHint')}</span>
                  </>
                ) : (
                  <>
                    <span className={css.markTop}>{mark}</span>
                    {it.turn.origin !== 'human' && it.turn.sender && (
                      <span className={css.sender}>
                        {t('flow.from', { sender: it.turn.sender })}
                      </span>
                    )}
                    <span className={css.sub}>
                      <span className={`${css.subClock} figure`}>{clock}</span>
                      <span className={css.counts}>
                        <FigureText
                          k="flow.callsToolsShort"
                          params={{ calls: it.calls, tools: it.tools }}
                        />
                      </span>
                      {it.cost.priced && (
                        <span className={`${css.cost} figure`} title={costTitle(it.cost, t)}>
                          ≈{formatUsdShort(it.cost.usd, intl)}
                        </span>
                      )}
                      <span className={css.markSub}>{mark}</span>
                    </span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
});

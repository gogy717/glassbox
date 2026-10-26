import { ArrowUpRight, ChevronRight, Search } from 'lucide-react';
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { MAIN_AGENT_ID, type SessionSummary, type ToolCall } from '../../../../src/core/model.js';
import { CategoryIcon } from '../../components/CategoryIcon';
import { FigureText } from '../../components/FigureText';
import { StatusMark } from '../../components/Status';
import { type OpenSession, StoreContext, useWeekCache } from '../../data/store';
import { type RovingItemProps, useRovingFocus } from '../../data/useRovingFocus';
import { type MessageKey, useI18n } from '../../i18n';
import { subtreeIds } from '../../lib/agents';
import { formatClock } from '../../lib/format';
import { toolCategory } from '../../lib/tool-category';
import type { Navigate } from '../../router';
import { useUi } from '../../ui';
import { EditDetailView } from './details';
import css from './FilesView.module.css';
import {
  buildFiles,
  crossingKeys,
  type FileGroup,
  type FileRow,
  type FilesSummary,
  type FileVerb,
  filterFiles,
  groupFiles,
  VERBS,
} from './files-model';
import { useFilesPrefs } from './prefs';

interface Props {
  open: OpenSession;
  agentId: string;
  navigate: Navigate;
}

/** The three chips, each standing for the verbs it shows. */
const CHIPS: { key: 'edited' | 'created' | 'read'; verbs: readonly FileVerb[] }[] = [
  { key: 'edited', verbs: ['edited', 'deleted'] },
  { key: 'created', verbs: ['created'] },
  { key: 'read', verbs: ['read', 'searched'] },
];

/** The head line's parts: files edited, created and read always; deleted and searched when any. */
const HEAD: { key: MessageKey; count: keyof FilesSummary; always: boolean }[] = [
  { key: 'files.headEdited', count: 'edited', always: true },
  { key: 'files.headCreated', count: 'created', always: true },
  { key: 'files.headRead', count: 'read', always: true },
  { key: 'files.headDeleted', count: 'deleted', always: false },
  { key: 'files.headSearched', count: 'searched', always: false },
];

const NO_SESSIONS: SessionSummary[] = [];
const noSubscription = () => () => {};
/** A directory as its segments, whichever separator: "/w/x" and "/w/x/" alike. */
const dirKey = (dir: string) =>
  dir
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/');

/**
 * The session's files another worktree of its repository changed too in the last 7 days, by row
 * key, each with those trees' names. Read from the week only while the session list holds a
 * session in another tree of the repository; null otherwise, and before the week is read.
 */
function useCrossing(open: OpenSession): Map<string, string[]> | null {
  const store = useContext(StoreContext);
  const sessions = useSyncExternalStore(store ? store.subscribe : noSubscription, () =>
    store ? store.getState().sessions : NO_SESSIONS,
  );
  const repo = (sessions.find((s) => s.id === open.id) ?? open.session).repo ?? null;
  const elsewhere =
    !!repo &&
    sessions.some(
      (s) =>
        !!s.repo &&
        dirKey(s.repo.root) === dirKey(repo.root) &&
        dirKey(s.repo.dir) !== dirKey(repo.dir),
    );
  const cache = useWeekCache();
  const week = useSyncExternalStore(cache.subscribe, () => cache.get()['7d']?.result ?? null);
  useEffect(() => {
    if (!elsewhere) return;
    const release = cache.retain('7d');
    cache.request('7d');
    return release;
  }, [cache, elsewhere]);
  // By the repository's place, not its object: the session list arrives anew every few seconds.
  const root = repo?.root ?? null;
  const dir = repo?.dir ?? null;
  const name = repo?.name ?? '';
  return useMemo(
    () =>
      elsewhere && root !== null && dir !== null && week
        ? crossingKeys(open, { root, dir, name }, week)
        : null,
    [elsewhere, root, dir, name, week, open],
  );
}

export function FilesView({ open, agentId, navigate }: Props) {
  const { t } = useI18n();
  const { setFollow } = useUi();
  const [prefs, setPrefs] = useFilesPrefs();
  const subtree = useMemo(() => subtreeIds(open, agentId), [open, agentId]);
  const hasSub = subtree.size > 1;
  const ids = useMemo(
    () => (prefs.subAgents ? subtree : new Set([agentId])),
    [prefs.subAgents, subtree, agentId],
  );
  const files = useMemo(() => buildFiles(open, ids), [open, ids]);
  const [chips, setChips] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const crossing = useCrossing(open);
  const [crossingOnly, setCrossingOnly] = useState(false);
  const verbs = useMemo(
    () => new Set(CHIPS.filter((c) => chips.has(c.key)).flatMap((c) => c.verbs)),
    [chips],
  );
  const shown = useMemo(() => {
    const rows = filterFiles(files.rows, verbs, query);
    return crossing && crossingOnly ? rows.filter((r) => crossing.has(r.key)) : rows;
  }, [files, verbs, query, crossing, crossingOnly]);
  const groups = useMemo(() => groupFiles(shown), [shown]);
  const name =
    agentId === MAIN_AGENT_ID ? t('crumb.main') : (open.agents.get(agentId)?.label ?? agentId);
  // The files a chip stands for, counted on the unfiltered rows, so a chip says what it holds.
  const chipCount = (chipVerbs: readonly FileVerb[]) =>
    files.rows.filter((r) => r.touches.some((x) => chipVerbs.includes(x.verb))).length;
  const crossed = crossing ? files.rows.filter((r) => crossing.has(r.key)) : [];
  const crossedTrees = [...new Set(crossed.flatMap((r) => crossing?.get(r.key) ?? []))];

  const toggleChip = (key: string) =>
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const openCall = useCallback(
    (tool: ToolCall) => {
      setFollow(false);
      // Lands on the call in the execution chain with this tool's card open, as a link does.
      navigate({
        tab: 'flow',
        agentId: tool.agentId,
        turnId: open.requests.get(tool.requestId)?.turnId ?? null,
        requestId: tool.requestId,
        card: `tool:${tool.id}`,
      });
    },
    [open, navigate, setFollow],
  );

  // Nothing at all: the whole session's work, or this agent's alone, read or changed no file.
  if (files.rows.length === 0) {
    const whole = agentId === MAIN_AGENT_ID && (prefs.subAgents || !hasSub);
    return (
      <div className={css.view}>
        <p className={css.empty}>{t(whole ? 'files.empty' : 'files.emptyAgent')}</p>
        {hasSub && (
          <p className={css.emptyControls}>
            <SubAgentsToggle on={prefs.subAgents} onChange={(on) => setPrefs({ subAgents: on })} />
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={css.view}>
      <header className={css.head}>
        <p className={css.headline}>
          {HEAD.filter((p) => p.always || files.summary[p.count] > 0).map((p, i) => (
            <Fragment key={p.key}>
              {i > 0 && ' · '}
              <FigureText k={p.key} params={{ n: files.summary[p.count] }} />
            </Fragment>
          ))}
          <span className={css.headAgent}> · {name}</span>
        </p>
        <div className={css.controls}>
          {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle chips, not a form fieldset */}
          <div className={css.chips} role="group" aria-label={t('files.filters')}>
            {CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={css.chip}
                aria-pressed={chips.has(c.key)}
                onClick={() => toggleChip(c.key)}
              >
                {t(`files.chip.${c.key}`)}
                <span className={`${css.chipCount} figure`}>{chipCount(c.verbs)}</span>
              </button>
            ))}
            {crossing && (
              <button
                type="button"
                className={css.chip}
                aria-pressed={crossingOnly}
                title={t('files.crossingTitle', {
                  n: crossed.length,
                  trees: crossedTrees.join(', '),
                })}
                onClick={() => setCrossingOnly((on) => !on)}
              >
                {t('files.chip.crossing')}
                <span className={`${css.chipCount} figure`}>{crossed.length}</span>
              </button>
            )}
          </div>
          <label className={css.filter}>
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder={t('files.filterPath')}
              aria-label={t('files.filterPath')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  setQuery('');
                }
              }}
            />
          </label>
          {hasSub && (
            <SubAgentsToggle on={prefs.subAgents} onChange={(on) => setPrefs({ subAgents: on })} />
          )}
        </div>
      </header>
      {groups.length === 0 ? (
        <p className={css.empty}>{t('files.noMatch')}</p>
      ) : (
        <FileList groups={groups} crossing={crossing} onOpen={openCall} />
      )}
    </div>
  );
}

function SubAgentsToggle({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  const { t } = useI18n();
  return (
    <button type="button" className={css.toggle} aria-pressed={on} onClick={() => onChange(!on)}>
      {t('files.includeSub')}
    </button>
  );
}

/** The rows, directory by directory: one tab stop, the arrow keys move between files. */
function FileList({
  groups,
  crossing,
  onOpen,
}: {
  groups: FileGroup[];
  /** The files another worktree changed too, with those trees' names. */
  crossing: Map<string, string[]> | null;
  onOpen(tool: ToolCall): void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.key)), [groups]);
  const roving = useRovingFocus(listRef, keys, null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const id = useId();
  return (
    <div ref={listRef} className={css.list}>
      {groups.map((g, gi) => (
        <section
          key={`${g.outside}:${g.dir}`}
          className={css.group}
          aria-labelledby={`${id}-g${gi}`}
        >
          <h3 id={`${id}-g${gi}`} className={css.dir}>
            {g.dir === '' && !g.outside ? t('files.root') : g.dir}
          </h3>
          <ul className={css.rows}>
            {g.rows.map((row) => (
              <FileItem
                key={row.key}
                row={row}
                also={crossing?.get(row.key)}
                expanded={expanded.has(row.key)}
                onToggle={() => toggle(row.key)}
                onOpen={onOpen}
                roving={roving(row.key)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const CHANGED = new Set<FileVerb>(['edited', 'created', 'deleted']);

function FileItem({
  row,
  also,
  expanded,
  onToggle,
  onOpen,
  roving,
}: {
  row: FileRow;
  /** The other worktrees that changed this file too. */
  also?: string[];
  expanded: boolean;
  onToggle(): void;
  onOpen(tool: ToolCall): void;
  roving: RovingItemProps;
}) {
  const { t, intl } = useI18n();
  const bodyId = useId();
  const verbs = VERBS.filter((v) => row.counts[v] > 0);
  const changed = verbs.some((v) => CHANGED.has(v)) || row.touches.some((x) => CHANGED.has(x.verb));
  const lastAt = row.lastAt ? new Date(row.lastAt) : null;
  const parts = [
    ...verbs.map((v) => (
      <span key={v} data-changed={CHANGED.has(v) || undefined}>
        {row.counts[v] > 1 ? (
          <FigureText
            k="files.times"
            params={{ verb: t(`files.verb.${v}`), n: row.counts[v] }}
            figures={['n']}
          />
        ) : (
          t(`files.verb.${v}`)
        )}
      </span>
    )),
    ...(row.failed > 0
      ? [
          <span key="failed" className={css.failedWord}>
            <FigureText k="files.failed" params={{ n: row.failed }} />
          </span>,
        ]
      : []),
    ...(row.running > 0
      ? [
          <span key="running" className={css.runningWord}>
            <FigureText k="files.running" params={{ n: row.running }} />
          </span>,
        ]
      : []),
    ...(also && also.length > 0
      ? [
          <span key="also" className={css.alsoWord}>
            {t('files.alsoIn', { trees: also.join(', ') })}
          </span>,
        ]
      : []),
  ];
  return (
    <li data-changed={changed || undefined}>
      <button
        type="button"
        className={css.rowHead}
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={onToggle}
        {...roving}
      >
        <ChevronRight size={14} className={css.chevron} aria-hidden="true" />
        <span className={css.what}>
          <span className={css.name} title={row.key}>
            {row.name}
          </span>
          <span className={css.verbs}>
            {parts.map((p, i) => (
              <Fragment key={p.key}>
                {i > 0 && ' · '}
                {p}
              </Fragment>
            ))}
          </span>
        </span>
        <span
          className={`${css.when} figure`}
          title={
            lastAt && !Number.isNaN(lastAt.getTime())
              ? t('files.lastAt', { t: lastAt.toLocaleString(intl) })
              : undefined
          }
        >
          {formatClock(row.lastAt)}
        </span>
      </button>
      {expanded && (
        <div id={bodyId} className={css.rowBody}>
          <ol className={css.calls} aria-label={t('summary.toolCalls')}>
            {row.touches.map((touch) => {
              const tool = touch.tool;
              const status = tool.status;
              return (
                <li key={tool.id}>
                  <button
                    type="button"
                    className={css.call}
                    title={t('steps.openInFlow')}
                    onClick={() => onOpen(tool)}
                  >
                    <CategoryIcon category={toolCategory(tool.name, tool.input)} />
                    <b>{tool.name}</b>
                    {touch.lines && <code>:{touch.lines}</code>}
                    <span>·</span>
                    {status === 'error' || status === 'running' ? (
                      <StatusMark status={status} />
                    ) : (
                      <span>{t(`files.verb.${touch.verb}`)}</span>
                    )}
                    <span>·</span>
                    <span className="figure">{formatClock(tool.endedAt ?? tool.startedAt)}</span>
                    <ArrowUpRight size={13} className={css.arrow} aria-hidden="true" />
                  </button>
                  <EditDetailView detail={touch.detail} label={`${tool.name} · ${row.name}`} />
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </li>
  );
}

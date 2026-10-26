/**
 * Crossing (A): the files more than one worktree of a repository changed in the window, which
 * only merge time finds otherwise. A card under By CLI and Top projects, a line per repository
 * worked on in two or more worktrees; a panel of each such file with the trees in columns, the
 * lines both changed in the error tone, a file unfolding into each tree's changes side by side
 * (the Files tab's diffs), each read from its session on demand and linked to its call.
 */
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { Fragment, memo, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { MAIN_AGENT_ID } from '../../../../src/core/model.js';
import {
  type CrossingPath,
  type RepoCrossing,
  spanText,
  type TreeRef,
  type TreeSide,
} from '../../../../src/shared/crossing.js';
import { buildFiles, type FileTouch, type FileVerb } from '../../../../src/shared/files.js';
import { AgentTag } from '../../components/AgentTag';
import { Modal } from '../../components/Modal';
import { clock, shortDay } from '../../components/receipt/format';
import { fetchSnapshot } from '../../data/api';
import { fromSnapshot, type OpenSession } from '../../data/store';
import { type Locale, useI18n } from '../../i18n';
import { subtreeIds } from '../../lib/agents';
import { formatClock } from '../../lib/format';
import { callLink } from '../../router';
import { useUi } from '../../ui';
import { EditDetailView } from '../files/details';
import css from './Crossing.module.css';
import { Head } from './StatsCards';
import pageCss from './StatsPage.module.css';
import { crossingOf, type StatsWeek } from './statsData';
import { st } from './strings';

/** The sessions the panel has read, each once, whichever files unfold. */
type Sessions = Map<string, Promise<OpenSession | null>>;

/** The Crossing card: drawn only when a repository was worked on in two or more worktrees. */
export const CrossingCard = memo(function CrossingCard({
  w,
  locale,
}: {
  w: StatsWeek;
  locale: Locale;
}) {
  const repos = crossingOf(w);
  const [open, setOpen] = useState(false);
  const showRef = useRef<HTMLButtonElement>(null);
  if (repos.length === 0) return null;
  const crossed = repos.filter((r) => r.paths.length > 0);
  return (
    <section className={pageCss.card} data-area="crossing" aria-labelledby="stats-crossing">
      <Head id="stats-crossing" name={st(locale, 'crossing')} note={st(locale, 'crossingNote')} />
      <ul className={css.repos}>
        {repos.map((r) => {
          const same = r.paths.filter((p) => p.overlap === true).length;
          return (
            <li key={r.root}>
              {r.paths.length > 0
                ? st(locale, 'crossingLine', { n: r.paths.length, repo: r.name })
                : st(locale, 'crossingNone', { repo: r.name })}
              {same > 0 && (
                <span className={css.same}> · {st(locale, 'crossingSame', { n: same })}</span>
              )}
            </li>
          );
        })}
      </ul>
      {crossed.length > 0 && (
        <button ref={showRef} type="button" className={pageCss.link} onClick={() => setOpen(true)}>
          {st(locale, 'crossingShow')}
        </button>
      )}
      {open && (
        <CrossingPanel
          repos={crossed}
          from={w.result.window.hourStarts[0] ?? 0}
          locale={locale}
          onClose={() => setOpen(false)}
          returnFocusTo={showRef}
        />
      )}
    </section>
  );
});

function CrossingPanel({
  repos,
  from,
  locale,
  onClose,
  returnFocusTo,
}: {
  repos: RepoCrossing[];
  /** Where the window starts: changes before it are not the window's. */
  from: number;
  locale: Locale;
  onClose(): void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const [sessions] = useState<Sessions>(() => new Map());
  const cut = repos.some((r) => r.cut > 0);
  return (
    <Modal
      label={st(locale, 'crossing')}
      subtitle={st(locale, 'crossingNote')}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <div className={css.panel}>
        {repos.map((r) => (
          <RepoTable key={r.root} repo={r} from={from} locale={locale} sessions={sessions} />
        ))}
        <p className={css.hint}>
          {st(locale, 'crossingHint')}
          {cut && ` ${st(locale, 'crossingCut')}`}
        </p>
      </div>
    </Modal>
  );
}

/** A repository's crossing files, a row each, its worktrees in columns. */
function RepoTable({
  repo,
  from,
  locale,
  sessions,
}: {
  repo: RepoCrossing;
  from: number;
  locale: Locale;
  sessions: Sessions;
}) {
  const id = useId();
  return (
    <section className={css.repo}>
      <h3 id={id} className={css.repoName}>
        {repo.name}
      </h3>
      <div className={css.scroll}>
        <table className={css.table} aria-labelledby={id}>
          <thead>
            <tr>
              <th scope="col" className={css.head}>
                {st(locale, 'crossingFile')}
              </th>
              {repo.trees.map((t) => (
                <th key={t.dir} scope="col" className={css.head} title={t.dir}>
                  {t.name}
                  {t.main && <span className={css.main}> · {st(locale, 'crossingMain')}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {repo.paths.map((p) => (
              <PathRows
                key={p.path}
                path={p}
                trees={repo.trees}
                from={from}
                locale={locale}
                sessions={sessions}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const VERDICT = {
  true: 'crossingSameLines',
  false: 'crossingApart',
  null: 'crossingUnknown',
} as const;

/** A crossing file: its row, and once unfolded, each tree's changes of it side by side. */
function PathRows({
  path,
  trees,
  from,
  locale,
  sessions,
}: {
  path: CrossingPath;
  trees: TreeRef[];
  from: number;
  locale: Locale;
  sessions: Sessions;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <>
      <tr className={css.row}>
        <th scope="row" className={css.fileCell}>
          <button
            type="button"
            className={css.file}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronRight size={14} className={css.chevron} aria-hidden="true" />
            <span className={css.path}>
              {/* A narrow column breaks the path after a slash, not inside a name. */}
              {path.path.split('/').map((segment, i, all) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a path's segments, in order
                <Fragment key={i}>
                  {segment}
                  {i < all.length - 1 && (
                    <>
                      /<wbr />
                    </>
                  )}
                </Fragment>
              ))}
            </span>
          </button>
          <span className={css.verdict} data-overlap={String(path.overlap)}>
            {st(locale, VERDICT[String(path.overlap) as keyof typeof VERDICT])}
          </span>
        </th>
        {trees.map((t) => {
          const side = path.sides.find((s) => s.tree.dir === t.dir);
          return (
            <td key={t.dir} className={css.cell}>
              {side && <SideFigures side={side} locale={locale} />}
            </td>
          );
        })}
      </tr>
      {open && (
        <tr id={detailId} className={css.detailRow}>
          <td colSpan={trees.length + 1} className={css.detailCell}>
            <div className={css.sides}>
              {path.sides.map((side) => (
                <SideChanges
                  key={side.tree.dir}
                  side={side}
                  from={from}
                  locale={locale}
                  sessions={sessions}
                />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** A tree's cell: its edits and sessions, its last change, and the lines it changed. */
function SideFigures({ side, locale }: { side: TreeSide; locale: Locale }) {
  return (
    <>
      {st(locale, 'crossingEdits', { n: side.edits })} ·{' '}
      {st(locale, 'crossingSessions', { n: side.sessions.length })} ·{' '}
      {st(locale, 'crossingLast', { time: `${shortDay(side.last, locale)} ${clock(side.last)}` })} ·{' '}
      <Lines side={side} locale={locale} />
    </>
  );
}

/** The lines a tree changed, as it found the file; those another tree changed too, hot. */
function Lines({ side, locale }: { side: TreeSide; locale: Locale }) {
  if (side.lines === 'all')
    return (
      <span className={css.span} data-hot="">
        {st(locale, 'crossingWhole')}
      </span>
    );
  const spans = side.lines;
  if (spans.length === 0)
    return <>{st(locale, side.known ? 'crossingNoLines' : 'crossingLinesUnknown')}</>;
  const many = spans.length > 1 || (spans[0]?.to ?? 0) > (spans[0]?.from ?? 0);
  // The words around the runs, whichever side of them the language puts them.
  const [before, after] = st(locale, many ? 'crossingAtLines' : 'crossingAtLine', {
    spans: '\u0000',
  }).split('\u0000');
  return (
    <>
      {before}
      {spans.map((s, i) => (
        <Fragment key={`${s.from}-${s.to}`}>
          {i > 0 && st(locale, 'crossingSep')}
          <span className={`${css.span} figure`} data-hot={s.hot ? '' : undefined}>
            {spanText(s)}
          </span>
        </Fragment>
      ))}
      {after}
      {!side.known && st(locale, 'crossingMore')}
    </>
  );
}

/** One tree's changes of the file, session by session. */
function SideChanges({
  side,
  from,
  locale,
  sessions,
}: {
  side: TreeSide;
  from: number;
  locale: Locale;
  sessions: Sessions;
}) {
  return (
    <section
      className={css.side}
      aria-label={st(locale, 'crossingChangesIn', { tree: side.tree.name })}
    >
      <h4 className={css.sideHead}>{side.tree.name}</h4>
      {side.sessions.map((s) => (
        <SessionChanges
          key={s.id}
          id={s.id}
          path={s.path}
          from={from}
          locale={locale}
          sessions={sessions}
        />
      ))}
    </section>
  );
}

/** The session, read once for the panel; undefined while reading, null when it cannot be. */
function useOpened(sessions: Sessions, id: string): OpenSession | null | undefined {
  const [got, setGot] = useState<OpenSession | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let read = sessions.get(id);
    if (!read) {
      read = fetchSnapshot(id).then(
        (snap) => fromSnapshot(id, snap),
        () => null,
      );
      sessions.set(id, read);
    }
    void read.then((open) => {
      if (live) setGot(open);
    });
    return () => {
      live = false;
    };
  }, [sessions, id]);
  return got;
}

const CHANGED = new Set<FileVerb>(['edited', 'created', 'deleted']);

/** The calls of a session that changed `path` in the window, as the week counted them. */
function changesIn(open: OpenSession, path: string, from: number): FileTouch[] {
  const row = buildFiles(open, subtreeIds(open, MAIN_AGENT_ID)).rows.find((r) => r.key === path);
  return (row?.touches ?? []).filter(
    (x) =>
      CHANGED.has(x.verb) &&
      x.tool.status !== 'error' &&
      x.tool.status !== 'running' &&
      !(Date.parse(x.tool.endedAt ?? x.tool.startedAt ?? '') < from),
  );
}

/** A session's changes of the file: each its call (a link into the session) and its diff. */
function SessionChanges({
  id,
  path,
  from,
  locale,
  sessions,
}: {
  id: string;
  path: string;
  from: number;
  locale: Locale;
  sessions: Sessions;
}) {
  const { t } = useI18n();
  const { setFollow } = useUi();
  const open = useOpened(sessions, id);
  if (open === undefined) return <p className={css.note}>{st(locale, 'crossingReading')}</p>;
  if (open === null) return <p className={css.note}>{st(locale, 'crossingFailed')}</p>;
  const changes = changesIn(open, path, from);
  return (
    <div className={css.session}>
      <p className={css.sessionHead}>
        <AgentTag kind={open.session.agent} />
        <span className={css.title}>{open.session.title ?? t('sidebar.untitled')}</span>
      </p>
      {changes.length === 0 ? (
        <p className={css.note}>{st(locale, 'crossingNoChange')}</p>
      ) : (
        <ol className={css.changes}>
          {changes.map((c) => (
            <li key={c.tool.id}>
              <a
                className={css.call}
                href={callLink(id, c.tool, open.requests.get(c.tool.requestId)?.turnId ?? null)}
                title={t('steps.openInFlow')}
                // Lands on the call, as the Files tab's links do: the view does not follow on.
                onClick={() => setFollow(false)}
              >
                <b>{c.tool.name}</b>
                {c.lines && <code>:{c.lines}</code>}
                <span>·</span>
                <span>{t(`files.verb.${c.verb}`)}</span>
                <span>·</span>
                <span className="figure">{formatClock(c.tool.endedAt ?? c.tool.startedAt)}</span>
                <ArrowUpRight size={13} className={css.arrow} aria-hidden="true" />
              </a>
              <EditDetailView detail={c.detail} label={`${c.tool.name} · ${path}`} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

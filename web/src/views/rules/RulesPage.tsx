import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type RuleCounts,
  type RuleRow,
  type RulesResult,
  type RulesWindowKind,
  SUGGEST_AFTER,
} from '../../../../src/shared/permissions.js';
import { CodeBlock } from '../../components/CodeBlock';
import { Switch } from '../../components/Switch';
import { useI18n } from '../../i18n';
import { agentName } from '../../lib/agent-names';
import { DASH, formatClock, formatNumber, formatRelative } from '../../lib/format';
import { type AllowBlock, allowBlocks, allowJson } from './blocks';
import css from './RulesPage.module.css';
import { type ReadRules, readRules } from './readRules';

export interface RulesPageProps {
  /** The window in the route. */
  window: RulesWindowKind;
  /** Another window picked: the route changes in place. */
  onWindow(window: RulesWindowKind): void;
  now: number;
  /** Reads a window; `/api/rules` unless a test says. */
  read?: ReadRules;
}

/** Rows drawn at first, and added by each Show more. */
const FIRST = 100;
const MORE = 200;

interface Reading {
  done: number;
  total: number;
}

interface RulesState {
  result: RulesResult | null;
  reading: Reading | null;
  failed: string | null;
}

/**
 * The window read, read again on `refresh()` (the server parses the running sessions again too).
 * A result stays while its window is read again, and while a read fails.
 */
function useRules(kind: RulesWindowKind, read: ReadRules): [RulesState, () => void] {
  const [state, setState] = useState<RulesState>({
    result: null,
    reading: { done: 0, total: 0 },
    failed: null,
  });
  const [asked, setAsked] = useState(0);
  const seen = useRef(asked);
  useEffect(() => {
    const refresh = seen.current !== asked;
    seen.current = asked;
    const abort = new AbortController();
    const live = () => !abort.signal.aborted;
    setState((s) => ({ ...s, reading: { done: 0, total: 0 } }));
    read(
      kind,
      refresh,
      (done, total) => live() && setState((s) => ({ ...s, reading: { done, total } })),
      abort.signal,
    )
      .then((result) => live() && setState({ result, reading: null, failed: null }))
      .catch(
        (err: unknown) =>
          live() &&
          setState((s) => ({
            ...s,
            reading: null,
            failed: err instanceof Error ? err.message : String(err),
          })),
      );
    return () => abort.abort();
  }, [kind, read, asked]);
  return [state, () => setAsked((n) => n + 1)];
}

/** What a rule names, for the tool filter: built-in tools first, then MCP servers, then Codex. */
function toolOrder(tool: string): number {
  return tool.startsWith('mcp__') ? 1 : tool === 'prefix_rule' || tool === 'apply_patch' ? 2 : 0;
}

/**
 * The Rules page: every permission rule the sessions of a window asked for, the most asked
 * first, with how each was answered, where, when last, and whether your settings hold it; a
 * filter by repository (its counts then that repository's) and by tool; and the rules ticked as
 * JSON to merge into a settings file, yours or a project's: the suggestions ticked to begin
 * with, never a rule that may do harm. glassbox writes nothing.
 */
export function RulesPage({ window: kind, onWindow, now, read = readRules }: RulesPageProps) {
  const { t, intl } = useI18n();
  const [state, refresh] = useRules(kind, read);
  const result = state.result?.window.kind === kind ? state.result : null;
  const [repo, setRepo] = useState('');
  const [tool, setTool] = useState('');
  const [limit, setLimit] = useState(FIRST);
  const [picked, setPicked] = useState<ReadonlyMap<string, boolean>>(new Map());
  const rows = result?.rows ?? [];
  const chosen = (row: RuleRow) => picked.get(row.key) ?? row.suggested;

  const repos = useMemo(() => {
    const byRoot = new Map<string, string>();
    for (const r of rows) for (const p of r.projects) if (p.root) byRoot.set(p.root, p.name);
    return [...byRoot].sort(([, a], [, b]) => a.localeCompare(b));
  }, [rows]);
  const tools = useMemo(
    () =>
      [...new Set(rows.map((r) => r.tool))].sort(
        (a, b) => toolOrder(a) - toolOrder(b) || a.localeCompare(b),
      ),
    [rows],
  );
  const shown = useMemo(() => {
    const out: { row: RuleRow; counts: RuleCounts }[] = [];
    for (const row of rows) {
      if (tool && row.tool !== tool) continue;
      const counts = repo ? row.projects.find((p) => p.root === repo) : row;
      if (counts) out.push({ row, counts });
    }
    return out.sort(
      (a, b) =>
        b.counts.asked - a.counts.asked ||
        Date.parse(b.counts.lastAsked) - Date.parse(a.counts.lastAsked),
    );
  }, [rows, repo, tool]);

  const toolLabel = (name: string) =>
    name.startsWith('mcp__')
      ? t('rules.mcp', { server: name.slice(5) })
      : name === 'prefix_rule'
        ? t('rules.codexCommands')
        : name === 'apply_patch'
          ? t('rules.codexPatches')
          : name;
  const nameOf = (row: RuleRow, root: string | null) =>
    row.projects.find((p) => p.root === root)?.name ?? root?.split('/').at(-1) ?? '';
  const held = (row: RuleRow) => {
    const said = row.inSettings.map((h) =>
      h.list === 'allow'
        ? h.scope === 'global'
          ? t('rules.yours')
          : nameOf(row, h.root)
        : h.scope === 'global'
          ? t('rules.deniedInYours')
          : t('rules.deniedIn', { where: nameOf(row, h.root) }),
    );
    return said.length > 0 ? [...new Set(said)].join(', ') : DASH;
  };

  const pick = (row: RuleRow, on: boolean) => setPicked(new Map(picked).set(row.key, on));
  const narrow = (set: (v: string) => void) => (v: string) => {
    set(v);
    setLimit(FIRST);
  };

  return (
    <div className={css.rules}>
      <h1 className="visually-hidden">{t('nav.rules')}</h1>
      <div className={css.head}>
        <Switch
          variant="segmented"
          label={t('rules.window')}
          value={kind}
          onChange={onWindow}
          options={[
            { value: '7d', label: t('rules.last7') },
            { value: '30d', label: t('rules.last30') },
            { value: 'all', label: t('rules.all') },
          ]}
        />
        <span className={css.status}>
          <Status state={state} result={result} onRefresh={refresh} />
        </span>
      </div>
      <p className={css.intro}>{t('rules.intro')}</p>
      {!result && state.reading && (
        <div className={css.progress} aria-hidden="true">
          <span
            style={{
              width: `${state.reading.total > 0 ? (state.reading.done / state.reading.total) * 100 : 0}%`,
            }}
          />
        </div>
      )}
      {result && rows.length === 0 && <p className={css.none}>{t('rules.none')}</p>}
      {result && rows.length > 0 && (
        <>
          <div className={css.filters}>
            <label className={css.filter}>
              <span>{t('rules.repo')}</span>
              <select
                className={css.select}
                value={repo}
                onChange={(e) => narrow(setRepo)(e.target.value)}
              >
                <option value="">{t('rules.allRepos')}</option>
                {repos.map(([root, name]) => (
                  <option key={root} value={root}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.filter}>
              <span>{t('rules.tool')}</span>
              <select
                className={css.select}
                value={tool}
                onChange={(e) => narrow(setTool)(e.target.value)}
              >
                <option value="">{t('rules.allTools')}</option>
                {tools.map((name) => (
                  <option key={name} value={name}>
                    {toolLabel(name)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {shown.length === 0 ? (
            <p className={css.none}>{t('rules.noneFiltered')}</p>
          ) : (
            <div className={css.scroll}>
              <table className={css.table}>
                <caption className="visually-hidden">{t('rules.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={css.pickHead}>
                      <span className="visually-hidden">{t('rules.colPick')}</span>
                    </th>
                    <th scope="col" className={css.ruleHead}>
                      {t('rules.colRule')}
                    </th>
                    <th scope="col">{t('rules.colAsked')}</th>
                    <th scope="col">{t('rules.colAllowed')}</th>
                    <th scope="col">{t('rules.colDenied')}</th>
                    <th scope="col" className={css.textHead}>
                      {t('rules.colRepos')}
                    </th>
                    <th scope="col" className={css.textHead}>
                      {t('rules.colLast')}
                    </th>
                    <th scope="col" className={css.textHead}>
                      {t('rules.colSettings')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, limit).map(({ row, counts }) => (
                    <tr key={`${row.agent}\n${row.key}`}>
                      <td className={css.pick}>
                        {row.agent === 'claude-code' ? (
                          <input
                            type="checkbox"
                            checked={chosen(row)}
                            aria-label={t('rules.pick', { rule: row.key })}
                            onChange={(e) => pick(row, e.target.checked)}
                          />
                        ) : (
                          <span className={css.apart} title={t('rules.codex')} />
                        )}
                      </td>
                      <td className={css.rule}>
                        <code className={css.key}>{row.key}</code>
                        {row.agent !== 'claude-code' && (
                          <span className={css.tag}>{agentName(row.agent)}</span>
                        )}
                        {row.suggested && (
                          <span
                            className={css.tag}
                            data-tone="suggested"
                            title={t('rules.suggestedWhy', { n: SUGGEST_AFTER })}
                          >
                            {t('rules.suggested')}
                          </span>
                        )}
                        {row.danger && (
                          <span className={css.tag} data-tone="danger" title={t('rules.dangerWhy')}>
                            {t(`rules.danger.${row.danger}`)}
                          </span>
                        )}
                      </td>
                      <td className={css.num}>{formatNumber(counts.asked, intl)}</td>
                      <td className={css.num}>{formatNumber(counts.allowed, intl)}</td>
                      <td className={css.num} data-denied={counts.denied > 0 ? '' : undefined}>
                        {formatNumber(counts.denied, intl)}
                      </td>
                      <td className={css.text}>{row.projects.map((p) => p.name).join(', ')}</td>
                      <td
                        className={css.text}
                        title={new Date(counts.lastAsked).toLocaleString(intl)}
                      >
                        {formatRelative(counts.lastAsked, now, intl)}
                      </td>
                      <td
                        className={css.text}
                        title={
                          row.inSettings.map((h) => `${h.rule} · ${h.path}`).join('\n') || undefined
                        }
                      >
                        {held(row)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {shown.length > limit && (
            <button type="button" className={css.more} onClick={() => setLimit(limit + MORE)}>
              {t('rules.more', { n: formatNumber(Math.min(MORE, shown.length - limit), intl) })}
            </button>
          )}
          <Blocks
            blocks={allowBlocks(rows, chosen)}
            yours={result.yourSettings ?? '~/.claude/settings.json'}
            read={result.settings.length}
          />
        </>
      )}
    </div>
  );
}

/**
 * When the data is from, and Refresh; or how far a first read got; or why a read failed (an
 * alert, which stays while the window is read again), as on Stats.
 */
function Status({
  state,
  result,
  onRefresh,
}: {
  state: RulesState;
  result: RulesResult | null;
  onRefresh(): void;
}) {
  const { t } = useI18n();
  const first = result ? null : state.reading;
  const progress = first
    ? first.total > 0
      ? t('rules.reading', { done: first.done, total: first.total })
      : t('rules.readingStart')
    : '';
  const action = state.reading ? (
    t('rules.updating')
  ) : (
    <button type="button" className={css.link} onClick={onRefresh}>
      {t('rules.refresh')}
    </button>
  );
  return (
    <>
      <span role="status">{progress}</span>
      {first ? null : state.failed !== null ? (
        <span className={css.failed}>
          <span role="alert">{t('rules.failed', { msg: state.failed })}</span> · {action}
        </span>
      ) : (
        result && (
          <span>
            {t('rules.asOf', { time: formatClock(new Date(result.asOf).toISOString()) })} · {action}
          </span>
        )
      )}
    </>
  );
}

/** The ticked rules as JSON, file by file, each with where it goes. */
function Blocks({ blocks, yours, read }: { blocks: AllowBlock[]; yours: string; read: number }) {
  const { t } = useI18n();
  return (
    <section className={css.blocks} aria-labelledby="rules-blocks">
      <h2 id="rules-blocks" className={css.blocksTitle}>
        {t('rules.blocks')}
      </h2>
      {blocks.length === 0 && <p className={css.none}>{t('rules.blocksEmpty')}</p>}
      {blocks.map((b) => (
        <div key={b.root ?? ''} className={css.block}>
          <h3 className={css.blockTitle}>
            {b.scope === 'global'
              ? t('rules.blockYours')
              : t('rules.blockProject', { name: b.name ?? '' })}
          </h3>
          <p className={css.where}>
            {b.scope === 'global'
              ? t('rules.blockYoursWhere', { path: yours })
              : t('rules.blockProjectWhere', {
                  local: `${b.root}/.claude/settings.local.json`,
                  shared: `${b.root}/.claude/settings.json`,
                })}
          </p>
          <CodeBlock text={allowJson(b.rules)} lang="json" label={t('rules.blocks')} />
        </div>
      ))}
      <p className={css.note}>{t('rules.settingsRead', { n: read })}</p>
    </section>
  );
}

import { Check, Copy, Maximize2 } from 'lucide-react';
import {
  type CSSProperties,
  memo,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { JsonView } from 'react-json-view-lite';
import { type T, useI18n } from '../i18n';
import css from './JsonInspector.module.css';
import { LineView } from './LineView';
import { Modal } from './Modal';

/** Strings past this length are cut in the tree; Copy and Raw always carry the full value. */
const INLINE_CLIP = 2_000;
const DIALOG_CLIP = 20_000;
const MAX_DEPTH = 40;

function clipStrings(value: unknown, max: number, more: (n: number) => string, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > max ? `${value.slice(0, max)}${more(value.length - max)}` : value;
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, max, more, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = clipStrings(v, max, more, depth + 1);
  return out;
}

/** DSH rule: the top level, `messages` and `tools` open; each message or tool starts collapsed. */
const shouldExpand = (level: number, _value: unknown, field?: string) =>
  level === 0 || field === 'messages' || field === 'tools' || level > 2;

/** The library does not export its style type from the entry point; derive it from the props. */
const style: NonNullable<Parameters<typeof JsonView>[0]['style']> = {
  container: css.tree as string,
  basicChildStyle: css.child as string,
  label: css.key as string,
  clickableLabel: css.clickable as string,
  nullValue: css.keyword as string,
  undefinedValue: css.keyword as string,
  numberValue: css.number as string,
  stringValue: css.string as string,
  booleanValue: css.keyword as string,
  otherValue: css.keyword as string,
  punctuation: css.punct as string,
  expandIcon: css.expand as string,
  collapseIcon: css.collapse as string,
  collapsedContent: css.collapsed as string,
  childFieldsContainer: css.children as string,
  noQuotesForStringValues: false,
  quotesForFieldNames: false,
  ariaLables: { collapseJson: 'collapse', expandJson: 'expand' },
  stringifyStringValues: true,
};

/** The tree's expand/collapse buttons speak the UI language. */
function useLocalisedStyle() {
  const { t } = useI18n();
  return useMemo(
    () => ({
      ...style,
      ariaLables: { collapseJson: t('json.collapse'), expandJson: t('json.expand') },
    }),
    [t],
  );
}

/** Rows this deep and deeper say their level; past it the tree stops indenting (see the CSS). */
const LEVEL_CAP = 24;
const capStyle = { '--level-cap': LEVEL_CAP } as CSSProperties;

/** Whether some value sits `level` keys or indices below the top, i.e. the tree has such a row. */
function reaches(value: unknown, level: number): boolean {
  if (level <= 0) return true;
  if (value === null || typeof value !== 'object') return false;
  for (const v of Object.values(value)) if (reaches(v, level - 1)) return true;
  return false;
}

/**
 * Keeps JSON nested hundreds of levels deep (the server cuts it at 256) readable: rows from
 * LEVEL_CAP down get `data-json-level`, so CSS can stop their indent and show the level instead.
 * The library owns the rows, so they are found in the DOM, again whenever a node opens. That
 * pass costs ~15 ms per click on a fully open 1 MB tree, so JSON that never gets that deep (all
 * but pathological JSON) is not watched at all.
 */
function useLevelMarks(ref: RefObject<HTMLElement | null>, tree: object) {
  const { t } = useI18n();
  const deep = useMemo(() => reaches(tree, LEVEL_CAP), [tree]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !deep) return;
    const mark = () => {
      // Document order puts every row after its parent row, so one pass finds every level.
      const levels = new Map<Element, number>();
      for (const row of root.querySelectorAll<HTMLElement>('[role=treeitem]')) {
        const parent = row.parentElement?.closest('[role=treeitem]');
        const n = parent ? (levels.get(parent) ?? 0) + 1 : 0;
        levels.set(row, n);
        if (n >= LEVEL_CAP) row.dataset.jsonLevel = t('json.level', { n });
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ref, t, deep]);
}

const asTree = (data: unknown): object =>
  data !== null && typeof data === 'object' ? (data as object) : { value: data };

function more(t: T) {
  return (n: number) => t('text.more', { n: n.toLocaleString() });
}

interface Props {
  label: string;
  data: unknown;
}

/** Memoised: callers pass stable `data` so live store updates do not rebuild big trees. */
export const JsonInspector = memo(function JsonInspector({ label, data }: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [maximised, setMaximised] = useState(false);
  const inline = useMemo(() => asTree(clipStrings(data, INLINE_CLIP, more(t))), [data, t]);
  const treeStyle = useLocalisedStyle();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  useLevelMarks(viewportRef, inline);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1000);
    } catch {
      // Clipboard unavailable (permissions, insecure context): nothing to confirm.
    }
  };

  return (
    <div className={css.inspector}>
      <div className={css.toolbar}>
        <span className={css.badge}>{t('json.label')}</span>
        <button
          type="button"
          className={css.icon}
          aria-label={t(copied ? 'json.copied' : 'json.copy')}
          title={t(copied ? 'json.copied' : 'json.copy')}
          onClick={copy}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
        <button
          ref={maxRef}
          type="button"
          className={css.icon}
          aria-label={t('json.maximize')}
          title={t('json.maximize')}
          onClick={() => setMaximised(true)}
        >
          <Maximize2 size={14} aria-hidden="true" />
        </button>
      </div>
      <div ref={viewportRef} className={css.viewport} style={capStyle} data-scroll-region>
        <JsonView
          data={inline}
          style={treeStyle}
          shouldExpandNode={shouldExpand}
          clickToExpandNode
        />
      </div>
      {maximised && (
        <JsonDialog
          label={label}
          data={data}
          returnFocusTo={maxRef}
          onClose={() => setMaximised(false)}
        />
      )}
    </div>
  );
});

function JsonDialog({
  label,
  data,
  onClose,
  returnFocusTo,
}: Props & { onClose(): void; returnFocusTo: RefObject<HTMLButtonElement | null> }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  const tree = useMemo(() => asTree(clipStrings(data, DIALOG_CLIP, more(t))), [data, t]);
  const raw = useMemo(() => (mode === 'raw' ? JSON.stringify(data, null, 2) : ''), [data, mode]);
  const treeStyle = useLocalisedStyle();
  const treeRef = useRef<HTMLDivElement>(null);
  useLevelMarks(treeRef, tree);
  return (
    <Modal
      label={t('json.title', { label })}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      actions={
        <div className={css.segmented} role="radiogroup" aria-label={t('json.label')}>
          {(['tree', 'raw'] as const).map((m) => (
            // biome-ignore lint/a11y/useSemanticElements: a two-option segmented control
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
            >
              {t(m === 'tree' ? 'json.tree' : 'json.raw')}
            </button>
          ))}
        </div>
      }
    >
      {mode === 'tree' ? (
        <div ref={treeRef} className={css.dialogTree} style={capStyle}>
          <JsonView
            data={tree}
            style={treeStyle}
            shouldExpandNode={shouldExpand}
            clickToExpandNode
          />
        </div>
      ) : (
        <LineView text={raw} />
      )}
    </Modal>
  );
}

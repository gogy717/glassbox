import { useMemo } from 'react';
import { ShowAll } from '../../components/CodeBlock';
import { FigureText } from '../../components/FigureText';
import { useI18n } from '../../i18n';
import { formatNumber } from '../../lib/format';
import css from './FilesView.module.css';
import { type DiffLine, type EditDetail, lineDiff, type Replacement } from './files-model';

/** Lines of a written file or a notebook cell shown under the row; the rest opens whole. */
const PREVIEW_LINES = 12;

/**
 * A listing of lines, each one kept (same), gone (del) or come (add): a list, one line an item,
 * so a copy keeps the line breaks and a screen reader hears what went and what came.
 */
function Lines({ lines, label }: { lines: DiffLine[]; label: string }) {
  return (
    <ol className={css.pre} aria-label={label}>
      {lines.map((l, i) => {
        // A fixed listing, never reordered: its index is its identity.
        const key = i;
        return (
          <li key={key} className={css.line} data-kind={l.kind}>
            {l.kind === 'del' ? (
              <del>{l.text}</del>
            ) : l.kind === 'add' ? (
              <ins>{l.text}</ins>
            ) : (
              l.text
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** One replacement as a two-colour diff: what went in red, what came in green, plain. */
function Diff({ edit }: { edit: Replacement }) {
  const { t } = useI18n();
  const lines = useMemo(() => lineDiff(edit.before, edit.after), [edit]);
  return (
    <div className={css.block}>
      {edit.all && <p className={css.meta}>{t('files.replaceAll')}</p>}
      <Lines lines={lines} label={t('files.diff')} />
    </div>
  );
}

/** The lines of a patch for one file: `-` gone, `+` come, `@@` and `*** Move to:` as notes. */
function Patch({ hunk }: { hunk: string }) {
  const { t } = useI18n();
  const lines = useMemo<DiffLine[]>(
    () =>
      hunk === ''
        ? []
        : hunk
            .split('\n')
            .map((line) =>
              line.startsWith('+')
                ? { kind: 'add', text: line.slice(1) }
                : line.startsWith('-')
                  ? { kind: 'del', text: line.slice(1) }
                  : { kind: 'same', text: line.startsWith(' ') ? line.slice(1) : line },
            ),
    [hunk],
  );
  if (lines.length === 0) return null;
  return (
    <div className={css.block}>
      <Lines lines={lines} label={t('files.diff')} />
    </div>
  );
}

/** Text written whole: its size, its first lines, and the rest on request. */
function Written({ text, label }: { text: string; label: string }) {
  const { intl } = useI18n();
  const all = text.split('\n');
  // A trailing newline is the file's end, not an empty last line.
  const lines = all.at(-1) === '' ? all.slice(0, -1) : all;
  const shown = lines.slice(0, PREVIEW_LINES);
  const cut = lines.length > shown.length;
  return (
    <div className={css.block}>
      <p className={css.meta}>
        <FigureText
          k="files.writeSize"
          params={{
            lines: formatNumber(lines.length, intl),
            chars: formatNumber(text.length, intl),
          }}
        />
      </p>
      <pre className={css.pre}>{shown.join('\n')}</pre>
      {cut && (
        <div className={css.more}>
          <ShowAll label={label} text={text} />
        </div>
      )}
    </div>
  );
}

/** What a call changed, unfolded under its file: the edit as a diff, the file written, the patch, the cell. */
export function EditDetailView({ detail, label }: { detail: EditDetail; label: string }) {
  const { t } = useI18n();
  switch (detail.kind) {
    case 'replace':
      return (
        <div className={css.detail}>
          {detail.edits.map((edit, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the edits of one call, in order
            <Diff key={i} edit={edit} />
          ))}
        </div>
      );
    case 'write':
      return (
        <div className={css.detail}>
          <Written text={detail.content} label={label} />
        </div>
      );
    case 'patch':
      return (
        <div className={css.detail}>
          <Patch hunk={detail.hunk} />
        </div>
      );
    case 'notebook': {
      const meta = [
        detail.cellId !== null ? t('files.cell', { id: detail.cellId }) : null,
        detail.mode,
        detail.cellType,
      ].filter((s): s is string => s !== null && s !== '');
      return (
        <div className={css.detail}>
          <div className={css.block}>
            {meta.length > 0 && <p className={css.meta}>{meta.join(' · ')}</p>}
            {detail.source !== null && detail.source !== '' && (
              <pre className={css.pre}>{detail.source}</pre>
            )}
          </div>
        </div>
      );
    }
    case 'none':
      return null;
  }
}

import { memo, useMemo } from 'react';
import { useI18n } from '../../../i18n';
import css from './detail.module.css';
import { CodeBlock } from './text';

/** A string this short, on one line, reads fine inline; anything longer gets a code block. */
const INLINE_MAX = 60;
/** Compact JSON up to this long stays on one line. */
const COMPACT_MAX = 100;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON object sent as text (OpenAI function arguments) reads as its fields. */
function parsed(input: unknown): unknown {
  if (typeof input !== 'string' || !input.trimStart().startsWith('{')) return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function Value({ value, label }: { value: unknown; label: string }) {
  const json = useMemo(
    () => (typeof value === 'object' && value !== null ? JSON.stringify(value) : null),
    [value],
  );
  if (typeof value === 'string') {
    return value.length <= INLINE_MAX && !value.includes('\n') ? (
      <code className={css.inline}>{value}</code>
    ) : (
      <CodeBlock text={value} label={label} />
    );
  }
  if (json === null) return <code className={css.inline}>{String(JSON.stringify(value))}</code>;
  return json.length <= COMPACT_MAX ? (
    <code className={css.inline}>{json}</code>
  ) : (
    <CodeBlock text={JSON.stringify(value, null, 2)} lang="json" label={label} />
  );
}

/**
 * A tool call's arguments, readable: each field under its name, strings with their real line
 * breaks (Bash `command`, Edit `old_string` / `new_string`, Write `content`, a patch), other
 * values as compact JSON.
 */
export const ArgsView = memo(function ArgsView({
  input,
  label,
}: {
  input: unknown;
  label: string;
}) {
  const { t } = useI18n();
  const value = useMemo(() => parsed(input), [input]);
  if (value === undefined) return <p className={css.muted}>{t('detail.argsNotRecorded')}</p>;
  if (!isPlain(value)) return <Value value={value} label={label} />;
  const entries = Object.entries(value);
  if (entries.length === 0) return <code className={css.inline}>{'{}'}</code>;
  return (
    <dl className={css.args}>
      {entries.map(([key, v]) => (
        <div key={key} className={css.arg}>
          <dt>{key}</dt>
          <dd>
            <Value value={v} label={`${label} · ${key}`} />
          </dd>
        </div>
      ))}
    </dl>
  );
});

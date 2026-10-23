import { ImageIcon, Wrench } from 'lucide-react';
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { RequestDetail } from '../../../../../src/core/model.js';
import { JsonInspector } from '../../../components/JsonInspector';
import { type MessageKey, useI18n } from '../../../i18n';
import { formatClock } from '../../../lib/format';
import { ArgsView } from './ArgsView';
import css from './detail.module.css';
import { useDetailPrefs } from './prefs';
import {
  type Block,
  type Message,
  messageText,
  readMessages,
  readParams,
  readSystem,
  readTools,
  shownRole,
  type ToolDef,
} from './read';
import { CodeBlock, CopyButton, ReadableText, Segmented } from './text';

/** Messages rendered at first, and added each time the list is scrolled to its end. */
const PAGE = 30;

const ROLES: Record<string, MessageKey> = {
  user: 'detail.roleUser',
  assistant: 'detail.roleAssistant',
  tool: 'detail.roleTool',
  system: 'detail.roleSystem',
};

function formatBytes(n: number, intl: string): string {
  const f = (v: number, unit: string) =>
    `${v.toLocaleString(intl, { maximumFractionDigits: 1 })} ${unit}`;
  if (n >= 1024 * 1024) return f(n / 1024 / 1024, 'MB');
  if (n >= 1024) return f(n / 1024, 'KB');
  return f(n, 'B');
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={css.section}>
      <h4>{title}</h4>
      {children}
    </div>
  );
}

/** A section glassbox cannot read as text: its JSON, saying why. */
function AsJson({ label, data }: { label: string; data: unknown }) {
  const { t } = useI18n();
  const wrapped = useMemo(() => ({ [label]: data }), [label, data]);
  return (
    <>
      <p className={css.muted}>{t('detail.unknownFormat')}</p>
      <JsonInspector label={label} data={wrapped} />
    </>
  );
}

function BlockView({ block: b, label }: { block: Block; label: string }) {
  const { t, intl } = useI18n();
  switch (b.kind) {
    case 'text':
      return <ReadableText text={b.text} label={label} />;
    case 'thinking':
      return b.text === null ? (
        <p className={css.muted}>{t('detail.thinkingHidden')}</p>
      ) : (
        <details className={css.thinking}>
          <summary>{t('detail.thinkingBlock', { n: b.text.length.toLocaleString(intl) })}</summary>
          <ReadableText text={b.text} label={label} />
        </details>
      );
    case 'tool-use':
      return (
        <div className={css.toolUse}>
          <div className={css.blockHead}>
            <Wrench size={12} aria-hidden="true" />
            {t('detail.toolUse', { name: b.name })}
          </div>
          <ArgsView input={b.input} label={`${label} · ${b.name}`} />
        </div>
      );
    case 'tool-result':
      return (
        <div className={css.toolResult} data-error={b.isError || undefined}>
          <div className={css.blockHead}>
            {t(b.isError ? 'detail.toolResultError' : 'detail.toolResult')}
          </div>
          {b.content === null ? (
            <p className={css.muted}>{t('detail.resultNotRecorded')}</p>
          ) : (
            b.content.map((c, i) =>
              c.kind === 'text' ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one immutable message
                <CodeBlock key={i} text={c.text} label={label} />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one immutable message
                <BlockView key={i} block={c} label={label} />
              ),
            )
          )}
        </div>
      );
    case 'media':
      return (
        <p className={css.media}>
          <ImageIcon size={13} aria-hidden="true" />
          {t('detail.media', {
            what: t(b.what === 'image' ? 'detail.image' : 'detail.document'),
            type: b.mediaType ?? '?',
            size: b.bytes === null ? '?' : formatBytes(b.bytes, intl),
          })}
        </p>
      );
    case 'tool-ref':
      return (
        <p className={css.muted}>
          {t(b.added ? 'detail.toolAdded' : 'detail.toolRef', { name: b.name })}
        </p>
      );
    case 'raw':
      return (
        <div className={css.raw}>
          <p className={css.muted}>{t('detail.rawBlock', { type: b.type })}</p>
          <CodeBlock text={JSON.stringify(b.value, null, 2) ?? ''} lang="json" label={label} />
        </div>
      );
  }
}

const MessageItem = memo(function MessageItem({
  message,
  n,
  total,
}: {
  message: Message;
  n: number;
  total: number;
}) {
  const { t, intl } = useI18n();
  const role = shownRole(message);
  const roleName = ROLES[role] ? t(ROLES[role] as MessageKey) : role;
  const position = t('detail.position', {
    n: n.toLocaleString(intl),
    total: total.toLocaleString(intl),
  });
  const label = `${roleName} ${position}`;
  return (
    <li className={css.message} data-role={role}>
      <article aria-label={t('detail.messageLabel', { role: roleName, position })}>
        <header className={css.messageHead}>
          <span className={css.role}>{roleName}</span>
          <span className={css.position}>{position}</span>
          {message.time && <span className={css.position}>{formatClock(message.time)}</span>}
          <CopyButton text={() => messageText(message)} label={t('detail.copyMessage')} />
        </header>
        {message.blocks.length === 0 ? (
          <p className={css.muted}>{t('detail.empty')}</p>
        ) : (
          message.blocks.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one immutable message
            <BlockView key={i} block={b} label={label} />
          ))
        )}
      </article>
    </li>
  );
});

/**
 * The conversation, newest or oldest first (remembered), each message with its position.
 * Renders a page at a time and adds the next as the list is scrolled to its end, so thousands
 * of messages cost no more than the ones in view.
 */
export function MessageList({ messages }: { messages: Message[] }) {
  const { t, intl } = useI18n();
  const [prefs, setPrefs] = useDetailPrefs();
  const [shown, setShown] = useState(PAGE);
  const end = useRef<HTMLLIElement>(null);
  const total = messages.length;
  const count = Math.min(shown, total);
  useEffect(() => {
    const el = end.current;
    if (!el || count >= total || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (seen) => {
        if (seen.some((s) => s.isIntersecting)) setShown((s) => s + PAGE);
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [count, total]);
  const indices = Array.from({ length: count }, (_, i) =>
    prefs.order === 'newest' ? total - 1 - i : i,
  );
  return (
    <div className={css.messages}>
      <div className={css.toolbar}>
        <span className={css.count}>
          {t('detail.messageCount', { n: total.toLocaleString(intl) })}
        </span>
        <Segmented
          label={t('detail.order')}
          value={prefs.order}
          options={[
            { value: 'newest', label: t('detail.newest') },
            { value: 'oldest', label: t('detail.oldest') },
          ]}
          onChange={(order) => {
            setPrefs({ order });
            setShown(PAGE);
          }}
        />
      </div>
      <ol className={css.list} data-scroll-region>
        {indices.map((i) => (
          <MessageItem key={i} message={messages[i] as Message} n={i + 1} total={total} />
        ))}
        {count < total && <li ref={end} className={css.end} aria-hidden="true" />}
      </ol>
      {count < total && (
        <button type="button" className={css.showAll} onClick={() => setShown((s) => s + PAGE)}>
          {t('detail.showMore', { n: Math.min(PAGE, total - count).toLocaleString(intl) })}
        </button>
      )}
    </div>
  );
}

function SystemView({ blocks }: { blocks: string[] }) {
  const { t, intl } = useI18n();
  return (
    <div className={css.stack}>
      {blocks.map((text, i) => {
        const title = t('detail.systemBlock', {
          n: i + 1,
          chars: text.length.toLocaleString(intl),
        });
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one immutable prompt
          <div key={i} className={css.sysBlock}>
            <div className={css.blockHead}>
              <span>{title}</span>
              <CopyButton text={() => text} label={t('detail.copyText')} />
            </div>
            <ReadableText text={text} label={`${t('detail.system')} · ${title}`} />
          </div>
        );
      })}
    </div>
  );
}

/** One tool; its description and schema are built only once it is opened. */
function ToolItem({ tool }: { tool: ToolDef }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const firstLine = tool.description?.split('\n', 1)[0] ?? '';
  return (
    <li>
      <details className={css.tool} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <code>{tool.name}</code>
          {tool.type && <span className={css.tag}>{tool.type}</span>}
          {firstLine && <span className={css.desc}>{firstLine}</span>}
        </summary>
        {open && (
          <div className={css.toolBody}>
            {tool.description ? (
              <ReadableText text={tool.description} label={tool.name} />
            ) : (
              <p className={css.muted}>{t('detail.noDescription')}</p>
            )}
            {tool.schema != null && (
              <>
                <h5>{t('detail.schema')}</h5>
                <JsonInspector label={tool.name} data={tool.schema} />
              </>
            )}
          </div>
        )}
      </details>
    </li>
  );
}

function ParamValue({ value }: { value: unknown }) {
  if (typeof value === 'string') return <>{value}</>;
  if (Array.isArray(value) && value.every((v) => typeof v !== 'object' || v === null))
    return <>{value.map(String).join(', ')}</>;
  return <code>{JSON.stringify(value)}</code>;
}

/** Fields as a compact name/value list: request params, a response's usage and timing. */
export function KeyValues({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className={css.params}>
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            <ParamValue value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What a request sent, readable: the conversation in the wide column, params, system prompt and
 * tools beside it.
 * Memoised: the panel re-renders on live store updates, the detail does not change.
 */
export const RequestReadable = memo(function RequestReadable({
  detail: d,
}: {
  detail: RequestDetail;
}) {
  const { t } = useI18n();
  const messages = useMemo(() => readMessages(d.messages), [d.messages]);
  const system = useMemo(() => readSystem(d.system), [d.system]);
  const tools = useMemo(() => readTools(d.tools), [d.tools]);
  const params = useMemo(() => readParams(d.params), [d.params]);
  const none = <p className={css.muted}>{t('common.notRecorded')}</p>;
  const messagesSection = (
    <Section title={t('detail.messages')}>
      {d.messages == null ? (
        none
      ) : messages ? (
        <MessageList messages={messages} />
      ) : (
        <AsJson label="messages" data={d.messages} />
      )}
    </Section>
  );
  const systemSection = (
    <Section title={t('detail.system')}>
      {d.system == null ? (
        none
      ) : system ? (
        <SystemView blocks={system} />
      ) : (
        <AsJson label="system" data={d.system} />
      )}
    </Section>
  );
  const paramsSection = (
    <Section title={t('detail.params')}>
      {params === null ? (
        <AsJson label="params" data={d.params} />
      ) : params.length === 0 ? (
        none
      ) : (
        <KeyValues entries={params} />
      )}
    </Section>
  );
  const toolsSection = (
    <Section title={t('detail.tools')}>
      {d.tools == null ? (
        none
      ) : tools ? (
        <ul className={css.tools}>
          {tools.map((tool, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two tools may share a name
            <ToolItem key={i} tool={tool} />
          ))}
        </ul>
      ) : (
        <AsJson label="tools" data={d.tools} />
      )}
    </Section>
  );
  // The conversation takes the wide column; without one (most agents record none), the prompt.
  return (
    <div className={css.readable}>
      <div className={css.columns}>
        <div className={css.main}>{d.messages == null ? systemSection : messagesSection}</div>
        <div className={css.side}>
          {paramsSection}
          {d.messages == null ? messagesSection : systemSection}
          {toolsSection}
        </div>
      </div>
    </div>
  );
});

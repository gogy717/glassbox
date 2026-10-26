import { Check, Copy } from 'lucide-react';
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SessionSummary } from '../../../../src/core/model.js';
import type { PermissionDecision } from '../../../../src/shared/runs.js';
import { ActivityLine, TroubleLine } from '../../components/ActivityLine';
import { AgentTag } from '../../components/AgentTag';
import { Answer, useArmed } from '../../components/Answer';
import { Delayed } from '../../components/Delayed';
import { LiveDot, Ticking } from '../../components/Status';
import type { OpenPrompt } from '../../data/runs';
import { useCommand } from '../../data/shortcuts';
import { type T, useI18n } from '../../i18n';
import { resumeCommand } from '../../lib/resume';
import { waitingSince, waitKind, waitLabel } from '../../lib/waiting';
import { sessionLink } from '../../router';
import promptCss from '../composer/Composer.module.css';
import { PROMPT_ARM_MS, ToolSummary } from '../composer/PermissionDialog';
import css from './Inbox.module.css';
import { type InboxItem, inboxItems } from './items';

interface Props {
  /** The sessions, the prompts of glassbox runs folded in (`withWaiting`). */
  sessions: SessionSummary[];
  /** The prompts glassbox runs hold open, by session (`openPrompts`); the rest a terminal holds. */
  prompts: ReadonlyMap<string, OpenPrompt>;
  showProbes: boolean;
  loaded: boolean;
  now: number;
  /** The session whose item focus starts on (a notification's); else the first item. */
  at: string | null;
  onOpen(sessionId: string): void;
  /** Answers a prompt of a glassbox run, as its dialog does (`RunsClient.decide`). */
  onDecide?(runId: string, permissionId: string, d: PermissionDecision): Promise<void> | void;
  /** How long the answers stay inert after the items move; PROMPT_ARM_MS unless a test says. */
  armMs?: number;
}

/** How long Copy says Copied, or that it could not, before it is itself again. */
const SAID_MS = 1500;

/** The items' elements, in the page's order. */
const itemsIn = (root: HTMLElement | null): HTMLElement[] => [
  ...(root?.querySelectorAll<HTMLElement>('[data-item]') ?? []),
];

/** The item `id`'s element (ids are matched as data, never written into a selector). */
const itemEl = (root: HTMLElement | null, id: string): HTMLElement | null =>
  itemsIn(root).find((el) => el.dataset.item === id) ?? null;

/**
 * `ids` in the order they had while `frozen`, the new ones at the end, so the list never moves
 * under the keys (the palette keeps its items while open the same way); as given otherwise.
 */
function useFrozenOrder(ids: readonly string[], frozen: boolean): readonly string[] {
  const [order, setOrder] = useState(ids);
  const next = frozen
    ? [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))]
    : ids;
  if (next.join('\n') !== order.join('\n')) setOrder(next);
  return next;
}

/**
 * The Inbox: everything that needs you, across sessions, to clear without the mouse. First what
 * waits for you, as Home's Needs you lists it, the oldest wait first: a glassbox run's prompt,
 * answered here (a tool's permission with its command whole, a question with the dialog's own
 * controls, a plan read whole), or a terminal's wait, which says where to answer it and how to
 * resume the session. Then the running sessions that look stuck, each with its sign. One tab
 * stop, focus on the first item on arrival (or a notification's); the arrows move between items,
 * Enter presses the item's main button, Esc comes back to the item from its controls. While an
 * item has focus the order holds, newcomers at the end; an item answered leaves with the next
 * update, and focus moves to the one after it.
 */
export function Inbox({
  sessions,
  prompts,
  showProbes,
  loaded,
  now,
  at,
  onOpen,
  onDecide,
  armMs = PROMPT_ARM_MS,
}: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const all = useMemo(
    () => inboxItems(sessions, prompts, showProbes),
    [sessions, prompts, showProbes],
  );
  // The item focus is in, or was in when it left the page; null once focus has gone elsewhere.
  const [current, setCurrent] = useState<string | null>(null);
  const order = useFrozenOrder(
    all.map((i) => i.id),
    current !== null,
  );
  const byId = new Map(all.map((i) => [i.id, i]));
  const shown = order.flatMap((id) => byId.get(id) ?? []);
  const waits = shown.filter((i) => i.kind !== 'stuck');
  const stuck = shown.filter((i) => i.kind === 'stuck');
  const ids = [...waits, ...stuck].map((i) => i.id);
  const key = ids.join('\n');
  // The prompts in their places: an item that leaves moves the ones under it up.
  const armed = useArmed(
    [...waits, ...stuck]
      .map((i) => `${i.id} ${'prompt' in i ? i.prompt.request.id : ''}`)
      .join('\n'),
    armMs,
    waits.some((i) => 'prompt' in i),
  );
  const stop = current !== null && ids.includes(current) ? current : (ids[0] ?? null);

  // On arrival, and when a notification names another item, focus starts on its item, else the
  // first: the keys work at once.
  const placed = useRef<{ at: string | null } | null>(null);
  useLayoutEffect(() => {
    if (!loaded || placed.current?.at === at) return;
    placed.current = { at };
    const target = [...waits, ...stuck].find((i) => i.session.id === at) ?? waits[0] ?? stuck[0];
    if (target) itemEl(ref.current, target.id)?.focus();
  });

  // The item focus was in has left (answered, or no longer waiting): focus goes to the item now
  // in its place, else the last one, else the page's heading; not if focus is elsewhere by now.
  const before = useRef(ids);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names the items in their order
  useLayoutEffect(() => {
    const was = before.current;
    before.current = ids;
    if (current === null || ids.includes(current)) return;
    const active = document.activeElement;
    if (active && active !== document.body && !ref.current?.contains(active)) {
      setCurrent(null);
      return;
    }
    const next = ids[Math.min(Math.max(was.indexOf(current), 0), ids.length - 1)];
    if (next) itemEl(ref.current, next)?.focus();
    else {
      setCurrent(null);
      heading.current?.focus();
    }
  }, [key]);

  // The keys (`KEYMAP`): j and k from wherever focus is, onto the list from outside it; y, n and
  // o for the item focus is in, pressing the button that says the key, so an answer not armed
  // yet, or already sent, is not sent by a key either.
  const focusedItem = () =>
    (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-item]') ?? null;
  const move = (by: 1 | -1) => {
    const items = itemsIn(ref.current);
    const item = focusedItem();
    const i = item ? items.indexOf(item) : -1;
    const next = i < 0 ? (stop ? itemEl(ref.current, stop) : null) : items[i + by];
    next?.focus();
  };
  const press = (key: 'y' | 'n') =>
    focusedItem()?.querySelector<HTMLButtonElement>(`button[aria-keyshortcuts="${key}"]`)?.click();
  useCommand('nextPrompt', () => move(1));
  useCommand('previousPrompt', () => move(-1));
  useCommand('allowItem', () => press('y'));
  useCommand('denyItem', () => press('n'));
  useCommand('openItem', () => {
    const id = focusedItem()?.dataset.session;
    if (id) onOpen(id);
  });

  const onFocus = (e: FocusEvent<HTMLDivElement>) =>
    setCurrent((e.target as HTMLElement).closest<HTMLElement>('[data-item]')?.dataset.item ?? null);
  // Gone elsewhere on the page: the order may move again. Lost to nothing (a click on blank
  // space, the window left, the item removed), it holds.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && !ref.current?.contains(next)) setCurrent(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>('[data-item]');
    if (!item) return;
    if (e.key === 'Escape') {
      if (target === item) return;
      e.preventDefault();
      item.focus();
      return;
    }
    // Inside an item its controls keep their keys: a question's options move with the arrows.
    if (target !== item) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      item.querySelector<HTMLButtonElement>('button[data-kind="primary"]')?.click();
      return;
    }
    const items = itemsIn(ref.current);
    const i = items.indexOf(item);
    const next =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? Math.min(i + 1, items.length - 1)
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? Math.max(i - 1, 0)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };

  if (!loaded)
    return (
      <Delayed>
        <p className={css.placeholder}>{t('home.connecting')}</p>
      </Delayed>
    );

  const list = (of: InboxItem[]) => (
    <ul className={css.items}>
      {of.map((item) => (
        <li key={item.id}>
          <Item
            item={item}
            armed={armed}
            now={now}
            tabIndex={item.id === stop ? 0 : -1}
            onOpen={onOpen}
            onDecide={onDecide}
          />
        </li>
      ))}
    </ul>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the items' keys, gathered where they meet
    <div className={css.inbox} ref={ref} onFocus={onFocus} onBlur={onBlur} onKeyDown={onKeyDown}>
      <div className={css.top}>
        <h1 ref={heading} tabIndex={-1}>
          {t('nav.inbox')}
        </h1>
        <p className={css.keys}>{t('inbox.keys')}</p>
      </div>
      <section className={css.section} aria-labelledby="inbox-needsYou">
        <div className={css.header}>
          <h2 id="inbox-needsYou">{t('home.needsYou')}</h2>
          <span
            className={`${css.count} figure`}
            data-attention={waits.length > 0 ? '' : undefined}
          >
            {waits.length}
          </span>
        </div>
        {waits.length > 0 ? list(waits) : <p className={css.none}>{t('home.nothingWaiting')}</p>}
      </section>
      {stuck.length > 0 && (
        <section className={css.section} aria-labelledby="inbox-stuck">
          <div className={css.header}>
            <h2 id="inbox-stuck">{t('inbox.stuck')}</h2>
            <span className={`${css.count} figure`}>{stuck.length}</span>
          </div>
          {list(stuck)}
        </section>
      )}
    </div>
  );
}

/** An item's name, as a screen reader hears it on arrival: what it is, and whose. */
function itemName(t: T, item: InboxItem): string {
  const title = item.session.title ?? t('sidebar.untitled');
  if (item.kind === 'permission')
    return t('home.decide', { tool: item.prompt.request.toolName, title });
  if (item.kind === 'question') return t('home.question', { title });
  if (item.kind === 'plan') return t('home.plan', { title });
  if (item.kind === 'stuck') return t('inbox.stuckItem', { title });
  return `${waitLabel(t, item.session.activity)} · ${title}`;
}

interface ItemProps {
  item: InboxItem;
  armed: boolean;
  now: number;
  tabIndex: 0 | -1;
  onOpen(sessionId: string): void;
  onDecide?: Props['onDecide'];
}

/**
 * One item: the session (its agent, its project and title, a link to it), what it waits for or
 * is doing, then what there is to do about it.
 */
function Item({ item, armed, now, tabIndex, onOpen, onDecide }: ItemProps) {
  const { t } = useI18n();
  const s = item.session;
  const title = s.title ?? t('sidebar.untitled');
  // A plain click opens the session here, as Home's rows do; a modified one is the browser's.
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(s.id);
  };
  const since = waitingSince(s);
  const answer =
    'prompt' in item ? (
      <Answer
        key={item.prompt.request.id}
        session={s}
        prompt={item.prompt}
        armed={armed}
        inline
        onDecide={onDecide}
        onOpen={onOpen}
      />
    ) : null;
  return (
    <article
      className={css.item}
      data-item={item.id}
      data-session={s.id}
      data-kind={item.kind}
      tabIndex={tabIndex}
      aria-label={itemName(t, item)}
    >
      <div className={css.head}>
        <AgentTag kind={s.agent} />
        <a className={css.title} href={sessionLink(s.id)} title={s.cwd ?? undefined} onClick={open}>
          {s.project && <span className={css.project}>{s.project} / </span>}
          {title}
        </a>
      </div>
      <div className={css.what}>
        {item.kind === 'plan' ? (
          // An ExitPlanMode prompt is a plan to approve, not a tool's permission.
          <span className={css.state}>
            <LiveDot state="waiting" />
            <span>{t('inbox.plan')}</span>
            {since && (
              <>
                <span className={css.sep}> · </span>
                <Ticking since={since} labelKey="activity.elapsed" />
              </>
            )}
          </span>
        ) : (
          <ActivityLine session={s} density="card" />
        )}
        {item.kind === 'terminal' && (
          <>
            <span className={css.sep}> · </span>
            <span>
              {t(waitKind(s.activity) === 'turn' ? 'inbox.writeInTerminal' : 'inbox.inTerminal')}
            </span>
          </>
        )}
      </div>
      {item.kind === 'permission' && (
        <div className={css.summary}>
          <ToolSummary request={item.prompt.request} />
        </div>
      )}
      {answer}
      {item.kind === 'terminal' && <Resume session={s} onOpen={onOpen} />}
      {item.kind === 'stuck' && (
        <div className={css.actions}>
          <span className={css.sign}>
            <TroubleLine signal={item.sign} now={now} form="long" />
          </span>
          <OpenButton id={s.id} onOpen={onOpen} />
        </div>
      )}
    </article>
  );
}

function OpenButton({ id, onOpen }: { id: string; onOpen(sessionId: string): void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={promptCss.button}
      data-size="small"
      data-kind="primary"
      aria-keyshortcuts="o"
      onClick={() => onOpen(id)}
    >
      {t('home.open')}
    </button>
  );
}

/**
 * A terminal's wait is answered there: the line that resumes the session in its CLI, and Copy;
 * Open alone for a CLI whose command glassbox does not know.
 */
function Resume({ session, onOpen }: { session: SessionSummary; onOpen(sessionId: string): void }) {
  const { t } = useI18n();
  const command = resumeCommand(session);
  const [said, setSaid] = useState<'copied' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!command)
    return (
      <div className={css.actions}>
        <OpenButton id={session.id} onOpen={onOpen} />
      </div>
    );
  const copy = async () => {
    let result: 'copied' | 'failed' = 'copied';
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // No clipboard (permissions, an insecure context): say so rather than nothing.
      result = 'failed';
    }
    setSaid(result);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), SAID_MS);
  };
  return (
    <div className={css.actions}>
      <code className={css.command} title={command}>
        {command}
      </code>
      <button
        type="button"
        className={promptCss.button}
        data-size="small"
        data-kind="primary"
        onClick={() => void copy()}
      >
        {said === 'copied' ? (
          <Check size={12} aria-hidden="true" />
        ) : (
          <Copy size={12} aria-hidden="true" />
        )}
        {t(
          said === 'copied'
            ? 'inbox.copied'
            : said === 'failed'
              ? 'inbox.copyFailed'
              : 'inbox.copy',
        )}
      </button>
    </div>
  );
}

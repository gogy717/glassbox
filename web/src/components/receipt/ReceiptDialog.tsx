import { AlignLeft, Copy, Download } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useMemo, useState } from 'react';
import { type WeekWindowKind, weekWindow } from '../../../../src/shared/week.js';
import { useApprovalsContext } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { type Locale, useI18n } from '../../i18n';
import { loadPrefs } from '../../prefs';
import { Modal } from '../Modal';
import { Switch } from '../Switch';
import { receiptData } from './data';
import { copyOrDownload, download, fileName, rasterize, svgUrl, weekFileName } from './exportImage';
import { clock } from './format';
import css from './ReceiptDialog.module.css';
import { useWeeks } from './readWeek';
import { type ReceiptKey, rt } from './strings';
import { type Paper, type ReceiptOptions, type ReceiptSize, receiptSvg, SCALE } from './svg';
import { receiptText } from './text';
import { HINT_MS, isQuiet, listedOnly, weekAge, weekReceipt } from './week';
import { elapsedWords, stubSvg, type WeekElsewhere, weekSvg, windowLine } from './weekSvg';
import { weekText } from './weekText';

/** The choices, remembered; paper and language follow the app until one is picked. */
interface Choices {
  size: ReceiptSize;
  paper: Paper | null;
  locale: Locale | null;
  hideNames: boolean;
}

const KEY = 'glassbox.receipt';

/** Storage can be unavailable (private windows, blocked site data); the choices then last a visit. */
export function loadChoices(): Choices {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Choices> | null;
    return {
      size: raw?.size === 'post' || raw?.size === 'story' ? raw.size : 'tall',
      paper: raw?.paper === 'paper' || raw?.paper === 'night' ? raw.paper : null,
      locale: raw?.locale === 'en' || raw?.locale === 'zh' ? raw.locale : null,
      hideNames: raw?.hideNames === true,
    };
  } catch {
    return { size: 'tall', paper: null, locale: null, hideNames: false };
  }
}

function saveChoices(c: Choices): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Not remembered; the choice still applies now.
  }
}

/** Night when the app is dark (set, or by the system), paper otherwise. */
function themePaper(): Paper {
  const set = document.documentElement.dataset.theme;
  if (set === 'dark' || set === 'light') return set === 'dark' ? 'night' : 'paper';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'paper';
}

/** The choices and what they resolve to, and the line that reports what an action did. */
function useChoices() {
  const { locale: appLocale } = useI18n();
  const [choices, setChoices] = useState(loadChoices);
  const [status, setStatus] = useState('');
  const choose = (change: Partial<Choices>) => {
    const next = { ...choices, ...change };
    setChoices(next);
    saveChoices(next);
    setStatus('');
  };
  const options: ReceiptOptions = useMemo(
    () => ({
      paper: choices.paper ?? themePaper(),
      locale: choices.locale ?? appLocale,
      hideNames: choices.hideNames,
    }),
    [choices.paper, choices.locale, choices.hideNames, appLocale],
  );
  const ui = (key: ReceiptKey, params?: Record<string, string | number>) =>
    rt(appLocale, key, params);
  return { appLocale, choices, choose, options, status, setStatus, ui };
}

type Chosen = ReturnType<typeof useChoices>;

interface SheetProps extends Chosen {
  label: string;
  subtitle: string;
  image: { svg: string; width: number; height: number };
  alt: string;
  /** The receipt as text: the image's description, and what "Copy as text" copies. */
  text: string;
  name: string;
  /** Null when the receipt can be printed; else why the actions are off. */
  blocked: string | null;
  /** Choices above the shared ones: the scope. */
  above?: ReactNode;
  /** What Hide names withholds, said under it. */
  namesHint: string;
  /** The line under the actions. */
  note: ReactNode;
  /** The image is the stub printed while reading: shown at a slip's size, without its size. */
  stub?: boolean;
  /** Said at once to a screen reader, as well as shown: the week could not be read. */
  alert?: string | null;
  onClose(): void;
  returnFocusTo: RefObject<HTMLElement | null>;
}

/**
 * The receipt sheet: the image at its chosen size on the left, the choices and actions on the
 * right. Everything is drawn here, in the browser; nothing is sent anywhere.
 */
function Sheet(p: SheetProps) {
  const { choices, choose, options, status, setStatus, ui, image } = p;
  const url = useMemo(() => svgUrl(image.svg), [image.svg]);
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const fail = (err: unknown) => setStatus(ui('failed', { msg: message(err) }));
  const save = () =>
    rasterize(image.svg, image.width, image.height)
      .then((png) => {
        download(png, p.name);
        setStatus(ui('downloaded'));
      })
      .catch(fail);
  const copy = () =>
    copyOrDownload(rasterize(image.svg, image.width, image.height), p.name)
      .then((how) => setStatus(ui(how === 'copied' ? 'copied' : 'copyFellBack')))
      .catch(fail);
  const copyText = () => {
    try {
      navigator.clipboard
        .writeText(p.text)
        .then(() => setStatus(ui('copiedText')))
        .catch((err: unknown) => setStatus(ui('textFailed', { msg: message(err) })));
    } catch (err) {
      setStatus(ui('textFailed', { msg: message(err) }));
    }
  };
  // Off but still focusable, so the reason is heard.
  const action = (run: () => unknown) => ({
    'aria-disabled': p.blocked !== null || undefined,
    title: p.blocked ?? undefined,
    onClick: () => {
      if (p.blocked === null) void run();
    },
  });

  return (
    <Modal
      label={p.label}
      onClose={p.onClose}
      returnFocusTo={p.returnFocusTo}
      subtitle={p.subtitle}
    >
      <div className={css.body}>
        <figure className={css.preview}>
          <img
            src={url}
            alt={p.alt}
            aria-describedby="receipt-text"
            className={css.image}
            data-size={choices.size}
            data-stub={p.stub || undefined}
          />
          {!p.stub && (
            <figcaption className={`${css.dims} figure`}>
              {`${image.width * SCALE} × ${image.height * SCALE}`}
            </figcaption>
          )}
          <pre id="receipt-text" className="visually-hidden">
            {p.text}
          </pre>
        </figure>
        <div className={css.side}>
          {p.above}
          <div className={css.field}>
            <span className="section-label">{ui('size')}</span>
            <Switch
              label={ui('size')}
              value={choices.size}
              onChange={(size) => choose({ size })}
              options={[
                { value: 'tall', label: ui('tall') },
                { value: 'post', label: ui('post') },
                { value: 'story', label: ui('story') },
              ]}
            />
          </div>
          <div className={css.field}>
            <span className="section-label">{ui('paper')}</span>
            <Switch
              label={ui('paper')}
              value={options.paper}
              onChange={(paper) => choose({ paper })}
              options={[
                { value: 'paper', label: ui('paperPaper') },
                { value: 'night', label: ui('paperNight') },
              ]}
            />
          </div>
          <div className={css.field}>
            <span className="section-label">{ui('language')}</span>
            <Switch
              label={ui('language')}
              value={options.locale}
              onChange={(locale) => choose({ locale })}
              options={[
                { value: 'en', label: 'English' },
                { value: 'zh', label: '中文' },
              ]}
            />
          </div>
          <div className={css.field}>
            <span className={css.toggleName}>{ui('hideNames')}</span>
            <span className={css.hint}>{p.namesHint}</span>
            <Switch
              label={ui('hideNames')}
              value={choices.hideNames ? 'on' : 'off'}
              onChange={(v) => choose({ hideNames: v === 'on' })}
              options={[
                { value: 'off', label: ui('off') },
                { value: 'on', label: ui('on') },
              ]}
            />
          </div>
          <div className={css.actions}>
            <button type="button" className={css.primary} {...action(copy)}>
              <Copy size={14} aria-hidden="true" />
              {ui('copyImage')}
            </button>
            <button type="button" className={css.button} {...action(save)}>
              <Download size={14} aria-hidden="true" />
              {ui('download')}
            </button>
            <button type="button" className={css.button} {...action(copyText)}>
              <AlignLeft size={14} aria-hidden="true" />
              {ui('copyText')}
            </button>
            {p.alert && (
              <p className={css.alert} role="alert">
                {p.alert}
              </p>
            )}
            <p className={css.status} role="status">
              {status}
            </p>
            <p className={css.local}>{p.note}</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** What the receipt prints: the session it was opened from, this week, or the last 7 days. */
type Scope = 'session' | WeekWindowKind;

interface Props {
  onClose(): void;
  /** The button that opened it: focus goes back to it on close. */
  returnFocusTo: RefObject<HTMLElement | null>;
  /** Probe sessions count in a week only when the sidebar shows them. */
  showProbes?: boolean;
}

/**
 * A session's receipt, from its Receipt button: on This session, the weeks one switch away. Its
 * weeks count probe sessions as the sidebar does, by the saved preference.
 */
export function ReceiptDialog(props: Props & { open: OpenSession }) {
  const [showProbes] = useState(() => props.showProbes ?? loadPrefs().showProbes);
  return <ReceiptSheet {...props} showProbes={showProbes} start="session" />;
}

/** The weekly receipt, from the Stats page: on the window it shows, the other one switch away. */
export function WeeklyReceiptDialog(props: Props & { start?: WeekWindowKind }) {
  return <ReceiptSheet {...props} start={props.start ?? 'week'} />;
}

/** What the sheet shows for a scope. */
type Shown = Pick<
  SheetProps,
  | 'label'
  | 'subtitle'
  | 'image'
  | 'alt'
  | 'text'
  | 'name'
  | 'blocked'
  | 'note'
  | 'stub'
  | 'alert'
  | 'namesHint'
> & { hint?: string | null };

/**
 * The weekly receipt for `kind` (nothing while the sheet shows a session): the window read as
 * it streams, a stub while it is, the receipt once it is.
 */
function useWeekSheet(
  kind: WeekWindowKind | null,
  chosen: Chosen,
  showProbes: boolean,
): Shown | null {
  const { choices, options, ui, appLocale } = chosen;
  const weeks = useWeeks();
  const { states, ensure, read } = weeks;
  useEffect(() => {
    if (kind) ensure(kind);
  }, [ensure, kind]);

  const state = kind ? states[kind] : undefined;
  const ready = useMemo(
    () => (state?.phase === 'ready' ? listedOnly(state.result, showProbes) : null),
    [state, showProbes],
  );
  const week = useMemo(() => (ready ? weekReceipt(ready) : null), [ready]);
  // An empty or quiet week, or one under a day old, points to the last 7 days: read them too.
  const wantsElsewhere =
    week?.kind === 'week' && (week.sessions === 0 || isQuiet(week) || weekAge(week) < HINT_MS);
  useEffect(() => {
    if (wantsElsewhere) ensure('7d');
  }, [ensure, wantsElsewhere]);
  const other = states['7d'];
  const elsewhere: WeekElsewhere | null = useMemo(() => {
    if (other?.phase !== 'ready') return null;
    const r = listedOnly(other.result, showProbes);
    return {
      sessions: r.sessions.length,
      agentMs: r.sessions.reduce((n, s) => n + s.inWindow.agentMs, 0),
    };
  }, [other, showProbes]);

  const failed = state?.phase === 'failed' ? state.msg : null;
  const done = state?.phase === 'reading' ? state.done : 0;
  const total = state?.phase === 'reading' ? state.total : 0;
  // Until the week is read, its window as the server counts it; then as the receipt prints it.
  const start = kind ? (week?.start ?? weekWindow(kind, Date.now()).hourStarts[0] ?? 0) : 0;
  const end = week?.now ?? Date.now();
  const line = (L: Locale) => (kind ? windowLine(kind, start, end, L, (k) => rt(L, k)) : '');
  const stubLine = line(options.locale);
  const image = useMemo(
    () =>
      !kind
        ? null
        : week
          ? weekSvg(week, options, choices.size, elsewhere)
          : stubSvg(
              options,
              stubLine,
              failed !== null ? { failed } : { done, total },
              choices.size,
            ),
    [kind, week, options, choices.size, elsewhere, stubLine, failed, done, total],
  );
  const text = useMemo(
    () => (week ? weekText(week, options, elsewhere) : ''),
    [week, options, elsewhere],
  );
  if (!kind || !image) return null;

  const refreshing = weeks.refreshing[kind];
  const updating = weeks.updating[kind];
  const refreshFailed = weeks.refreshFailed[kind];
  // Chinese runs its sentences on without a space.
  const gap = appLocale === 'zh' ? '' : ' ';
  const again = (
    <button type="button" className={css.link} onClick={() => read(kind, week !== null)}>
      {ui('refresh')}
    </button>
  );
  return {
    label: ui('weeklyDialog'),
    subtitle: week ? ui('subtitle', { line: line(appLocale), n: week.sessions }) : line(appLocale),
    image,
    alt:
      failed !== null
        ? ui('weekFailed', { msg: failed })
        : week
          ? ui('weekPreview', { w: image.width * SCALE, h: image.height * SCALE })
          : ui('readingPreview', { done, total }),
    alert: failed !== null ? ui('weekFailed', { msg: failed }) : null,
    text,
    name: week ? weekFileName(week) : 'glassbox-week.png',
    blocked:
      failed !== null
        ? ui('weekFailed', { msg: failed })
        : !week
          ? ui('reading', { done, total })
          : week.sessions === 0
            ? ui('nothing')
            : null,
    stub: !week,
    note: !week ? (
      failed !== null ? (
        again
      ) : (
        ui('readingNote')
      )
    ) : refreshing ? (
      <>
        {ui('reading', refreshing)}
        {gap}
        {ui('localWeek')}
      </>
    ) : updating ? (
      // Read before, read again on opening (R30): the slip as of then, its actions on.
      <>
        {ui('asOf', { time: clock(week.now) })} · {ui('updating')}
        {gap}
        {ui('localWeek')}
      </>
    ) : (
      <>
        {refreshFailed !== undefined
          ? ui('weekFailed', { msg: refreshFailed })
          : ui('asOf', { time: clock(week.now) })}{' '}
        {/* Read before, not again this time: in the receipt, older than the time beside it. */}
        {ready && ready.stats.failed > 0 && <>· {ui('notRefreshed', { n: ready.stats.failed })} </>}
        · {again}
        {ui('stop')}
        {gap}
        {ui('localWeek')}
      </>
    ),
    namesHint: ui('hideNamesHintWeek'),
    hint:
      week?.kind === 'week' && weekAge(week) < HINT_MS && elsewhere
        ? ui('mondayHint', {
            elapsed: elapsedWords(weekAge(week), (k, q) => ui(k, q)),
            n: elsewhere.sessions,
          })
        : null,
  };
}

/**
 * The receipt dialog of both entries: a session's Receipt button starts it on This session,
 * Home on This week. The Scope switch swaps the slip in place; the other choices carry across,
 * and the scope is not remembered: where it starts is the entry's to say.
 */
function ReceiptSheet({
  open,
  start,
  onClose,
  returnFocusTo,
  showProbes = false,
}: Props & { open?: OpenSession; start: Scope }) {
  const chosen = useChoices();
  const { choices, options, ui, setStatus } = chosen;
  const [scope, setScope] = useState<Scope>(start);
  const approvals = useApprovalsContext();
  // The session as it was when the dialog opened, read once: a running session's receipt says
  // "now" for then, and a live update can never redraw it past the time it prints.
  const [data] = useState(() => (open ? receiptData(open, Date.now(), approvals) : null));
  const session = scope === 'session' ? data : null;
  const sessionImage = useMemo(
    () => (session ? receiptSvg(session, options, choices.size) : null),
    [session, options, choices.size],
  );
  const sessionText = useMemo(
    () => (session ? receiptText(session, options) : ''),
    [session, options],
  );
  const weekShown = useWeekSheet(scope === 'session' ? null : scope, chosen, showProbes);
  const shown: Shown | null =
    session && sessionImage
      ? {
          label: ui('dialog'),
          subtitle: [session.project, session.title].filter(Boolean).join(' / '),
          image: sessionImage,
          alt: ui('preview', { w: sessionImage.width * SCALE, h: sessionImage.height * SCALE }),
          text: sessionText,
          name: fileName(session, options.hideNames),
          blocked: null,
          note: ui('local'),
          namesHint: ui('hideNamesHint'),
        }
      : weekShown;
  if (!shown) return null;
  const scopes: Scope[] = data ? ['session', 'week', '7d'] : ['week', '7d'];
  const scopeName: Record<Scope, ReceiptKey> = {
    session: 'thisSession',
    week: 'thisWeek',
    '7d': 'last7',
  };
  return (
    <Sheet
      {...chosen}
      {...shown}
      above={
        <div className={css.field}>
          <span className="section-label">{ui('scope')}</span>
          <Switch
            label={ui('scope')}
            value={scope}
            onChange={(next) => {
              setScope(next);
              setStatus('');
            }}
            options={scopes.map((value) => ({ value, label: ui(scopeName[value]) }))}
          />
          {shown.hint && <span className={css.hint}>{shown.hint}</span>}
        </div>
      }
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    />
  );
}

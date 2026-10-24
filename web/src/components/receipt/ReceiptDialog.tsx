import { AlignLeft, Copy, Download } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useMemo, useState } from 'react';
import { type WeekResult, type WeekWindowKind, weekWindow } from '../../../../src/shared/week.js';
import { useApprovalsContext } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { type Locale, useI18n } from '../../i18n';
import { isListed } from '../../lib/sessions';
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
import { HINT_MS, isQuiet, weekAge, weekReceipt } from './week';
import { elapsedWords, stubSvg, type WeekElsewhere, weekSvg, windowLine } from './weekSvg';
import { weekText } from './weekText';

/** The choices, remembered; paper and language follow the app until one is picked. */
interface Choices {
  size: ReceiptSize;
  paper: Paper | null;
  locale: Locale | null;
  hideNames: boolean;
  /** The weekly receipt's window. */
  window: WeekWindowKind;
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
      window: raw?.window === '7d' ? '7d' : 'week',
    };
  } catch {
    return { size: 'tall', paper: null, locale: null, hideNames: false, window: 'week' };
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
  /** Choices above the shared ones (the weekly receipt's window). */
  above?: ReactNode;
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
            <span className={css.hint}>{ui('hideNamesHint')}</span>
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

interface Props {
  open: OpenSession;
  onClose(): void;
  /** The Receipt button: focus goes back to it on close. */
  returnFocusTo: RefObject<HTMLElement | null>;
}

/** The session's receipt, drawn from the open session. */
export function ReceiptDialog({ open, onClose, returnFocusTo }: Props) {
  const chosen = useChoices();
  const { choices, options, ui } = chosen;
  const approvals = useApprovalsContext();
  // The session as it was when the dialog opened, read once: a running session's receipt says
  // "now" for then, and a live update can never redraw it past the time it prints.
  const [data] = useState(() => receiptData(open, Date.now(), approvals));
  const image = useMemo(
    () => receiptSvg(data, options, choices.size),
    [data, options, choices.size],
  );
  const text = useMemo(() => receiptText(data, options), [data, options]);
  return (
    <Sheet
      {...chosen}
      label={ui('dialog')}
      subtitle={[data.project, data.title].filter(Boolean).join(' / ')}
      image={image}
      alt={ui('preview', { w: image.width * SCALE, h: image.height * SCALE })}
      text={text}
      name={fileName(data, options.hideNames)}
      blocked={null}
      note={ui('local')}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    />
  );
}

/** The result without the sessions the sidebar hides: probes, unless it shows them (A1). */
const listedOnly = (r: WeekResult, showProbes: boolean): WeekResult => ({
  ...r,
  sessions: r.sessions.filter((s) => isListed(s, showProbes)),
});

/** The weekly receipt: every session of the window, read by the server once and summed here. */
export function WeeklyReceiptDialog({
  onClose,
  returnFocusTo,
  showProbes = false,
}: Omit<Props, 'open'> & { showProbes?: boolean }) {
  const chosen = useChoices();
  const { choices, choose, options, ui, appLocale } = chosen;
  const kind = choices.window;
  const { states, refreshing, refreshFailed, ensure, read } = useWeeks();
  useEffect(() => ensure(kind), [ensure, kind]);

  const state = states[kind];
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

  // Until the week is read, its window as the server counts it; then as the receipt prints it.
  const start = week?.start ?? weekWindow(kind, Date.now()).hourStarts[0] ?? 0;
  const end = week?.now ?? Date.now();
  const line = (L: Locale) => windowLine(kind, start, end, L, (k) => rt(L, k));
  const failed = state?.phase === 'failed' ? state.msg : null;
  const done = state?.phase === 'reading' ? state.done : 0;
  const total = state?.phase === 'reading' ? state.total : 0;
  const stubLine = line(options.locale);
  const image = useMemo(
    () =>
      week
        ? weekSvg(week, options, choices.size, elsewhere)
        : stubSvg(options, stubLine, failed !== null ? { failed } : { done, total }, choices.size),
    [week, options, choices.size, elsewhere, stubLine, failed, done, total],
  );
  const text = useMemo(
    () => (week ? weekText(week, options, elsewhere) : ''),
    [week, options, elsewhere],
  );

  const blocked =
    failed !== null
      ? ui('weekFailed', { msg: failed })
      : !week
        ? ui('reading', { done, total })
        : week.sessions === 0
          ? ui('nothing')
          : null;
  const hint =
    week?.kind === 'week' && weekAge(week) < HINT_MS && elsewhere
      ? ui('mondayHint', {
          elapsed: elapsedWords(weekAge(week), (k, q) => ui(k, q)),
          n: elsewhere.sessions,
        })
      : null;
  // Chinese runs its sentences on without a space.
  const gap = appLocale === 'zh' ? '' : ' ';
  const again = (
    <button type="button" className={css.link} onClick={() => read(kind, week !== null)}>
      {ui('refresh')}
    </button>
  );
  const note = !week ? (
    failed !== null ? (
      again
    ) : (
      ui('readingNote')
    )
  ) : refreshing ? (
    <>
      {ui('reading', refreshing)}
      {gap}
      {ui('local')}
    </>
  ) : (
    <>
      {refreshFailed !== null
        ? ui('weekFailed', { msg: refreshFailed })
        : ui('asOf', { time: clock(week.now) })}{' '}
      · {again}
      {ui('stop')}
      {gap}
      {ui('local')}
    </>
  );

  return (
    <Sheet
      {...chosen}
      label={ui('weeklyDialog')}
      subtitle={
        week ? ui('subtitle', { line: line(appLocale), n: week.sessions }) : line(appLocale)
      }
      image={image}
      alt={
        failed !== null
          ? ui('weekFailed', { msg: failed })
          : week
            ? ui('weekPreview', { w: image.width * SCALE, h: image.height * SCALE })
            : ui('readingPreview', { done, total })
      }
      alert={failed !== null ? ui('weekFailed', { msg: failed }) : null}
      text={text}
      name={week ? weekFileName(week) : 'glassbox-week.png'}
      blocked={blocked}
      stub={!week}
      above={
        <div className={css.field}>
          <span className="section-label">{ui('window')}</span>
          <Switch
            label={ui('window')}
            value={kind}
            onChange={(window) => choose({ window })}
            options={[
              { value: 'week', label: ui('thisWeek') },
              { value: '7d', label: ui('last7') },
            ]}
          />
          {hint && <span className={css.hint}>{hint}</span>}
        </div>
      }
      note={note}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    />
  );
}

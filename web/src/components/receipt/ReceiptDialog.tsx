import { AlignLeft, Copy, Download } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { weekWindow } from '../../../../src/server/week-buckets.js';
import {
  type WeekLine,
  type WeekResult,
  type WeekWindowKind,
  weekPath,
} from '../../../../src/shared/week.js';
import { useApprovalsContext } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { type Locale, useI18n } from '../../i18n';
import { Modal } from '../Modal';
import { Switch } from '../Switch';
import { receiptData } from './data';
import { copyOrDownload, download, fileName, rasterize, svgUrl, weekFileName } from './exportImage';
import { clock, shortDay } from './format';
import css from './ReceiptDialog.module.css';
import { type ReceiptKey, rt } from './strings';
import { type Paper, type ReceiptOptions, type ReceiptSize, receiptSvg, SCALE } from './svg';
import { receiptText } from './text';
import { QUIET_MS, weekAge, weekReceipt } from './week';
import { elapsedWords, stubSvg, type WeekElsewhere, weekSvg } from './weekSvg';
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
  /** The image is the stub printed while reading: shown at a slip's size. */
  stub?: boolean;
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
          <figcaption className={`${css.dims} figure`}>
            {`${image.width * SCALE} × ${image.height * SCALE}`}
          </figcaption>
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

/** One window's data: being read (how far), read, or not readable. */
type WeekState =
  | { phase: 'reading'; done: number; total: number }
  | { phase: 'ready'; result: WeekResult }
  | { phase: 'failed'; msg: string };

/** `/api/week` read to its result, `onProgress` told how far it got on the way. */
export async function readWeek(
  kind: WeekWindowKind,
  refresh: boolean,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<WeekResult> {
  const res = await fetch(weekPath(kind, refresh), { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: WeekResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = JSON.parse(buffer.slice(0, i)) as WeekLine;
      buffer = buffer.slice(i + 1);
      if (line.type === 'progress') onProgress(line.done, line.total);
      else if (line.type === 'result') result = line.result;
      else throw new Error(line.error);
    }
    if (done) break;
  }
  if (!result) throw new Error('no result');
  return result;
}

/** The weekly receipt: every session of the window, read by the server once and summed here. */
export function WeeklyReceiptDialog({ onClose, returnFocusTo }: Omit<Props, 'open'>) {
  const chosen = useChoices();
  const { choices, choose, options, ui, appLocale, setStatus } = chosen;
  const kind = choices.window;
  const [states, setStates] = useState<Partial<Record<WeekWindowKind, WeekState>>>({});
  const [refreshing, setRefreshing] = useState<{ done: number; total: number } | null>(null);
  const aborts = useRef(new Set<AbortController>());
  useEffect(() => {
    const live = aborts.current;
    return () => {
      for (const a of live) a.abort();
    };
  }, []);

  const read = (k: WeekWindowKind, refresh = false) => {
    const abort = new AbortController();
    aborts.current.add(abort);
    const set = (s: WeekState) => setStates((all) => ({ ...all, [k]: s }));
    if (!refresh) set({ phase: 'reading', done: 0, total: 0 });
    readWeek(
      k,
      refresh,
      (done, total) =>
        refresh ? setRefreshing({ done, total }) : set({ phase: 'reading', done, total }),
      abort.signal,
    )
      .then((result) => set({ phase: 'ready', result }))
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (refresh) setStatus(ui('weekFailed', { msg }));
        else set({ phase: 'failed', msg });
      })
      .finally(() => {
        aborts.current.delete(abort);
        if (refresh) setRefreshing(null);
      });
  };
  const state = states[kind];
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per window, on first sight
  useEffect(() => {
    if (!state) read(kind);
  }, [kind]);

  const ready = state?.phase === 'ready' ? state.result : null;
  const week = useMemo(() => (ready ? weekReceipt(ready) : null), [ready]);
  // A week not a day old (or empty) points to the last 7 days: read them too, to say how many.
  const wantsElsewhere = week?.kind === 'week' && (week.sessions === 0 || weekAge(week) < QUIET_MS);
  const other = states['7d'];
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, when first wanted
  useEffect(() => {
    if (wantsElsewhere && !other) read('7d');
  }, [wantsElsewhere]);
  const elsewhere: WeekElsewhere | null = useMemo(
    () =>
      other?.phase === 'ready'
        ? {
            sessions: other.result.sessions.length,
            agentMs: other.result.sessions.reduce((n, s) => n + s.inWindow.activeMs, 0),
          }
        : null,
    [other],
  );

  const start = ready?.window.hourStarts[0] ?? weekWindow(kind, Date.now()).hourStarts[0] ?? 0;
  const from = (L: Locale) => `${shortDay(start, L)}${kind === '7d' ? ` ${clock(start)}` : ''}`;
  const span = (L: Locale) =>
    `${rt(L, kind === 'week' ? 'thisWeek' : 'last7')} · ${from(L)} → ${rt(L, 'now')}`;
  const stubLine = span(options.locale);
  const progress = state?.phase === 'reading' ? state : { done: 0, total: 0 };
  const image = useMemo(
    () =>
      week
        ? weekSvg(week, options, choices.size, elsewhere)
        : stubSvg(options, stubLine, progress.done, progress.total, choices.size),
    [week, options, choices.size, elsewhere, stubLine, progress.done, progress.total],
  );
  const text = useMemo(
    () => (week ? weekText(week, options, elsewhere) : ''),
    [week, options, elsewhere],
  );

  const subtitle = ready
    ? ui('subtitle', {
        window: ui(kind === 'week' ? 'thisWeek' : 'last7'),
        from: from(appLocale),
        n: ready.sessions.length,
      })
    : span(appLocale);
  const blocked =
    state?.phase === 'failed'
      ? ui('weekFailed', { msg: state.msg })
      : !week
        ? ui('reading', progress)
        : week.sessions === 0
          ? ui('nothing')
          : null;
  const hint =
    week?.kind === 'week' && weekAge(week) < QUIET_MS && elsewhere
      ? ui('mondayHint', {
          elapsed: elapsedWords(weekAge(week), (k, q) => ui(k, q)),
          n: elsewhere.sessions,
        })
      : null;
  const refresh = (
    <button type="button" className={css.link} onClick={() => read(kind, !!week)}>
      {ui('refresh')}
    </button>
  );
  const note = week ? (
    <>
      {refreshing ? (
        ui('reading', refreshing)
      ) : (
        <>
          {ui('asOf', { time: clock(week && ready ? ready.asOf : Date.now()) })} · {refresh}.
        </>
      )}{' '}
      {ui('local')}
    </>
  ) : state?.phase === 'failed' ? (
    <>
      {ui('weekFailed', { msg: state.msg })} {refresh}
    </>
  ) : (
    ui('readingNote')
  );

  return (
    <Sheet
      {...chosen}
      label={ui('weeklyDialog')}
      subtitle={subtitle}
      image={image}
      alt={
        week
          ? ui('weekPreview', { w: image.width * SCALE, h: image.height * SCALE })
          : ui('readingPreview', progress)
      }
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

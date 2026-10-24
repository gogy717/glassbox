import { AlignLeft, Copy, Download } from 'lucide-react';
import { type RefObject, useMemo, useState } from 'react';
import { useApprovalsContext } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { type Locale, useI18n } from '../../i18n';
import { Modal } from '../Modal';
import { Switch } from '../Switch';
import { receiptData } from './data';
import { canCopyImage, copyImage, download, fileName, rasterize, svgUrl } from './exportImage';
import css from './ReceiptDialog.module.css';
import { rt } from './strings';
import { type Paper, type ReceiptSize, receiptSvg, SCALE } from './svg';
import { receiptText } from './text';

interface Props {
  open: OpenSession;
  onClose(): void;
  /** The Receipt button: focus goes back to it on close. */
  returnFocusTo: RefObject<HTMLElement | null>;
}

/** The four choices, remembered; paper and language follow the app until one is picked. */
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
      size: raw?.size === 'tall' || raw?.size === 'story' ? raw.size : 'post',
      paper: raw?.paper === 'paper' || raw?.paper === 'night' ? raw.paper : null,
      locale: raw?.locale === 'en' || raw?.locale === 'zh' ? raw.locale : null,
      hideNames: raw?.hideNames === true,
    };
  } catch {
    return { size: 'post', paper: null, locale: null, hideNames: false };
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

/**
 * The receipt dialog: the image at its chosen size on the left, the choices and actions on the
 * right. Everything is drawn here, from the open session; nothing is sent anywhere.
 */
export function ReceiptDialog({ open, onClose, returnFocusTo }: Props) {
  const { locale: appLocale } = useI18n();
  const ui = (key: Parameters<typeof rt>[1], params?: Record<string, string | number>) =>
    rt(appLocale, key, params);
  const approvals = useApprovalsContext();
  const [choices, setChoices] = useState(loadChoices);
  const [status, setStatus] = useState('');
  // The figures as of opening the dialog: a running session's receipt says "now" for then.
  const [now] = useState(() => Date.now());
  const choose = (change: Partial<Choices>) => {
    const next = { ...choices, ...change };
    setChoices(next);
    saveChoices(next);
    setStatus('');
  };
  const options = useMemo(
    () => ({
      paper: choices.paper ?? themePaper(),
      locale: choices.locale ?? appLocale,
      hideNames: choices.hideNames,
    }),
    [choices.paper, choices.locale, choices.hideNames, appLocale],
  );
  const data = useMemo(() => receiptData(open, now, approvals), [open, now, approvals]);
  const image = useMemo(
    () => receiptSvg(data, options, choices.size),
    [data, options, choices.size],
  );
  const text = useMemo(() => receiptText(data, options), [data, options]);
  const url = useMemo(() => svgUrl(image.svg), [image.svg]);
  const name = fileName(data, options.hideNames);
  const fail = (err: unknown) =>
    setStatus(ui('failed', { msg: err instanceof Error ? err.message : String(err) }));
  const save = () =>
    rasterize(image.svg, image.width, image.height)
      .then((png) => {
        download(png, name);
        setStatus(ui('downloaded'));
      })
      .catch(fail);
  const copy = () => {
    if (!canCopyImage()) return void save();
    // Made in this click's own turn, the PNG still to come: what Safari needs.
    copyImage(rasterize(image.svg, image.width, image.height))
      .then(() => setStatus(ui('copied')))
      .catch(fail);
  };
  const copyText = () =>
    navigator.clipboard
      .writeText(text)
      .then(() => setStatus(ui('copiedText')))
      .catch(fail);
  const heading = [open.session.project, data.title].filter(Boolean).join(' / ');
  const size = `${image.width * SCALE} × ${image.height * SCALE}`;

  return (
    <Modal label={ui('dialog')} onClose={onClose} returnFocusTo={returnFocusTo} subtitle={heading}>
      <div className={css.body}>
        <figure className={css.preview}>
          <img
            src={url}
            alt={ui('preview', { w: image.width * SCALE, h: image.height * SCALE })}
            aria-describedby="receipt-text"
            className={css.image}
            data-size={choices.size}
          />
          <figcaption className={`${css.dims} figure`}>{size}</figcaption>
          <pre id="receipt-text" className="visually-hidden">
            {text}
          </pre>
        </figure>
        <div className={css.side}>
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
            <button type="button" className={css.primary} onClick={copy}>
              <Copy size={14} aria-hidden="true" />
              {ui('copyImage')}
            </button>
            <button type="button" className={css.button} onClick={() => void save()}>
              <Download size={14} aria-hidden="true" />
              {ui('download')}
            </button>
            <button type="button" className={css.button} onClick={() => void copyText()}>
              <AlignLeft size={14} aria-hidden="true" />
              {ui('copyText')}
            </button>
            <p className={css.status} role="status">
              {status}
            </p>
            <p className={css.local}>{ui('local')}</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

import { useEffect, useId, useMemo, useState } from 'react';
import type { RunPermissionMode, RunState } from '../../../../src/shared/runs.js';
import { Modal } from '../../components/Modal';
import { Tooltip } from '../../components/Tooltip';
import type { RunsClient } from '../../data/runs';
import { useI18n } from '../../i18n';
import { dirPlaceholder, recentDirChoices } from '../../lib/dirs';
import { middleEllipsis } from '../../lib/format';
import css from './Composer.module.css';
import { PermissionModeSelect } from './PermissionModeSelect';

/** The longest folder path a chip shows before it cuts the middle out. */
const DIR_CHARS = 32;

interface Props {
  client: RunsClient;
  onStarted(run: RunState): void;
  onClose(): void;
}

/** Absolute on macOS/Linux or Windows; the server re-checks that it exists. */
const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

export function NewSessionDialog({ client, onStarted, onClose }: Props) {
  const { t } = useI18n();
  const [recent, setRecent] = useState<string[]>([]);
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<RunPermissionMode>('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirId = useId();
  const hintId = useId();

  useEffect(() => {
    let live = true;
    client.directories().then(
      (dirs) => live && setRecent(dirs),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client]);

  const [showTemp, setShowTemp] = useState(false);
  const choices = useMemo(() => recentDirChoices(recent), [recent]);
  const path = cwd.trim();
  const ready = isAbsolute(path) && prompt.trim().length > 0 && !busy;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      onStarted(
        await client.start({ mode: 'new', cwd: path, prompt: prompt.trim(), permissionMode: mode }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // A folder cut in the middle, root and tail kept; the whole path is its tooltip when cut.
  const chip = (d: string) => {
    const shown = middleEllipsis(d, DIR_CHARS);
    const button = (
      <button
        key={d}
        type="button"
        aria-pressed={d === path}
        className={css.dirChip}
        onClick={() => setCwd(d)}
      >
        {shown}
      </button>
    );
    return shown === d ? (
      button
    ) : (
      <Tooltip key={d} label={d} placement="bottom">
        {button}
      </Tooltip>
    );
  };

  return (
    <Modal label={t('newSession.title')} onClose={onClose} size="compact">
      <div className={css.newSession}>
        {(choices.shown.length > 0 || choices.temporary.length > 0) && (
          <div className={css.recent}>
            <span className={css.fieldLabel}>{t('newSession.recent')}</span>
            <div className={css.recentList}>
              {choices.shown.map(chip)}
              {choices.temporary.length > 0 && !showTemp && (
                <button type="button" className={css.moreChip} onClick={() => setShowTemp(true)}>
                  {t('newSession.temporary', { n: choices.temporary.length })}
                </button>
              )}
              {showTemp && choices.temporary.map(chip)}
            </div>
          </div>
        )}
        <div className={css.formField}>
          <label htmlFor={dirId} className={css.fieldLabel}>
            {t('newSession.dir')}
          </label>
          <input
            id={dirId}
            type="text"
            value={cwd}
            spellCheck={false}
            placeholder={dirPlaceholder(recent)}
            aria-describedby={path && !isAbsolute(path) ? hintId : undefined}
            onChange={(e) => setCwd(e.target.value)}
          />
          {path && !isAbsolute(path) && (
            <small id={hintId} className={css.error}>
              {t('newSession.absolute')}
            </small>
          )}
        </div>
        <label className={css.formField}>
          <span className={css.fieldLabel}>{t('newSession.prompt')}</span>
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <div className={css.actions}>
          <PermissionModeSelect value={mode} onChange={setMode} />
          <button
            type="button"
            className={css.button}
            data-kind="primary"
            disabled={!ready}
            onClick={start}
          >
            {t('newSession.start')}
          </button>
        </div>
        {error && <p className={css.error}>{t('newSession.error', { msg: error })}</p>}
      </div>
    </Modal>
  );
}

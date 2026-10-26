import { TriangleAlert } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  MAIN_AGENT_ID,
  type ToolCall,
  type TroubleRef,
  type TroubleSignal,
} from '../../../src/core/model.js';
import { SHELL_TOOLS } from '../../../src/shared/tool-category.js';
import { detectTrouble } from '../../../src/shared/trouble.js';
import type { OpenSession } from '../data/store';
import { translateParts, useI18n } from '../i18n';
import { summarizeInput } from '../lib/tool-category';
import { troublePhrase } from '../lib/trouble';
import type { Navigate, Route } from '../router';
import { useUi } from '../ui';
import { UiCjk } from './CompactFigure';
import { usePopoverDismiss } from './popover';
import css from './Trouble.module.css';

interface Props {
  open: OpenSession;
  /** The breadcrumb's agent: its signs and its running sub-agents'. */
  agentId: string;
  now: number;
  navigate?: Navigate;
}

/** A repeated call as the execution chain sums it up: its command, else the tool and its gist. */
function label(tool: ToolCall): string {
  const gist = summarizeInput(tool);
  if (SHELL_TOOLS.has(tool.name)) return gist || tool.name;
  return gist ? `${tool.name} ${gist}` : tool.name;
}

/** Where a sign's link goes: its call with its card open, a model call's response, a prompt. */
function routeOf(open: OpenSession, ref: TroubleRef): Partial<Route> {
  if (ref.kind === 'turn')
    return { tab: 'flow', agentId: ref.agentId, turnId: ref.turnId, requestId: null };
  return {
    tab: 'flow',
    agentId: ref.agentId,
    turnId: open.requests.get(ref.requestId)?.turnId ?? null,
    requestId: ref.requestId,
    card: ref.kind === 'tool' ? `tool:${ref.toolCallId}` : 'response',
  };
}

/** A sign at length: the call it names in the mono face, its counts as figures. */
function Phrase({ s, now }: { s: TroubleSignal; now: number }) {
  const { t, locale } = useI18n();
  const { k, params } = troublePhrase(t, s, now, 'long');
  return (
    <>
      {translateParts(locale, k, params, ['x', 'n', 'of']).map((p, i) =>
        typeof p === 'string' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <span key={i}>{p}</span>
        ) : p.param === 'x' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <span key={i} className={css.target}>
            <UiCjk text={p.value} />
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text
          <span key={i} className="figure">
            {p.value}
          </span>
        ),
      )}
    </>
  );
}

/**
 * The signs that the agent, or a sub-agent of it still running, is stuck: "No trouble", or "2
 * signs of trouble" with a red dot, opening a list of them, each a link to the call, model call
 * or prompt it points at. Beside Data complete, in its manner.
 */
export function Trouble({ open, agentId, now, navigate }: Props) {
  const { t } = useI18n();
  const { setFollow } = useUi();
  const [shown, setShown] = useState(false);
  const close = useCallback(() => setShown(false), []);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  usePopoverDismiss(ref, shown, close, buttonRef);

  const signals = useMemo(() => detectTrouble(open, agentId, now, label), [open, agentId, now]);
  const count = signals.length > 0 ? t('trouble.count', { n: signals.length }) : t('trouble.none');
  const whose = (id: string) =>
    id === MAIN_AGENT_ID ? t('crumb.main') : (open.agents.get(id)?.label ?? id);
  const go = (at: TroubleRef) => {
    setShown(false);
    setFollow(false);
    navigate?.(routeOf(open, at));
  };

  return (
    <div className={css.wrap} ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className={css.button}
        aria-label={`${t('trouble.title')} · ${count}`}
        title={t('trouble.title')}
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
      >
        <TriangleAlert size={14} aria-hidden="true" />
        {signals.length > 0 && <span className={css.dot} aria-hidden="true" />}
        <span className={css.count}>{count}</span>
      </button>
      {shown && (
        <div className={css.panel} role="dialog" aria-label={t('trouble.title')}>
          <strong>{t('trouble.title')}</strong>
          {signals.length === 0 ? (
            <p className={css.ok}>{t('trouble.ok')}</p>
          ) : (
            <ul className={css.list}>
              {signals.map((s) => {
                const at = s.at;
                const other = at && at.agentId !== agentId ? ` · ${whose(at.agentId)}` : '';
                return (
                  <li key={`${s.kind}:${at?.agentId ?? ''}`}>
                    {at && navigate ? (
                      <button type="button" className={css.item} onClick={() => go(at)}>
                        <Phrase s={s} now={now} />
                      </button>
                    ) : (
                      <span>
                        <Phrase s={s} now={now} />
                      </span>
                    )}
                    {other && <span className={css.agent}>{other}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

import { ChevronDown, ChevronRight, Workflow } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentNode } from '../../../src/core/model.js';
import { MAIN_AGENT_ID } from '../../../src/core/model.js';
import { emptyUsage, totalTokens } from '../../../src/core/usage.js';
import type { OpenSession } from '../data/store';
import { useI18n } from '../i18n';
import { agentPath, agentTree, subtreeIds } from '../lib/agents';
import { formatCompact } from '../lib/format';
import css from './AgentBreadcrumb.module.css';
import { CompactFigure } from './CompactFigure';
import { LiveDot } from './Status';

interface Props {
  open: OpenSession;
  agentId: string;
  onSelect(agentId: string): void;
}

export function AgentBreadcrumb({ open, agentId, onSelect }: Props) {
  const { t } = useI18n();
  const path = useMemo(() => agentPath(open, agentId), [open, agentId]);
  const name = (a: AgentNode) => (a.id === MAIN_AGENT_ID ? t('crumb.main') : a.label);

  return (
    <nav className={css.crumbs} aria-label={t('crumb.label')}>
      {path.map((item, i) => (
        <Fragment key={item.kind === 'agent' ? item.agent.id : item.workflow.id}>
          {i > 0 && <ChevronRight size={12} className={css.sep} aria-hidden="true" />}
          {item.kind === 'agent' ? (
            <button
              type="button"
              className={css.crumb}
              aria-current={i === path.length - 1 ? 'page' : undefined}
              onClick={() => onSelect(item.agent.id)}
            >
              <LiveDot
                kind="status"
                state={item.agent.status}
                label={t(`status.${item.agent.status}`)}
              />
              {name(item.agent)}
            </button>
          ) : (
            <span className={css.workflow}>
              <Workflow size={12} aria-hidden="true" />
              {item.workflow.name ?? item.workflow.id}
            </span>
          )}
        </Fragment>
      ))}
      <AgentMenu open={open} agentId={agentId} onSelect={onSelect} name={name} />
    </nav>
  );
}

function AgentMenu({ open, agentId, onSelect, name }: Props & { name(a: AgentNode): string }) {
  const { t, intl } = useI18n();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => (shown ? agentTree(open) : []), [open, shown]);
  // Cumulative tokens: the agent and everything it spawned.
  const cumulative = (id: string) => {
    let n = 0;
    for (const a of subtreeIds(open, id))
      n += totalTokens(open.agents.get(a)?.usage ?? emptyUsage());
    return n;
  };
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setShown(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShown(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [shown]);

  if (open.agents.size < 2) return null;
  return (
    <div className={css.menuWrap} ref={ref}>
      <button
        type="button"
        className={css.menuButton}
        aria-label={t('crumb.pick')}
        aria-haspopup="menu"
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {shown && (
        <div className={css.menu} role="menu">
          {rows.map((r) => {
            const indent = { paddingLeft: 10 + r.depth * 14 };
            if (r.kind === 'workflow')
              return (
                <div key={`wf:${r.workflow.id}`} className={css.menuGroup} style={indent}>
                  <Workflow size={12} aria-hidden="true" />
                  {r.workflow.name ?? r.workflow.id}
                </div>
              );
            if (r.kind === 'phase')
              return (
                <div key={`ph:${r.workflowId}:${r.title}`} className={css.menuPhase} style={indent}>
                  {r.title}
                </div>
              );
            return (
              <button
                key={r.agent.id}
                type="button"
                role="menuitem"
                className={css.menuItem}
                style={indent}
                aria-current={r.agent.id === agentId ? 'true' : undefined}
                onClick={() => {
                  setShown(false);
                  onSelect(r.agent.id);
                }}
              >
                <LiveDot
                  kind="status"
                  state={r.agent.status}
                  label={t(`status.${r.agent.status}`)}
                />
                <span className={css.menuLabel}>{name(r.agent)}</span>
                <span className={css.menuTokens}>
                  <CompactFigure value={formatCompact(cumulative(r.agent.id), intl)} />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

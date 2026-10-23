import type { CSSProperties } from 'react';
import type { AgentKind } from '../../../src/core/model.js';
import { agentColors, agentName, agentTone } from '../lib/agent-names';
import css from './AgentTag.module.css';

/**
 * A coding agent's name on a quiet tint of its own colour, so sessions of different agents tell
 * apart at a glance. The name is always there: the colour only helps.
 */
export function AgentTag({ kind, size = 'small' }: { kind: AgentKind; size?: 'small' | 'medium' }) {
  const { fg, bg, edge } = agentColors(kind);
  const style = { '--tag-fg': fg, '--tag-bg': bg, '--tag-edge': edge } as CSSProperties;
  return (
    <span
      className={css.tag}
      data-agent={kind}
      data-tone={agentTone(kind)}
      data-size={size}
      style={style}
    >
      {agentName(kind)}
    </span>
  );
}

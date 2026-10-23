/** Display names of the coding agents whose sessions glassbox reads. */
import type { AgentKind } from '../../../src/core/model.js';

const NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  grok: 'Grok',
  codex: 'Codex',
  'oh-my-pi': 'oh-my-pi',
  opencode: 'OpenCode',
};

/** "Claude Code" for 'claude-code'; an agent without a known name shows its kind as is. */
export const agentName = (kind: AgentKind): string => NAMES[kind] ?? kind;

/** Agents with a colour of their own (`--agent-<tone>-fg` / `-bg` in tokens.css). */
export const AGENT_TONES = ['claude-code', 'codex', 'grok', 'oh-my-pi', 'opencode'] as const;
export type AgentTone = (typeof AGENT_TONES)[number] | 'other';

/** An agent's colour family; an agent glassbox has no colour for wears the neutral one. */
export const agentTone = (kind: AgentKind): AgentTone =>
  (AGENT_TONES as readonly string[]).includes(kind) ? (kind as AgentTone) : 'other';

/** The tokens an agent's tag is drawn with: its text colour on its tint, inside its edge. */
export const agentColors = (kind: AgentKind): { fg: string; bg: string; edge: string } => {
  const tone = agentTone(kind);
  return {
    fg: `var(--agent-${tone}-fg)`,
    bg: `var(--agent-${tone}-bg)`,
    edge: `var(--agent-${tone}-edge)`,
  };
};

/**
 * Codex stores its reasoning encrypted: thinking blocks are there, their text is not readable.
 * Saying "not recorded" would be wrong for it. oh-my-pi keeps a thinking block without text
 * only when the provider sent the reasoning encrypted or redacted.
 */
export const encryptsThinking = (kind: AgentKind): boolean =>
  kind === 'codex' || kind === 'oh-my-pi';

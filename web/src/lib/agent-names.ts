/** Display names of the coding agents whose sessions glassbox reads. */
import type { AgentKind } from '../../../src/core/model.js';

const NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  grok: 'Grok',
  codex: 'Codex',
  'oh-my-pi': 'oh-my-pi',
};

/** "Claude Code" for 'claude-code'; an agent without a known name shows its kind as is. */
export const agentName = (kind: AgentKind): string => NAMES[kind] ?? kind;

/**
 * Codex stores its reasoning encrypted: thinking blocks are there, their text is not readable.
 * Saying "not recorded" would be wrong for it. oh-my-pi keeps a thinking block without text
 * only when the provider sent the reasoning encrypted or redacted.
 */
export const encryptsThinking = (kind: AgentKind): boolean =>
  kind === 'codex' || kind === 'oh-my-pi';

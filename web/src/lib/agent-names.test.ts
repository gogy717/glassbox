import { describe, expect, it } from 'vitest';
import { agentColors, agentName, agentTone } from './agent-names';

describe('agentName', () => {
  it.each([
    ['claude-code', 'Claude Code'],
    ['grok', 'Grok'],
    ['codex', 'Codex'],
    ['oh-my-pi', 'oh-my-pi'],
    ['opencode', 'OpenCode'],
    ['aider', 'aider'],
  ])('%s → %s', (kind, name) => {
    expect(agentName(kind)).toBe(name);
  });
});

describe('agentTone / agentColors', () => {
  it.each([
    ['claude-code', 'claude-code'],
    ['codex', 'codex'],
    ['grok', 'grok'],
    ['oh-my-pi', 'oh-my-pi'],
    ['opencode', 'opencode'],
    ['aider', 'other'],
    ['', 'other'],
  ])('%j wears the %s colours', (kind, tone) => {
    expect(agentTone(kind)).toBe(tone);
    expect(agentColors(kind)).toEqual({
      fg: `var(--agent-${tone}-fg)`,
      bg: `var(--agent-${tone}-bg)`,
      edge: `var(--agent-${tone}-edge)`,
    });
  });
});

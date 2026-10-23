import { describe, expect, it } from 'vitest';
import { agentName } from './agent-names';

describe('agentName', () => {
  it.each([
    ['claude-code', 'Claude Code'],
    ['grok', 'Grok'],
    ['codex', 'Codex'],
    ['aider', 'aider'],
  ])('%s → %s', (kind, name) => {
    expect(agentName(kind)).toBe(name);
  });
});

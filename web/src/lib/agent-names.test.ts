/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_TONES, agentColors, agentName, agentTone } from './agent-names';

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
    });
  });
});

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('agent colour tokens', () => {
  const tokensCss = readFileSync(join(import.meta.dirname, '../styles/tokens.css'), 'utf8');
  // Light `:root`, dark for the OS setting, dark for the theme toggle: in that order.
  const scopes = tokensCss.split(
    /@media \(prefers-color-scheme: dark\)|:root\[data-theme="dark"\]/,
  );

  it('are defined for every tone in light and both dark scopes, text ≥ 4.5:1 on its tint', () => {
    expect(scopes).toHaveLength(3);
    for (const [i, scope] of scopes.entries()) {
      for (const tone of [...AGENT_TONES, 'other']) {
        const fg = new RegExp(`--agent-${tone}-fg: (#[0-9a-f]{6});`).exec(scope)?.[1];
        const bg = new RegExp(`--agent-${tone}-bg: (#[0-9a-f]{6});`).exec(scope)?.[1];
        expect(fg, `${tone} fg in scope ${i}`).toBeDefined();
        expect(bg, `${tone} bg in scope ${i}`).toBeDefined();
        expect(
          contrast(fg as string, bg as string),
          `${tone} in scope ${i}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('use the same dark values for the OS setting and the theme toggle', () => {
    const values = (scope: string) => scope.match(/--agent-[a-z-]+: #[0-9a-f]{6};/g);
    expect(values(scopes[1] as string)).toEqual(values(scopes[2] as string));
  });
});

/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_TONES } from '../lib/agent-names';

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');
// Light `:root`, dark for the OS setting, dark for the theme toggle: in that order.
const scopes = css.split(/@media \(prefers-color-scheme: dark\)|:root\[data-theme="dark"\]/);
const NAMES = ['light', 'dark (system)', 'dark (toggle)'];

/** A scope's colour tokens; a dark scope inherits what it does not redefine from light. */
function tokens(i: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const scope of i === 0 ? [scopes[0]] : [scopes[0], scopes[i]])
    for (const m of (scope as string).matchAll(/(--[a-z0-9-]+): (#[0-9a-f]{6});/g))
      out.set(m[1] as string, m[2] as string);
  return out;
}

describe('tokens.css', () => {
  it('has the light scope and both dark scopes, with the same dark values', () => {
    expect(scopes).toHaveLength(3);
    const values = (scope: string) => scope.match(/--[a-z0-9-]+: #[0-9a-f]{6};/g);
    expect(values(scopes[1] as string)).toEqual(values(scopes[2] as string));
  });

  // Text sits on any surface, on a hovered row and on a selected (accent-tinted) row.
  const SURFACES = ['--bg', '--layer-1', '--layer-2', '--layer-3', '--accent-tint'];

  it.each(NAMES.map((name, i) => [name, i] as const))(
    'text tokens reach 4.5:1 on every surface (%s)',
    (_, i) => {
      const t = tokens(i);
      for (const fg of ['--text', '--muted', '--faint', '--accent'])
        for (const bg of SURFACES) {
          const ratio = contrast(t.get(fg) as string, t.get(bg) as string);
          expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
    },
  );

  it.each(NAMES.map((name, i) => [name, i] as const))(
    'status colours read as text on the surfaces, and fills keep their text legible (%s)',
    (_, i) => {
      const t = tokens(i);
      for (const fg of ['--success', '--error', '--warning'])
        for (const bg of ['--bg', '--layer-1', '--layer-2']) {
          const ratio = contrast(t.get(fg) as string, t.get(bg) as string);
          expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      for (const [fg, bg] of [
        ['--on-accent', '--accent'],
        ['--on-error', '--error'],
      ] as const)
        expect(
          contrast(t.get(fg) as string, t.get(bg) as string),
          `${fg} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(NAMES.map((name, i) => [name, i] as const))(
    'agent tags: every agent’s text reaches 4.5:1 on its tint (%s)',
    (_, i) => {
      const t = tokens(i);
      for (const tone of [...AGENT_TONES, 'other']) {
        const fg = t.get(`--agent-${tone}-fg`);
        const bg = t.get(`--agent-${tone}-bg`);
        expect(fg, `${tone} fg`).toBeDefined();
        expect(bg, `${tone} bg`).toBeDefined();
        expect(contrast(fg as string, bg as string), tone).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});

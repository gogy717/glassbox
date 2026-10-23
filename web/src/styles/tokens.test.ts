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

type Vision = 'normal' | 'protan' | 'deutan';

/** Machado, Oliveira & Fernandes (2009) dichromacy at severity 1.0, on linear RGB. */
const CVD: Record<Exclude<Vision, 'normal'>, number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

/** OKLab of `hex` as seen with `vision`. */
function oklab(hex: string, vision: Vision): [number, number, number] {
  let rgb = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  if (vision !== 'normal') {
    const m = CVD[vision];
    rgb = m.map((row) =>
      Math.min(
        1,
        Math.max(
          0,
          row.reduce((sum, k, i) => sum + k * (rgb[i] as number), 0),
        ),
      ),
    );
  }
  const [r, g, b] = rgb as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363420237 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceived difference: OKLab distance ×100, as the dataviz palette checks measure it. */
function deltaE(a: string, b: string, vision: Vision = 'normal'): number {
  const [x, y] = [oklab(a, vision), oklab(b, vision)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const VISIONS: Vision[] = ['normal', 'protan', 'deutan'];

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

  // ΔE floors (×100, OKLab; colour-blind = Machado 2009 protan / deutan). Status, accent and
  // tool cards must never pass for an agent; agents must tell apart from each other, where the
  // floor sits a little below the chart standard (15 / 8) because the tag names its agent too.
  const AGENT_PAIRS = { normal: 14, protan: 7.5, deutan: 7.5 };
  const RESERVED = { normal: 15, protan: 8, deutan: 8 };
  const tones = [...AGENT_TONES];

  it.each(NAMES.map((name, i) => [name, i] as const))(
    'agent tags stay apart from each other and from status and accent colours (%s)',
    (_, i) => {
      const t = tokens(i);
      const fill = (tone: string) => t.get(`--agent-${tone}-bg`) as string;
      const ink = (tone: string) => t.get(`--agent-${tone}-fg`) as string;
      for (const [a, tone] of tones.entries())
        for (const other of tones.slice(a + 1))
          for (const v of VISIONS)
            expect(
              deltaE(fill(tone), fill(other), v),
              `${tone} vs ${other} (${v})`,
            ).toBeGreaterThanOrEqual(AGENT_PAIRS[v]);
      for (const tone of tones)
        for (const status of ['--success', '--error', '--warning', '--accent'])
          for (const v of VISIONS) {
            const colour = t.get(status) as string;
            expect(
              deltaE(fill(tone), colour, v),
              `${tone} fill vs ${status} (${v})`,
            ).toBeGreaterThanOrEqual(RESERVED[v]);
            if (status !== '--accent')
              expect(
                deltaE(ink(tone), colour, v),
                `${tone} text vs ${status} (${v})`,
              ).toBeGreaterThanOrEqual(RESERVED[v]);
          }
    },
  );

  it.each(NAMES.map((name, i) => [name, i] as const))(
    'the git and MCP tool categories do not read as a status (%s)',
    (_, i) => {
      const t = tokens(i);
      for (const cat of ['--cat-git', '--cat-mcp'])
        for (const status of ['--success', '--error', '--warning'])
          for (const v of VISIONS)
            expect(
              deltaE(t.get(cat) as string, t.get(status) as string, v),
              `${cat} vs ${status} (${v})`,
            ).toBeGreaterThanOrEqual(RESERVED[v]);
    },
  );

  it.each(NAMES.map((name, i) => [name, i] as const))(
    'Claude Code’s clay is not the orange of the tool cards (%s)',
    (_, i) => {
      const t = tokens(i);
      const ink = t.get('--agent-claude-code-fg') as string;
      const fill = t.get('--agent-claude-code-bg') as string;
      expect(deltaE(ink, t.get('--card-tool-text') as string)).toBeGreaterThanOrEqual(10);
      for (const card of ['--card-tool-text', '--card-tool-border', '--card-tool-bg'])
        expect(deltaE(fill, t.get(card) as string), `fill vs ${card}`).toBeGreaterThanOrEqual(10);
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

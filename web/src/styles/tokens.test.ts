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

/** A scope's percentage token (the agent tags' tint and edge strengths), as a fraction. */
function percent(i: number, name: string): number {
  let value: number | undefined;
  for (const scope of i === 0 ? [scopes[0]] : [scopes[0], scopes[i]]) {
    const m = (scope as string).match(new RegExp(`${name}: (\\d+)%;`));
    if (m) value = Number(m[1]) / 100;
  }
  expect(value, name).toBeDefined();
  return value as number;
}

/** `colour` at `alpha` over `surface`, as `color-mix(in srgb, colour alpha, transparent)` paints. */
function over(colour: string, alpha: number, surface: string): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) => Math.round(channel(colour, i) * alpha + channel(surface, i) * (1 - alpha)))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;
}

describe('tokens.css', () => {
  it('has the light scope and both dark scopes, with the same dark values', () => {
    expect(scopes).toHaveLength(3);
    // Every declaration, hex, rgba (the hairlines), % or var() alike.
    const values = (scope: string) => scope.match(/--[a-z0-9-]+: [^;]+;/g);
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

  // D1's text pairs (Foundations board): the request / response / tool card inks read on every
  // panel surface a card sits on.
  it.each(NAMES.map((name, i) => [name, i] as const))(
    'card inks reach 4.5:1 on the panel surfaces (%s)',
    (_, i) => {
      const t = tokens(i);
      for (const fg of ['--card-req-text', '--card-res-text', '--card-tool-text'])
        for (const bg of ['--bg', '--layer-1', '--layer-2']) {
          const ratio = contrast(t.get(fg) as string, t.get(bg) as string);
          expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
    },
  );

  // The ring around a waiting-for-you dot (and the permission prompt's inset edge) is the
  // theme's own amber, faintly: 10% light, 14% dark, as on the Foundations board.
  it.each(NAMES.map((name, i) => [name, i] as const))(
    'the warning tint is the theme’s amber at the board’s strength (%s)',
    (_, i) => {
      let tint: number[] | undefined;
      for (const scope of i === 0 ? [scopes[0]] : [scopes[0], scopes[i]]) {
        const m = (scope as string).match(/--warning-tint: rgba\((\d+), (\d+), (\d+), ([\d.]+)\);/);
        if (m) tint = m.slice(1).map(Number);
      }
      const warning = tokens(i).get('--warning') as string;
      const rgb = [1, 3, 5].map((k) => Number.parseInt(warning.slice(k, k + 2), 16));
      expect(tint).toEqual([...rgb, i === 0 ? 0.1 : 0.14]);
    },
  );

  it('keeps D1’s radius scale, nothing rounder than 8px, and ink for selection and focus', () => {
    const radii = [...(scopes[0] as string).matchAll(/--radius-([a-z]+): (\d+)px;/g)].map(
      (m) => [m[1], Number(m[2])] as const,
    );
    expect(radii).toEqual([
      ['xs', 2],
      ['s', 3],
      ['m', 4],
      ['l', 6],
      ['xl', 8],
    ]);
    // --ink is the text colour in every theme (dark overrides --text on this same :root).
    expect(css.match(/--ink: [^;]+;/g)).toEqual(['--ink: var(--text);']);
    expect(css).toMatch(/--focus-ring: 2px solid var\(--ink\);/);
  });

  // ΔE floors (×100, OKLab; colour-blind = Machado 2009 protan / deutan). Status, accent and
  // tool cards must never pass for an agent: RESERVED is the chart standard (15 / 8).
  const RESERVED = { normal: 15, protan: 8, deutan: 8 };
  const tones = [...AGENT_TONES];

  // D1 A5: the steel chrome accent must not pass for the data blues next to it (cache reads in
  // every token tape, Explore steps). It clears the colour-blind floors (8) everywhere, but not
  // the chart standard's 15 on normal vision: light accent vs Explore 10.9, dark accent vs cache
  // reads 13.1. That is what the steel hues ruled for v2 reach (today's #1c5cc2 / #6ea4ff: 8.0
  // and 10.1), so A5 holds at 10 / 8 / 8; the accent is text and rules, the blues are marks.
  const A5 = { normal: 10, protan: 8, deutan: 8 };

  it.each(NAMES.map((name, i) => [name, i] as const))(
    'the chrome accent stays apart from the data blues (A5) (%s)',
    (_, i) => {
      const t = tokens(i);
      for (const data of ['--tok-cache-read', '--cat-explore'])
        for (const v of VISIONS)
          expect(
            deltaE(t.get('--accent') as string, t.get(data) as string, v),
            `--accent vs ${data} (${v})`,
          ).toBeGreaterThanOrEqual(A5[v]);
    },
  );

  // Agent tags are a quiet tint of the agent's hue (--agent-tint of it over the surface) inside an
  // edge of the same hue (--agent-edge), with text in a deep (light) or pale (dark) shade of it.
  // Until U3c the tag was a solid fill, and the fills alone kept agents 14 / 7.5 / 7.5 apart.
  // Tints are too pale for that (2–6 apart), so a pair is now judged on whichever of its texts or
  // its tints (over --layer-1) differ more: the text carries the agent where the tint cannot.
  // - Light keeps 14 / 7.5 / 7.5, a little below the chart standard because the tag names its
  //   agent too.
  // - Dark drops to 11 / 6 / 6: pale text must stay 15 / 8 clear of the status and accent
  //   colours, which all sit near the same lightness (≈ 0.71–0.77 OKLab), so the five texts share
  //   the strip between them and white; calm tints (≈ 24%, ink chroma ≤ 0.14) reach no further.
  //   6 is the dataviz minimum for colour-blind separation with a label, and every tag shows its
  //   agent's name, so colour is never the only signal.
  const AGENT_PAIRS = [
    { normal: 14, protan: 7.5, deutan: 7.5 },
    { normal: 11, protan: 6, deutan: 6 },
    { normal: 11, protan: 6, deutan: 6 },
  ];
  const agentTag = (t: Map<string, string>, i: number, tone: string) => {
    const hue = t.get(`--agent-${tone}-hue`) as string;
    const ink = t.get(`--agent-${tone}-fg`) as string;
    expect(hue, `${tone} hue`).toBeDefined();
    expect(ink, `${tone} text`).toBeDefined();
    const tint = (surface = t.get('--layer-1') as string) =>
      over(hue, percent(i, '--agent-tint'), surface);
    const edge = over(hue, percent(i, '--agent-edge'), t.get('--layer-1') as string);
    return { ink, tint, edge };
  };

  it('derives every tag’s tint and edge from its hue, once, on the :root that dark overrides', () => {
    // The checks below composite --agent-*-hue at --agent-tint / --agent-edge themselves; this
    // holds the CSS to that model.
    const flat = css.replace(/\s+/g, ' ');
    for (const tone of [...AGENT_TONES, 'other'])
      for (const [part, strength] of [
        ['bg', 'tint'],
        ['edge', 'edge'],
      ] as const) {
        const decl = `--agent-${tone}-${part}: color-mix( in srgb, var(--agent-${tone}-hue) var(--agent-${strength}), transparent );`;
        const compact = decl.replace('( ', '(').replace(' )', ')');
        const count = flat.split(decl).length - 1 + flat.split(compact).length - 1;
        expect(count, `--agent-${tone}-${part}`).toBe(1);
        expect(scopes[0]?.replace(/\s+/g, ' ')).toMatch(
          new RegExp(`--agent-${tone}-${part}: color-mix\\(`),
        );
      }
    // Both dark overrides sit on :root itself, where those var()s resolve.
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{/,
    );
    expect(css).toMatch(/\n:root\[data-theme="dark"\] \{/);
  });

  it.each(NAMES.map((name, i) => [name, i] as const))(
    'agent tags stay apart from each other, by text or tint (%s)',
    (_, i) => {
      const t = tokens(i);
      const floor = AGENT_PAIRS[i] as (typeof AGENT_PAIRS)[number];
      for (const [a, tone] of tones.entries())
        for (const other of tones.slice(a + 1)) {
          const [x, y] = [agentTag(t, i, tone), agentTag(t, i, other)];
          for (const v of VISIONS)
            expect(
              Math.max(deltaE(x.ink, y.ink, v), deltaE(x.tint(), y.tint(), v)),
              `${tone} vs ${other} (${v})`,
            ).toBeGreaterThanOrEqual(floor[v]);
        }
    },
  );

  // A tag must not pass for a status, by any of its colours; nor for the accent, by its tint or
  // edge (PM ruling, W1). Old → new: U3c held text, tint and edge to status and accent; W1 holds
  // the text to status only. The accent is now a quiet steel ink for links and the running
  // state, close to the deep petrol / indigo / magenta tag texts (light Codex
  // 12.6, dark Grok 9.9). Holding the text to it too left no calm palette that keeps the pair
  // floors above (best 0.97 light, 0.91 dark of them). U3 judged the accent on the fill alone;
  // the tint and edge keep that, and the tag's form and name do the rest.
  it.each(NAMES.map((name, i) => [name, i] as const))(
    'agent tags do not read as a status, nor by tint or edge as the accent (%s)',
    (_, i) => {
      const t = tokens(i);
      for (const tone of tones) {
        const tag = agentTag(t, i, tone);
        for (const reserved of ['--success', '--error', '--warning', '--accent'])
          for (const v of VISIONS)
            for (const [part, colour] of [
              ['text', tag.ink],
              ['tint', tag.tint()],
              ['edge', tag.edge],
            ] as const) {
              if (part === 'text' && reserved === '--accent') continue;
              expect(
                deltaE(colour, t.get(reserved) as string, v),
                `${tone} ${part} vs ${reserved} (${v})`,
              ).toBeGreaterThanOrEqual(RESERVED[v]);
            }
      }
    },
  );

  // I3: CJK that lands in a mono run (a fenced message, a tool summary) takes the UI's CJK face
  // right after Plex, never a CJK monospace further down the stack.
  it('puts the UI’s CJK faces right after Plex Mono in the mono stack', () => {
    const stack = (name: string) =>
      (new RegExp(`${name}:([^;]+);`).exec(css)?.[1] ?? '')
        .split(',')
        .map((f) => f.trim().replace(/"/g, ''));
    const mono = stack('--font-mono');
    const cjk = stack('--font-ui').filter((f) =>
      ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei'].includes(f),
    );
    expect(cjk).toHaveLength(3);
    expect(mono.slice(0, 4)).toEqual(['IBM Plex Mono', ...cjk]);
    expect(mono.at(-1)).toBe('monospace');
  });

  // cards.module.css: a tool card's label is `color-mix(in srgb, var(--cat) 55%, var(--text))`.
  it.each(NAMES.map((name, i) => [name, i] as const))(
    'every tool category label reads at AA on its card (%s)',
    (_, i) => {
      const t = tokens(i);
      const cats = [...t.keys()].filter((k) => k.startsWith('--cat-'));
      expect(cats.length).toBeGreaterThanOrEqual(10);
      for (const cat of cats) {
        const label = over(t.get(cat) as string, 0.55, t.get('--text') as string);
        expect(contrast(label, t.get('--layer-1') as string), cat).toBeGreaterThanOrEqual(4.5);
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

  // Until U3c the Claude fill was also held 10 from the tool card's text, border and background.
  // A tint cannot be: it and the card background are both near-white warm pastels. The tag text
  // still is, and the tag never sits on a tool card.
  it.each(NAMES.map((name, i) => [name, i] as const))(
    'Claude Code’s clay is not the orange of the tool cards (%s)',
    (_, i) => {
      const t = tokens(i);
      const { ink } = agentTag(t, i, 'claude-code');
      expect(deltaE(ink, t.get('--card-tool-text') as string)).toBeGreaterThanOrEqual(10);
    },
  );

  it.each(NAMES.map((name, i) => [name, i] as const))(
    'agent tags: every agent’s text reaches 4.5:1 on its tint over every surface (%s)',
    (_, i) => {
      const t = tokens(i);
      for (const tone of [...AGENT_TONES, 'other']) {
        const tag = agentTag(t, i, tone);
        for (const surface of SURFACES) {
          const ratio = contrast(tag.ink, tag.tint(t.get(surface) as string));
          expect(ratio, `${tone} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );
});

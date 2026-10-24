/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import postcss, { type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { describe, expect, it } from 'vitest';

/**
 * CSS modules scope class names only: a selector without a class (`[data-level]`, `button`,
 * `:root`) applies to the whole page. One did: the JSON tree's `[data-level]` rules restyled the
 * quota bar, whose meters also carry data-level. Every selector must name a class of its own
 * module, unless it says `:global(...)` on purpose.
 */
function unscopedSelectors(css: string): string[] {
  const found: string[] = [];
  postcss.parse(css).walkRules((rule: Rule) => {
    // Keyframe steps (from, to, 40%) are not selectors.
    if (
      rule.parent?.type === 'atrule' &&
      /keyframes$/i.test((rule.parent as { name: string }).name)
    )
      return;
    selectorParser((root) => {
      for (const selector of root.nodes) {
        let scoped = false;
        selector.walk((node) => {
          if (node.type === 'pseudo' && node.value === ':global') scoped = true;
          if (node.type !== 'class') return;
          // A class inside :not() narrows nothing: the selector still matches the rest of the page.
          for (let up = node.parent; up; up = up.parent)
            if (up.type === 'pseudo' && up.value === ':not') return;
          scoped = true;
        });
        if (!scoped) found.push(selector.toString().trim());
      }
    }).processSync(rule.selector);
  });
  return found;
}

function moduleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? moduleFiles(join(dir, e.name))
      : e.name.endsWith('.module.css')
        ? [join(dir, e.name)]
        : [],
  );
}

const SRC = join(import.meta.dirname, '..');

describe('CSS modules', () => {
  it('flags the unscoped rules that restyled the quota bar, and passes their scoped form', () => {
    // The rules as 4d73741 shipped them…
    const leaked = `
      [data-level]:not([data-level] [data-level]) { width: 100cqw; }
      [data-level] [data-level] { padding-left: 0; }
      [data-level]::before { content: attr(data-level); }
      [data-level]:not(.meter) { color: red; }
    `;
    expect(unscopedSelectors(leaked)).toEqual([
      '[data-level]:not([data-level] [data-level])',
      '[data-level] [data-level]',
      '[data-level]::before',
      // A class only inside :not() still matches everything else on the page.
      '[data-level]:not(.meter)',
    ]);
    // …and as they are now.
    const scoped = `
      .tree [data-json-level]:not([data-json-level] [data-json-level]) { width: 100cqw; }
      .tree [data-json-level] [data-json-level] { padding-left: 0; }
      .tree [data-json-level]::before { content: attr(data-json-level); }
      @keyframes spin { from { rotate: 0deg; } 50% { rotate: 180deg; } to { rotate: 360deg; } }
      :global(.visually-hidden) span { color: red; }
    `;
    expect(unscopedSelectors(scoped)).toEqual([]);
  });

  it('scope every selector of every module to one of its own classes', () => {
    const files = moduleFiles(SRC);
    expect(files.length).toBeGreaterThan(10);
    const unscoped = files.flatMap((file) =>
      unscopedSelectors(readFileSync(file, 'utf8')).map((sel) => `${relative(SRC, file)}: ${sel}`),
    );
    expect(unscoped).toEqual([]);
  });

  // A module's `animation: pulse …` is renamed to the module's own `_pulse_<hash>`, so keyframes
  // declared in global.css never run there: the status dots did not pulse until W1's fix round.
  // Modules not yet fixed (D1 hand-offs; drop each once its wave declares its own keyframes).
  // Empty since I3: W4's TimeView and W5's Composer declare their own.
  const KNOWN: string[] = [];

  // D1 A2 (I3): nothing rounder than 8 px but a dot, so no pill (the reopen button was 999 px).
  it('rounds every module only on D1’s scale: a radius token, at most 8px, or a 50% dot', () => {
    const off = moduleFiles(SRC).flatMap((file) => {
      const found: string[] = [];
      postcss.parse(readFileSync(file, 'utf8')).walkDecls(/radius$/, (d) => {
        for (const v of d.value.split(/\s+(?![^(]*\))/)) {
          const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
          const ok =
            /^var\(--radius-(xs|s|m|l|xl)\)$/.test(v) ||
            v === '0' ||
            v === '50%' ||
            (px !== null && Number(px[1]) <= 8);
          if (!ok) found.push(`${relative(SRC, file)}: ${d.prop}: ${d.value}`);
        }
      });
      return found;
    });
    expect(off).toEqual([]);
  });

  // I3 item 5: Chinese has no case, so an uppercase label only shouts its Latin words ("TOKEN").
  it('lets every uppercase rule in a module drop the uppercase in Chinese', () => {
    const missing = moduleFiles(SRC).flatMap((file) => {
      const root = postcss.parse(readFileSync(file, 'utf8'));
      const upper: string[] = [];
      const zhNone = new Set<string>();
      root.walkDecls('text-transform', (d) => {
        const rule = d.parent as Rule;
        for (const sel of rule.selectors ?? []) {
          if (d.value === 'uppercase') upper.push(sel);
          const zh = /^(.*?):lang\(zh\)(.*)$/.exec(sel);
          if (zh && d.value === 'none') zhNone.add(`${zh[1]}${zh[2]}`.trim());
        }
      });
      return upper.filter((sel) => !zhNone.has(sel)).map((sel) => `${relative(SRC, file)}: ${sel}`);
    });
    expect(missing).toEqual([]);
  });

  it('animates a module only with keyframes the module declares', () => {
    const missing = moduleFiles(SRC).flatMap((file) => {
      const root = postcss.parse(readFileSync(file, 'utf8'));
      const declared = new Set<string>();
      root.walkAtRules(/keyframes$/i, (at) => {
        declared.add(at.params.trim());
      });
      const named = new Set<string>();
      root.walkDecls(/^animation(-name)?$/, (d) => {
        for (const word of d.value.split(/[\s,]+/))
          if (/^[a-z][\w-]*$/i.test(word) && !ANIMATION_WORDS.has(word)) named.add(word);
      });
      return [...named]
        .filter((name) => !declared.has(name))
        .map((name) => `${relative(SRC, file)}: ${name}`);
    });
    expect(missing.filter((m) => !KNOWN.includes(m))).toEqual([]);
    // A listed entry that is fixed (or gone) must leave the list, so it cannot hide a new one.
    expect(KNOWN.filter((k) => !missing.includes(k))).toEqual([]);
  });
});

/** The non-name words an `animation` shorthand can hold. */
const ANIMATION_WORDS = new Set([
  'none',
  'infinite',
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
  'forwards',
  'backwards',
  'both',
  'running',
  'paused',
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
  'steps',
  'var',
  'end',
  'start',
  'jump-start',
  'jump-end',
  'jump-none',
  'jump-both',
  'cubic-bezier',
]);

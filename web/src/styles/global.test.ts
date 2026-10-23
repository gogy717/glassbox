/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const sheet = postcss.parse(readFileSync(join(import.meta.dirname, 'global.css'), 'utf8'));
const WEB = join(import.meta.dirname, '../..');

describe('global.css', () => {
  it('eases hover and selection on every control in --motion, and reduced motion cancels it', () => {
    const transitions: Record<string, string> = {};
    sheet.walkRules((rule: Rule) => {
      if (rule.parent?.type !== 'root') return;
      rule.walkDecls('transition', (d) => {
        transitions[rule.selector] = d.value.replace(/\s+/g, ' ');
      });
    });
    expect(transitions).toEqual({
      ':where(button, a, [role="tab"], [role="radio"], [role="option"])':
        'color var(--motion), background-color var(--motion), border-color var(--motion), box-shadow var(--motion)',
    });
    const reduced: string[] = [];
    sheet.walkAtRules('media', (at: AtRule) => {
      if (!at.params.includes('prefers-reduced-motion: reduce')) return;
      at.walkDecls((d) => {
        reduced.push(`${d.prop}: ${d.value}${d.important ? ' !important' : ''}`);
      });
    });
    expect(reduced).toEqual(['animation: none !important', 'transition: none !important']);
  });

  it('preloads the Plex Mono Latin subsets the @font-face rules name, and only those', () => {
    const html = readFileSync(join(WEB, 'index.html'), 'utf8');
    const preloads = [...html.matchAll(/<link rel="preload" ([^>]*)\/>/g)].map((m) => m[1] ?? '');
    for (const attrs of preloads) {
      // A font preload without crossorigin is fetched twice.
      expect(attrs).toMatch(/as="font" type="font\/woff2" crossorigin/);
    }
    const hrefs = preloads.map((attrs) => /href="([^"]+)"/.exec(attrs)?.[1]);
    expect(hrefs).toEqual([
      '/fonts/IBMPlexMono-Regular-Latin1.woff2',
      '/fonts/IBMPlexMono-Medium-Latin1.woff2',
    ]);
    const faces: string[] = [];
    sheet.walkAtRules('font-face', (at: AtRule) => {
      at.walkDecls('src', (d) => {
        faces.push(/url\("([^"]+)"\)/.exec(d.value)?.[1] ?? '');
      });
      // Swap stays: the preload makes the fallback face rare, not impossible.
      at.walkDecls('font-display', (d) => {
        expect(d.value).toBe('swap');
      });
    });
    for (const href of hrefs) {
      expect(faces).toContain(href);
      expect(existsSync(join(WEB, 'public', href as string)), href).toBe(true);
    }
  });
});

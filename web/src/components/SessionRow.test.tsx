/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import postcss from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoSessions } from '../../../src/core/fixtures/demo.js';
import type { SessionSummary } from '../../../src/core/model.js';
import { I18nContext, makeI18n } from '../i18n';
import { DEMO_NOW } from '../test/demo';
import { moduleCssValue } from '../test/module-css';
import { SessionRow } from './SessionRow';
import css from './SessionRow.module.css';

const [running, idle] = createDemoSessions(DEMO_NOW) as [SessionSummary, SessionSummary];

function renderRow(
  session: SessionSummary,
  selected = false,
  onSelect = vi.fn(),
  locale: 'en' | 'zh' = 'en',
  more: { density?: 'compact' | 'card'; failure?: string | null } = {},
) {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <SessionRow
        session={session}
        selected={selected}
        now={DEMO_NOW.getTime()}
        onSelect={onSelect}
        {...more}
      />
    </I18nContext.Provider>,
  );
  return screen.getByRole('button');
}

const since = (s: number) => new Date(DEMO_NOW.getTime() - s * 1000).toISOString();
const reading: SessionSummary = {
  ...running,
  activity: { kind: 'tool', tool: 'Read', target: 'tokens.css', agentId: 'main', since: since(4) },
};

describe('SessionRow', () => {
  // I3: zh compact counts end in 万 or 亿; only the digits are a figure (CJK never in mono).
  it('sets only the digits of a Chinese token count in the mono face', () => {
    const row = renderRow(running, false, vi.fn(), 'zh');
    const figures = [...row.querySelectorAll('.figure')].map((f) => f.textContent ?? '');
    expect(figures.length).toBeGreaterThan(0);
    for (const f of figures) expect(f).not.toMatch(/[\u3000-\u9fff]/);
    expect(row).toHaveTextContent(/[\d.]+万/);
  });

  it('reads title, then state · short age · output tokens, with the agent tag last', () => {
    const row = renderRow(running);
    expect(row).toHaveAttribute('data-density', 'compact');
    const meta = row.lastElementChild as HTMLElement;
    const parts = [...meta.children].map((c) => c.textContent?.trim());
    expect(parts[0]).toBe('Running');
    // The age as formatRelative words it ("now", "7 seconds ago", or "7 s ago"); then the output
    // (42,040 of the demo's 1.88M tokens: the rest is cache reads, which say little).
    expect(parts[1]).toMatch(/^· (now|\d+\s?s(econds?)? ago) · 42K out42K output tokens$/);
    expect(parts.at(-1)).toBe('Claude Code');
    // The figure is mono and silent; the spoken text says what it counts.
    expect(meta.querySelector('.figure')?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(meta.querySelector('.visually-hidden')).toHaveTextContent('42K output tokens');
  });

  it('shows no figure at all while the output is zero', () => {
    const usage = running.usage as NonNullable<SessionSummary['usage']>;
    const meta = renderRow({ ...running, usage: { ...usage, output: 0 } })
      .lastElementChild as HTMLElement;
    expect(meta).not.toHaveTextContent(/out|token/);
    expect(meta.querySelector('.figure')).toBeNull();
    cleanup();
    const card = renderRow({ ...idle, usage: { ...usage, output: 0 } }, false, vi.fn(), 'en', {
      density: 'card',
    });
    expect(card.lastElementChild).not.toHaveTextContent(/out|token/);
  });

  it('marks the open session and opens the one clicked', () => {
    const onSelect = vi.fn();
    const row = renderRow(idle, true, onSelect);
    expect(row).toHaveAttribute('aria-current', 'true');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(idle.id);
  });

  it('says what a running session does in place of its state and age', () => {
    const meta = renderRow(reading).lastElementChild as HTMLElement;
    expect(meta.firstElementChild).toHaveTextContent(/^Reading tokens\.css$/);
    expect(meta).not.toHaveTextContent(/ago|now/);
    expect(meta.querySelector('.visually-hidden')).toHaveTextContent('42K output tokens');
  });

  it('says what a waiting session waits for, in the words of Home’s board, its tooltip too', () => {
    const waiting: SessionSummary = {
      ...running,
      live: 'waiting',
      activity: { kind: 'waiting', tool: 'Bash', target: null, agentId: 'main', since: since(20) },
    };
    const row = renderRow(waiting);
    const meta = row.lastElementChild as HTMLElement;
    expect(meta.firstElementChild).toHaveTextContent(/^Permission · Bash$/);
    // Cut short, the tooltip repeats the row: in its words, not "Waiting for you".
    const title = row.querySelector<HTMLElement>(`.${css.title}`) as HTMLElement;
    Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 400 });
    Object.defineProperty(title, 'clientWidth', { configurable: true, value: 200 });
    fireEvent.pointerEnter(row);
    expect((row.getAttribute('title') ?? '').split('\n')[1]).toMatch(
      /^Claude Code · Permission · Bash · /,
    );
  });

  it('says a failed run failed, then its age', () => {
    const meta = renderRow(idle, false, vi.fn(), 'en', { failure: 'missing file' })
      .lastElementChild as HTMLElement;
    expect(meta.firstElementChild).toHaveTextContent(/^Failed$/);
    expect(meta.children[1]).toHaveTextContent(/^· /);
  });

  describe('at card density', () => {
    it('reads tag, project and title, then the activity with its clock and the tokens', () => {
      vi.useFakeTimers();
      vi.setSystemTime(DEMO_NOW);
      try {
        const row = renderRow(reading, false, vi.fn(), 'en', { density: 'card' });
        expect(row).toHaveAttribute('data-density', 'card');
        const [head, meta] = [...row.children] as HTMLElement[];
        expect([...(head?.children ?? [])].map((c) => c.textContent)).toEqual([
          'Claude Code',
          'glassbox /',
          'Live viewer research (demo)',
        ]);
        // Running with a clock: no age beside it; then the output, said in full for the ear.
        expect(meta).toHaveTextContent(/^Reading tokens\.css · 0:04 · 42K out42K output tokens$/);
        expect(meta?.querySelector('.visually-hidden')).toHaveTextContent('42K output tokens');
        // The figures are mono: the clock and the count, not the words around them.
        expect([...(meta?.querySelectorAll('.figure') ?? [])].map((f) => f.textContent)).toEqual([
          '0:04',
          '42K',
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives a failure its reason and age, and leaves out tokens it does not know', () => {
      const row = renderRow(idle, false, vi.fn(), 'en', {
        density: 'card',
        failure: 'missing file',
      });
      expect(row.lastElementChild).toHaveTextContent(/^Failed · missing file · .+ ago$/);
    });

    it('cuts a very long project at two fifths of the line, its whole name in the tooltip', () => {
      const project = 'a-very-long-monorepo-package-name-that-goes-on-and-on-forever';
      const row = renderRow({ ...idle, project }, false, vi.fn(), 'en', { density: 'card' });
      expect(row.querySelector(`[title="${project}"]`)).toHaveTextContent(`${project} /`);
      const css = readFileSync(join(import.meta.dirname, 'SessionRow.module.css'), 'utf8');
      const decls = (selector: string) => {
        const out: Record<string, string> = {};
        postcss.parse(css).walkRules(selector, (r) => {
          r.walkDecls((d) => {
            out[d.prop] = d.value;
          });
        });
        return out;
      };
      expect(decls('.project')).toMatchObject({ 'max-width': '40%', 'min-width': '0' });
      expect(decls('.name')).toMatchObject({ overflow: 'hidden', 'text-overflow': 'ellipsis' });
    });

    it('writes no project before the title when it has none', () => {
      const row = renderRow({ ...idle, project: '' }, false, vi.fn(), 'en', { density: 'card' });
      expect(row.firstElementChild).not.toHaveTextContent('/');
    });

    it('sets only the digits of a Chinese count in the mono face', () => {
      const row = renderRow(running, false, vi.fn(), 'zh', { density: 'card' });
      expect(row.lastElementChild).toHaveTextContent(/输出 4\.2万输出 4\.2万 token$/);
      for (const f of row.querySelectorAll('.figure')) expect(f.textContent).not.toMatch(/万/);
    });
  });

  describe('short of room (the sidebar at 240 px)', () => {
    // jsdom lays nothing out: what each part of the meta line may do is read from the module's
    // rules, as matched on the rendered row. "思考中 · 已 0:04 · 输出 9.27万" lost its clock's
    // last digit: the activity shrank, clipping its own clock, while the tokens stayed whole.
    const sheet = join(import.meta.dirname, 'SessionRow.module.css');
    const rule = (el: Element | null | undefined, prop: string) =>
      el ? moduleCssValue(sheet, css, el, prop) : 'missing';
    const thinking: SessionSummary = {
      ...running,
      activity: { kind: 'thinking', tool: null, target: null, agentId: 'main', since: since(4) },
    };
    const parts = (row: HTMLElement) => {
      const meta = row.lastElementChild as HTMLElement;
      return { activity: meta.firstElementChild, when: meta.querySelector('[data-clip]') };
    };
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(DEMO_NOW);
    });
    afterEach(() => vi.useRealTimers());

    it('keeps a clock whole: with nothing in the activity to give way, the tokens give way', () => {
      const { activity, when } = parts(renderRow(thinking, false, vi.fn(), 'zh'));
      expect(activity).toHaveTextContent('思考中 · 已 0:04');
      expect(rule(activity, 'flex-shrink')).toBe('0');
      expect(rule(when, 'flex-shrink')).toBeUndefined();
      expect(rule(when, 'min-width')).toBe('0');
      expect(rule(when, 'text-overflow')).toBe('ellipsis');
    });

    it('keeps a state’s word whole beside its age, which gives way', () => {
      const { activity, when } = parts(renderRow(idle, false, vi.fn(), 'zh'));
      expect(rule(activity, 'flex-shrink')).toBe('0');
      expect(when).toHaveAttribute('data-age');
      expect(rule(when, 'flex-shrink')).toBeUndefined();
    });

    it('lets a target give way first, the tokens beside it whole', () => {
      const { activity, when } = parts(renderRow(reading, false, vi.fn(), 'zh'));
      expect(rule(activity, 'flex-shrink')).toBe('8');
      expect(rule(when, 'flex-shrink')).toBe('0');
    });

    it('leaves Home’s cards as they were', () => {
      const row = renderRow(thinking, false, vi.fn(), 'zh', { density: 'card' });
      expect(rule(parts(row).activity, 'flex-shrink')).toBe('8');
    });
  });

  it('words its age in Chinese too', () => {
    const row = renderRow(
      { ...idle, updatedAt: new Date(DEMO_NOW.getTime() - 2 * 3_600_000).toISOString() },
      false,
      vi.fn(),
      'zh',
    );
    expect(row).toHaveTextContent('2小时前');
  });
});

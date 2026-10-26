import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionActivity, SessionSummary } from '../../../src/core/model.js';
import { I18nContext, makeI18n } from '../i18n';
import { ActivityLine } from './ActivityLine';

const NOW = Date.parse('2026-10-24T10:00:00.000Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const session = (live: SessionSummary['live'], activity?: Partial<SessionActivity>) =>
  ({
    id: 's1',
    live,
    activity: activity && {
      kind: 'tool',
      tool: null,
      target: null,
      agentId: 'main',
      since: null,
      ...activity,
    },
  }) as SessionSummary;

function line(
  s: SessionSummary,
  { density = 'card', failure, locale = 'en' } = {} as {
    density?: 'compact' | 'card';
    failure?: string | null;
    locale?: 'en' | 'zh';
  },
) {
  const { container } = render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <ActivityLine session={s} failure={failure} density={density} />
    </I18nContext.Provider>,
  );
  return container.firstElementChild as HTMLElement;
}

describe('ActivityLine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['Read', 'tokens.css', 'Reading tokens.css'],
    ['read', 'tokens.css', 'Reading tokens.css'],
    ['Grep', 'sessionActivity', 'Searching sessionActivity'],
    ['Glob', '**/*.ts', 'Searching **/*.ts'],
    ['Edit', 'Home.tsx', 'Editing Home.tsx'],
    ['apply_patch', 'Home.tsx', 'Editing Home.tsx'],
    ['Bash', 'npm test +1', 'Running npm test +1'],
    ['shell', 'git commit', 'Running git commit'],
    ['WebFetch', 'api.github.com', 'Fetching api.github.com'],
    ['WebSearch', 'vite 6', 'Searching vite 6'],
    ['Agent', 'Explore the parser', 'Sub-agent: Explore the parser'],
    ['TodoWrite', null, 'Updating the plan'],
    ['mcp__linear__get_issue', 'GB-12', 'Using GB-12'],
    ['Read', null, 'Using Read'],
  ])('says %s on %j as %j', (tool, target, words) => {
    const el = line(session('busy', { tool, target }), { density: 'compact' });
    expect(el).toHaveTextContent(words);
    expect(el).toHaveAttribute('data-state', 'busy');
  });

  it('sets a target in the mono face, and its CJK in the UI face', () => {
    const el = line(session('busy', { tool: 'Read', target: '构建.md' }), { density: 'compact' });
    const target = el.querySelector('[class*="target"]');
    expect(target).toHaveTextContent('构建.md');
    expect(target?.querySelector('.figure-unit')).toHaveTextContent('构建');
  });

  it('clocks a tool on a card from its start, and not in a compact row', () => {
    const s = session('busy', { tool: 'Read', target: 'tokens.css', since: ago(4) });
    const card = line(s);
    expect(card).toHaveTextContent('Reading tokens.css · 0:04');
    expect(card.querySelector('.figure')).toHaveTextContent('0:04');
    expect(line(s, { density: 'compact' })).toHaveTextContent(/^Reading tokens\.css$/);
  });

  it('keeps the thinking clock in both densities: it is the phrase the call says', () => {
    const s = session('busy', { kind: 'thinking', since: ago(72) });
    expect(line(s)).toHaveTextContent('Thinking · 1:12');
    expect(line(s, { density: 'compact' })).toHaveTextContent('Thinking · 1:12');
    expect(line(session('busy', { kind: 'thinking' }))).toHaveTextContent(/^Thinking$/);
    expect(line(session('busy', { kind: 'writing', since: ago(30) }))).toHaveTextContent(
      'Replying · 0:30',
    );
  });

  it('ticks every second', () => {
    const el = line(session('busy', { kind: 'thinking', since: ago(72) }));
    act(() => vi.advanceTimersByTime(3000));
    expect(el).toHaveTextContent('Thinking · 1:15');
  });

  it('says what a waiting session waits for, the same words in a row as on a card, which clocks it', () => {
    const s = session('waiting', { kind: 'waiting', tool: 'Bash', since: ago(20) });
    const card = line(s);
    expect(card).toHaveTextContent('Permission · Bash · 0:20');
    expect(card).toHaveAttribute('data-state', 'waiting');
    // The tool is a name: the mono face, as a target.
    expect(card.querySelector('[class*="target"]')).toHaveTextContent('Bash');
    const row = line(s, { density: 'compact' });
    expect(row).toHaveTextContent(/^Permission · Bash$/);
    expect(row).toHaveAttribute('data-state', 'waiting');
    expect(
      line(session('waiting', { kind: 'waiting', tool: 'AskUserQuestion', since: ago(62) }), {
        density: 'compact',
      }),
    ).toHaveTextContent(/^Question$/);
    expect(line(session('waiting'), { density: 'compact' })).toHaveTextContent(/^Your turn$/);
    // A question, and the turn finished (no tool is blocked): your turn.
    expect(
      line(session('waiting', { kind: 'waiting', tool: 'AskUserQuestion', since: ago(62) })),
    ).toHaveTextContent(/^Question · 1:02$/);
    expect(
      line({ ...session('waiting', { kind: 'waiting' }), updatedAt: ago(220) }),
    ).toHaveTextContent(/^Your turn · 3:40$/);
    // Nothing says since when: no clock to give.
    expect(line(session('waiting'))).toHaveTextContent(/^Your turn$/);
  });

  it('words a wait in Chinese', () => {
    const s = session('waiting', { kind: 'waiting', tool: 'Bash', since: ago(20) });
    expect(line(s, { locale: 'zh' })).toHaveTextContent('权限 · Bash · 已 0:20');
    expect(line(s, { locale: 'zh', density: 'compact' })).toHaveTextContent(/^权限 · Bash$/);
    expect(line(session('waiting'), { locale: 'zh' })).toHaveTextContent(/^轮到你了$/);
  });

  it('says Idle of a session open in a terminal with nothing pending, and says so on hover', () => {
    for (const density of ['compact', 'card'] as const) {
      const idle = line(session('idle', { kind: 'idle', since: ago(600) }), { density });
      expect(idle).toHaveTextContent(/^Idle$/);
      expect(idle.querySelector('[title]')).toHaveAttribute(
        'title',
        'Open in a terminal, nothing pending',
      );
    }
    expect(line(session('idle'), { locale: 'zh' }).querySelector('[title]')).toHaveAttribute(
      'title',
      '在终端里打开着，没有待处理的事',
    );
    // The other states need no gloss.
    expect(line(session('closed')).querySelector('[title]')).toBeNull();
  });

  it('falls back to the live word when nothing more is known', () => {
    expect(line(session('busy'))).toHaveTextContent(/^Running$/);
    expect(line(session('idle', { kind: 'idle', since: ago(600) }))).toHaveTextContent(/^Idle$/);
    expect(line(session('closed'))).toHaveTextContent(/^Closed$/);
  });

  it('says a failed run failed, with its reason on a card', () => {
    const card = line(session('idle'), { failure: 'missing file' });
    expect(card).toHaveTextContent('Failed · missing file');
    expect(card).toHaveAttribute('data-state', 'failed');
    expect(
      line(session('idle'), { failure: 'missing file', density: 'compact' }),
    ).toHaveTextContent(/^Failed$/);
    expect(line(session('closed'), { failure: null })).toHaveTextContent(/^Failed$/);
    // Running again since: what it does now wins.
    expect(
      line(session('busy', { kind: 'thinking', since: ago(5) }), { failure: 'missing file' }),
    ).toHaveTextContent('Thinking · 0:05');
  });

  it('marks what may give way in a narrow row: a target or a reason, never a verb or a clock', () => {
    const giving = (el: HTMLElement) =>
      [...el.querySelectorAll('[data-gives-way]')].map((x) => x.textContent);
    const tool = session('busy', { tool: 'Read', target: 'tokens.css', since: ago(4) });
    expect(giving(line(tool))).toEqual(['tokens.css']);
    expect(giving(line(tool, { density: 'compact' }))).toEqual(['tokens.css']);
    expect(giving(line(session('busy', { kind: 'thinking', since: ago(72) })))).toEqual([]);
    expect(giving(line(session('busy', { tool: 'TodoWrite' })))).toEqual([]);
    expect(giving(line(session('waiting', { kind: 'waiting', tool: 'Bash' })))).toEqual(['Bash']);
    expect(giving(line(session('idle'), { failure: 'missing file' }))).toEqual(['missing file']);
    expect(giving(line(session('idle')))).toEqual([]);
  });

  it('words it in Chinese', () => {
    const s = session('busy', { tool: 'Read', target: 'tokens.css', since: ago(4) });
    expect(line(s, { locale: 'zh' })).toHaveTextContent('正在读取 tokens.css · 已 0:04');
    expect(line(session('idle'), { failure: '缺少文件', locale: 'zh' })).toHaveTextContent(
      '失败 · 缺少文件',
    );
  });
});

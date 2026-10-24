import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../../src/core/model.js';
import { I18nContext, type Locale, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { ResponseCard, ToolCard } from './cards';

const tool = (name: string, input: unknown): ToolCall => ({
  id: 'tool_1',
  agentId: 'main',
  requestId: 'req_1',
  name,
  input,
  status: 'complete',
  startedAt: null,
  endedAt: null,
  durationMs: 1200,
  resultPreview: 'ok',
  hasFullResult: false,
  spawned: null,
});

function renderCard(t: ToolCall, locale: Locale = 'en') {
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <ToolCard
        tool={t}
        open={demoOpen()}
        selected={false}
        onSelect={() => {}}
        onEnterAgent={() => {}}
      />
    </I18nContext.Provider>,
  );
  return screen.getByRole('group', { name: t.name });
}

describe('ToolCard', () => {
  it.each([
    [
      'Claude Code',
      'Read',
      { file_path: '/repo/src/server/app.ts' },
      'Explore',
      '/repo/src/server/app.ts',
    ],
    ['Claude Code', 'Bash', { command: 'git commit -m "Ship"' }, 'Git', 'git commit -m "Ship"'],
    ['Codex', 'exec_command', { cmd: 'npm test', workdir: '/repo' }, 'Run', 'npm test'],
    ['Codex', 'apply_patch', '*** Begin Patch\n*** Update File: src/a.ts\n', 'Edit', 'a.ts'],
    ['Grok', 'read_file', { target_file: 'src/app.ts' }, 'Explore', 'src/app.ts'],
    ['Grok', 'spawn_subagent', { description: 'Review the diff' }, 'Delegate', 'Review the diff'],
    ['oh-my-pi', 'web_search', { i: 'Checking', query: 'omp tools' }, 'Web', 'omp tools'],
    ['oh-my-pi', 'task', { i: 'Spawn sleep probe', tasks: [] }, 'Delegate', 'Spawn sleep probe'],
    ['OpenCode', 'grep', { pattern: 'kittiwake', path: '/repo' }, 'Explore', 'kittiwake'],
    [
      'OpenCode',
      'todowrite',
      { todos: [{ content: 'Port', status: 'in_progress' }] },
      'Plan',
      'Port',
    ],
  ])(
    '%s %s: names the tool and its category, and what the call did',
    (_agent, name, input, cat, summary) => {
      const card = renderCard(tool(name, input));
      // "Bash · run": the category is a word after the name; the icon is decoration beside it.
      expect(within(card).getByText(`· ${cat}`)).toBeInTheDocument();
      expect(within(card).queryByRole('img', { name: cat })).toBeNull();
      expect(within(card).getByText(summary)).toBeInTheDocument();
      expect(within(card).getByRole('button')).toHaveAccessibleName(
        expect.stringMatching(new RegExp(`^${name}\\s*· ${cat}`)),
      );
    },
  );

  // The demo session's cwd is /Users/demo/Dev/glassbox.
  it.each([
    [
      { file_path: '/Users/demo/Dev/glassbox/web/src/views/flow/cards.tsx' },
      'web/…/flow/cards.tsx',
    ],
    [{ file_path: '/Users/demo/Dev/glassbox/src/server/store.ts' }, 'src/server/store.ts'],
    [
      { file_path: '/Users/demo/Dev/glassbox/web/src/views/flow/cards.tsx', offset: 10, limit: 5 },
      'web/…/cards.tsx:10-14',
    ],
    [{ file_path: '/elsewhere/very/deep/tree/of/dirs/notes.md' }, '/…/tree/of/dirs/notes.md'],
  ])('shows a file by its path in the project, cut in the middle: %j', (input, shown) => {
    const card = renderCard(tool('Read', input));
    const summary = within(card).getByText(shown);
    expect(summary).toHaveAttribute('title', input.file_path);
  });

  it('names an MCP tool by its server and tool', () => {
    const card = renderCard(tool('mcp__github__create_issue', { title: 'Flaky test' }));
    expect(within(card).getByRole('img', { name: 'MCP' })).toBeInTheDocument();
    expect(within(card).getByText('github · create_issue')).toBeInTheDocument();
    expect(within(card).getByText('Flaky test')).toBeInTheDocument();
  });

  it('keeps a browser MCP tool under web', () => {
    const card = renderCard(tool('mcp__claude-in-chrome__navigate', { url: 'https://a.dev/x' }));
    expect(within(card).getByRole('img', { name: 'Web' })).toBeInTheDocument();
    expect(within(card).getByText('claude-in-chrome · navigate')).toBeInTheDocument();
    expect(within(card).getByText('a.dev')).toBeInTheDocument();
  });

  it('never shows the input as JSON', () => {
    const card = renderCard(tool('SomethingNew', { n: 3, deep: { a: 1 } }));
    expect(within(card).getByText('· Other')).toBeInTheDocument();
    expect(within(card).getByText('n: 3')).toBeInTheDocument();
    expect(card).not.toHaveTextContent('{');
  });

  // The line under the summary: a mark, a few words for the outcome, the duration.
  const resultOf = (card: HTMLElement) =>
    card.querySelector('[data-state]:not([data-state] [data-state])') as HTMLElement;

  it.each([
    ['SendMessage', { to: 'medaka-f5' }, '{"success":true,"message":"Message sent"}', 'delivered'],
    ['Bash', { command: 'cat package.json' }, '{"name":"glassbox","private":true}', '1 line'],
    ['Bash', { command: 'npm test' }, '(Bash completed with no output)', 'no output'],
    ['Grep', { pattern: 'x' }, 'a.ts:1:x\nb.ts:2:x\nc.ts:3:x', '3 matches'],
    ['Agent', { description: 'Explore' }, 'Async agent launched successfully.', 'launched · async'],
    ['SomethingNew', {}, 'whatever it said', 'done'],
  ])('%s: says what came of it in a few words, never its text', (name, input, preview, words) => {
    const card = renderCard({ ...tool(name, input), resultPreview: preview });
    const result = resultOf(card);
    expect(result).toHaveAttribute('data-state', 'complete');
    expect(result).toHaveTextContent(words);
    expect(within(result).getByText('1.2s')).toHaveClass('figure');
    expect(result.textContent).not.toMatch(/["“(]/);
  });

  it('says it in Chinese too', () => {
    const card = renderCard(
      { ...tool('Bash', { command: 'jq .ids f' }), resultPreview: '[1, 2]' },
      'zh',
    );
    expect(resultOf(card)).toHaveTextContent('1 行');
  });

  it("marks a failed call with W1's mark and word", () => {
    const card = renderCard({ ...tool('Edit', { file_path: '/r/a.ts' }), status: 'error' });
    const result = resultOf(card);
    expect(result).toHaveAttribute('data-state', 'error');
    expect(within(result).getByText('Failed', { selector: '[data-status-label]' })).toBeVisible();
  });

  it('names a sub-agent in words, with its errand under it', () => {
    const card = renderCard(
      tool('Agent', {
        description: 'Explore transcript format',
        prompt: 'Read **parser.ts** and list the record types.',
        subagent_type: 'Explore',
      }),
    );
    const name = within(card).getByText('Explore transcript format');
    expect(name.className).not.toMatch(/mono/);
    expect(name.className).toMatch(/name/);
    expect(within(card).getByText('Read parser.ts and list the record types.').className).toMatch(
      /detail/,
    );
  });

  it('keeps the mono summary for a tool card', () => {
    const card = renderCard(tool('Bash', { command: 'npm test' }));
    expect(within(card).getByText('npm test').className).toMatch(/mono/);
  });

  it('says "Run tool" for a call without input', () => {
    const card = renderCard(tool('SomethingNew', null));
    expect(within(card).getByText('Run tool')).toBeInTheDocument();
  });

  it('names the category in Chinese', () => {
    const card = renderCard(tool('Edit', { file_path: '/r/a.ts' }), 'zh');
    expect(within(card).getByText('· 修改')).toBeInTheDocument();
  });
});

describe('ResponseCard', () => {
  it('previews a markdown reply as plain text', () => {
    const req = demoOpen().requests.get('req_m3');
    if (!req) throw new Error('fixture');
    const text = '### Spec Compliance\n- **Spec compliant:** yes, see `cards.tsx`';
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <ResponseCard
          req={{ ...req, blocks: [{ kind: 'text', text, at: '2026-10-23T10:00:00.000Z' }] }}
          selected={false}
          onSelect={() => {}}
        />
      </I18nContext.Provider>,
    );
    expect(
      screen.getByText('Spec Compliance Spec compliant: yes, see cards.tsx'),
    ).toBeInTheDocument();
  });
});

describe('card styles', () => {
  const sheet = readFileSync(join(import.meta.dirname, 'cards.module.css'), 'utf8');

  it('puts the duration after a muted middle dot: "3 matches · 400ms"', () => {
    const dot = /\n\.resultTime::before \{([^}]*)\}/.exec(sheet)?.[1];
    expect(dot).toMatch(/content: "·" \/ "";/);
    expect(dot).toMatch(/color: var\(--muted\);/);
  });
});

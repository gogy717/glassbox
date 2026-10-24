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
    ['Claude Code', 'Read', { file_path: '/repo/src/server/app.ts' }, 'Explore', 'app.ts'],
    ['Claude Code', 'Bash', { command: 'git commit -m "Ship"' }, 'Git', 'git commit -m "Ship"'],
    ['Codex', 'exec_command', { cmd: 'npm test', workdir: '/repo' }, 'Run', 'npm test'],
    ['Codex', 'apply_patch', '*** Begin Patch\n*** Update File: src/a.ts\n', 'Edit', 'a.ts'],
    ['Grok', 'read_file', { target_file: 'src/app.ts' }, 'Explore', 'app.ts'],
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

  it('shows a JSON result as its message', () => {
    const card = renderCard({
      ...tool('SendMessage', { to: 'medaka-f5', message: 'Hi' }),
      resultPreview: '{"success":true,"message":"Message sent to medaka-f5"}',
    });
    expect(within(card).getByText('Message sent to medaka-f5')).toBeInTheDocument();
  });

  it('says what a JSON result is, instead of quoting a value out of data', () => {
    const json = '{"name":"glassbox","version":"0.2.0","private":true}';
    const card = renderCard({
      ...tool('Bash', { command: 'cat package.json' }),
      resultPreview: json,
    });
    expect(within(card).getByText('JSON · 3 keys')).toBeInTheDocument();
    expect(card).not.toHaveTextContent('glassbox');
  });

  it('says it in Chinese too', () => {
    const preview = '[1, 2]';
    const card = renderCard(
      { ...tool('Bash', { command: 'jq .ids f' }), resultPreview: preview },
      'zh',
    );
    expect(within(card).getByText('JSON · 2 项')).toBeInTheDocument();
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

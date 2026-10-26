import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  RuleRow,
  RulesResult,
  RulesWindowKind,
  SettingsHit,
} from '../../../../src/shared/permissions.js';
import { I18nContext, makeI18n } from '../../i18n';
import { moduleCssValue } from '../../test/module-css';
import { RulesPage } from './RulesPage';
import classes from './RulesPage.module.css';
import type { ReadRules } from './readRules';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
const SHOP = '/Users/demo/Dev/shopfront';
const INFRA = '/Users/demo/Dev/infra';

type Counts = [root: string, asked: number, denied?: number];

function row(key: string, counts: Counts[], o: Partial<RuleRow> = {}): RuleRow {
  const projects = counts.map(([root, asked, denied = 0]) => ({
    root,
    name: root.split('/').at(-1) ?? root,
    asked,
    allowed: asked - denied,
    denied,
    lastAsked: iso(2),
  }));
  const asked = projects.reduce((n, p) => n + p.asked, 0);
  const denied = projects.reduce((n, p) => n + p.denied, 0);
  return {
    key,
    tool: key.replace(/\(.*$/, ''),
    agent: 'claude-code',
    danger: null,
    asked,
    allowed: asked - denied,
    denied,
    lastAsked: iso(2),
    sessions: 2,
    projects,
    inSettings: [],
    suggested: false,
    ...o,
  };
}

const hit = (o: Partial<SettingsHit>): SettingsHit => ({
  path: '/Users/demo/.claude/settings.json',
  scope: 'global',
  root: null,
  list: 'allow',
  rule: 'x',
  ...o,
});

const ROWS: RuleRow[] = [
  row(
    'Bash(npm test:*)',
    [
      [SHOP, 12],
      [INFRA, 8],
    ],
    {
      inSettings: [hit({ rule: 'Bash(npm test:*)' })],
      lastAsked: iso(1),
    },
  ),
  row('Bash(npm run e2e:*)', [[SHOP, 8]], { suggested: true }),
  row(
    'mcp__tracker__create_issue',
    [
      [INFRA, 4],
      [SHOP, 3],
    ],
    {
      tool: 'mcp__tracker',
      suggested: true,
    },
  ),
  row('Bash(git push:*)', [[SHOP, 7, 1]], { danger: 'force-push' }),
  row('Bash(rm:*)', [[SHOP, 3, 2]], {
    danger: 'delete',
    inSettings: [
      hit({
        path: `${SHOP}/.claude/settings.local.json`,
        scope: 'project',
        root: SHOP,
        list: 'deny',
        rule: 'Bash(rm:*)',
      }),
    ],
  }),
  row('prefix_rule(pattern=["npm", "ci"])', [[SHOP, 3]], { agent: 'codex', tool: 'prefix_rule' }),
  row('Edit(~/notes/**)', [[INFRA, 2]], { danger: 'outside', lastAsked: iso(30) }),
];

function result(rows: RuleRow[] = ROWS, kind: RulesWindowKind = '30d'): RulesResult {
  return {
    window: { kind, from: NOW - 30 * 24 * HOUR, now: NOW },
    rows,
    settings: [
      {
        path: '/Users/demo/.claude/settings.json',
        scope: 'global',
        root: null,
        allow: ['Bash(npm test:*)'],
        deny: [],
      },
      {
        path: `${SHOP}/.claude/settings.local.json`,
        scope: 'project',
        root: SHOP,
        allow: [],
        deny: ['Bash(rm:*)'],
      },
    ],
    yourSettings: '/Users/demo/.claude/settings.json',
    asOf: NOW,
    stats: { considered: 5, read: 5, cached: 0, failed: 0, ms: 12 },
  };
}

function renderPage(read: ReadRules, kind: RulesWindowKind = '30d', locale: 'en' | 'zh' = 'en') {
  const onWindow = vi.fn();
  const view = render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <RulesPage window={kind} onWindow={onWindow} now={NOW} read={read} />
    </I18nContext.Provider>,
  );
  return { onWindow, ...view };
}

const answered = (r: RulesResult = result()) => vi.fn<ReadRules>(async () => r);
const table = () => screen.getByRole('table', { name: 'Permission rules asked for' });
const bodyRows = () => within(table()).getAllByRole('row').slice(1);
const rowOf = (key: string) => {
  const found = bodyRows().find((r) => within(r).queryByText(key));
  if (!found) throw new Error(`no row ${key}`);
  return found;
};
const cells = (key: string) =>
  within(rowOf(key))
    .getAllByRole('cell')
    .map((c) => c.textContent);
const blocks = () => screen.queryByRole('region', { name: 'To paste into permissions.allow' });

describe('the Rules page', () => {
  it('lists the rules the most asked first, with their counts, repositories and last time', async () => {
    renderPage(answered());
    await screen.findByRole('table', { name: 'Permission rules asked for' });
    expect(bodyRows().map((r) => within(r).getByRole('code').textContent)).toEqual(
      ROWS.map((r) => r.key),
    );
    expect(cells('Bash(git push:*)').slice(2, 6)).toEqual(['7', '6', '1', 'shopfront']);
    expect(cells('Bash(npm test:*)')[5]).toBe('shopfront, infra');
    expect(cells('Edit(~/notes/**)')[6]).toBe('yesterday');
  });

  it('marks the rules denied, the suggested and those that may do harm, and says why', async () => {
    renderPage(answered());
    await screen.findByRole('table');
    expect(
      within(rowOf('Bash(git push:*)')).getByText('1').closest('[data-denied]'),
    ).not.toBeNull();
    expect(
      within(rowOf('Bash(npm test:*)')).queryByText('0')?.closest('[data-denied]'),
    ).toBeFalsy();
    expect(within(rowOf('Bash(npm run e2e:*)')).getByText('Suggested')).toBeInTheDocument();
    expect(within(rowOf('Bash(git push:*)')).getByText('Can force-push')).toHaveAttribute(
      'title',
      'Never ticked for you',
    );
    expect(within(rowOf('Bash(rm:*)')).getByText('Deletes files')).toBeInTheDocument();
    expect(
      within(rowOf('Edit(~/notes/**)')).getByText('Writes outside the repository'),
    ).toBeInTheDocument();
  });

  it('says which settings already hold a rule, yours or a project’s, allowed or denied', async () => {
    renderPage(answered());
    await screen.findByRole('table');
    expect(cells('Bash(npm test:*)').at(-1)).toBe('Yours');
    expect(cells('Bash(rm:*)').at(-1)).toBe('Denied in shopfront');
    expect(cells('Bash(git push:*)').at(-1)).toBe('—');
  });

  it('ticks the suggestions and no rule that may do harm, and pastes what is ticked where it goes', async () => {
    renderPage(answered());
    await screen.findByRole('table');
    const box = (key: string) => within(rowOf(key)).queryByRole('checkbox');
    expect(box('Bash(npm run e2e:*)')).toBeChecked();
    expect(box('mcp__tracker__create_issue')).toBeChecked();
    expect(box('Bash(git push:*)')).not.toBeChecked();
    expect(box('Bash(npm test:*)')).not.toBeChecked();
    expect(box('prefix_rule(pattern=["npm", "ci"])')).toBeNull();

    const region = blocks();
    if (!region) throw new Error('no blocks');
    const codes = () =>
      within(region)
        .getAllByText(/"permissions"/)
        .map((c) => c.textContent);
    expect(codes()).toEqual([
      '{\n  "permissions": {\n    "allow": [\n      "mcp__tracker__create_issue"\n    ]\n  }\n}',
      '{\n  "permissions": {\n    "allow": [\n      "Bash(npm run e2e:*)"\n    ]\n  }\n}',
    ]);
    expect(region).toHaveTextContent('/Users/demo/.claude/settings.json');
    expect(region).toHaveTextContent(`${SHOP}/.claude/settings.local.json`);
    expect(region).toHaveTextContent('Checked against the permission lists of 2 settings files');

    fireEvent.click(box('Bash(git push:*)') as HTMLElement);
    fireEvent.click(box('mcp__tracker__create_issue') as HTMLElement);
    expect(codes()).toEqual([
      '{\n  "permissions": {\n    "allow": [\n      "Bash(npm run e2e:*)",\n      "Bash(git push:*)"\n    ]\n  }\n}',
    ]);
  });

  it('sets the rule, its repositories and its settings at the left, the counts at the right', async () => {
    renderPage(answered());
    await screen.findByRole('table');
    const align = (el: Element | undefined) =>
      el && moduleCssValue(join(import.meta.dirname, 'RulesPage.module.css'), classes, el, 'text-align');
    const [, rule, asked, , , repos, , held] = within(rowOf('Bash(npm test:*)')).getAllByRole('cell');
    expect([rule, repos, held].map(align)).toEqual(['left', 'left', 'left']);
    expect(align(asked)).toBe('right');
    expect(align(within(table()).getByRole('columnheader', { name: 'Rule' }))).toBe('left');
  });

  it('says to tick a rule when nothing is ticked', async () => {
    renderPage(answered(result(ROWS.map((r) => ({ ...r, suggested: false })))));
    await screen.findByRole('table');
    expect(blocks()).toHaveTextContent('Tick a rule above to add it here.');
  });

  it('filters by repository, with that repository’s counts, and by tool', async () => {
    renderPage(answered());
    await screen.findByRole('table');
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), {
      target: { value: INFRA },
    });
    expect(bodyRows().map((r) => within(r).getByRole('code').textContent)).toEqual([
      'Bash(npm test:*)',
      'mcp__tracker__create_issue',
      'Edit(~/notes/**)',
    ]);
    expect(cells('Bash(npm test:*)')[2]).toBe('8');
    fireEvent.change(screen.getByRole('combobox', { name: 'Tool' }), { target: { value: 'Bash' } });
    expect(bodyRows().map((r) => within(r).getByRole('code').textContent)).toEqual([
      'Bash(npm test:*)',
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Tool' }), { target: { value: 'Edit' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), {
      target: { value: SHOP },
    });
    expect(screen.getByText('Nothing matches the filters.')).toBeInTheDocument();
  });

  it('names an MCP server and Codex in the tool filter', async () => {
    renderPage(answered());
    await screen.findByRole('table');
    const options = within(screen.getByRole('combobox', { name: 'Tool' }))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['All tools', 'Bash', 'Edit', 'MCP: tracker', 'Codex commands']);
  });

  it('shows the first 100 rules, and the rest when asked', async () => {
    const many = Array.from({ length: 130 }, (_, i) => row(`Bash(task${i}:*)`, [[SHOP, 200 - i]]));
    renderPage(answered(result(many)));
    await screen.findByRole('table');
    expect(bodyRows()).toHaveLength(100);
    fireEvent.click(screen.getByRole('button', { name: 'Show 30 more' }));
    expect(bodyRows()).toHaveLength(130);
  });

  it('reads the window it shows, another when one is picked, and again on Refresh', async () => {
    const read = answered(result(ROWS, '7d'));
    const { onWindow } = renderPage(read, '7d');
    await screen.findByRole('table');
    expect(read).toHaveBeenLastCalledWith(
      '7d',
      false,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Last 30 days' }));
    expect(onWindow).toHaveBeenCalledWith('30d');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(read).toHaveBeenLastCalledWith(
      '7d',
      true,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    await screen.findByText(/^Data as of/);
  });

  it('says how far a first read has got, and why one failed', async () => {
    let fail: (e: Error) => void = () => {};
    const read = vi.fn<ReadRules>(
      (_kind, _refresh, onProgress) =>
        new Promise((_resolve, reject) => {
          onProgress(2, 5);
          fail = reject;
        }),
    );
    renderPage(read);
    expect(await screen.findByRole('status')).toHaveTextContent('Reading sessions… 2 of 5');
    await act(async () => fail(new Error('HTTP 500')));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read the sessions: HTTP 500');
  });

  it('says so when no rule was asked in the window', async () => {
    renderPage(answered(result([])));
    expect(await screen.findByText('No permission prompts in this window.')).toBeInTheDocument();
  });

  it('speaks Chinese', async () => {
    renderPage(answered(), '30d', 'zh');
    const zh = await screen.findByRole('table', { name: '被询问过的权限规则' });
    expect(within(zh).getAllByText('建议')).toHaveLength(2);
    expect(screen.getByRole('combobox', { name: '仓库' })).toBeInTheDocument();
  });
});

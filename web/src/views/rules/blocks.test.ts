import { describe, expect, it } from 'vitest';
import type { RuleRow } from '../../../../src/shared/permissions.js';
import { allowBlocks, allowJson } from './blocks';

const at = '2026-10-25T10:00:00.000Z';

function row(key: string, projects: string[], o: Partial<RuleRow> = {}): RuleRow {
  return {
    key,
    tool: 'Bash',
    agent: 'claude-code',
    danger: null,
    asked: 5,
    allowed: 5,
    denied: 0,
    lastAsked: at,
    sessions: 1,
    projects: projects.map((name) => ({
      root: `/work/${name}`,
      name,
      asked: 5,
      allowed: 5,
      denied: 0,
      lastAsked: at,
    })),
    inSettings: [],
    suggested: true,
    ...o,
  };
}

describe('the blocks to paste', () => {
  const rows = [
    row('Bash(npm test:*)', ['shop', 'blog']),
    row('Bash(make:*)', ['shop']),
    row('Bash(hugo:*)', ['blog']),
    row('WebSearch', ['blog', 'shop']),
    row('Bash(cargo test:*)', ['tool']),
    row('prefix_rule(pattern=["npm", "ci"])', ['shop'], { agent: 'codex', tool: 'prefix_rule' }),
  ];

  it('puts the chosen rules asked in two projects in yours, the rest in their project’s, projects by name', () => {
    const chosen = new Set(['Bash(npm test:*)', 'Bash(make:*)', 'Bash(hugo:*)', 'WebSearch']);
    expect(allowBlocks(rows, (r) => chosen.has(r.key))).toEqual([
      { scope: 'global', root: null, name: null, rules: ['Bash(npm test:*)', 'WebSearch'] },
      { scope: 'project', root: '/work/blog', name: 'blog', rules: ['Bash(hugo:*)'] },
      { scope: 'project', root: '/work/shop', name: 'shop', rules: ['Bash(make:*)'] },
    ]);
  });

  it('leaves out what is not chosen, and Codex’s rules, which live elsewhere', () => {
    expect(allowBlocks(rows, (r) => r.agent === 'codex' || r.key === 'Bash(cargo test:*)')).toEqual(
      [{ scope: 'project', root: '/work/tool', name: 'tool', rules: ['Bash(cargo test:*)'] }],
    );
    expect(allowBlocks(rows, () => false)).toEqual([]);
  });

  it('writes a block as settings JSON, ready to merge', () => {
    expect(allowJson(['Bash(npm test:*)', 'WebSearch'])).toBe(
      '{\n  "permissions": {\n    "allow": [\n      "Bash(npm test:*)",\n      "WebSearch"\n    ]\n  }\n}',
    );
  });
});

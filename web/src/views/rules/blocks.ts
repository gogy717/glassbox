/** The Rules page's blocks to paste: the rules ticked, by the settings file each goes in. */
import { type RuleRow, scopeOf } from '../../../../src/shared/permissions.js';

/** The rules for one settings file: yours (`global`), or one project's. */
export interface AllowBlock {
  scope: 'global' | 'project';
  /** The project's root; null for yours. */
  root: string | null;
  name: string | null;
  rules: string[];
}

/**
 * The chosen Claude Code rules by where they go (`scopeOf`), in the rows' order: yours first,
 * then each project's by name. Codex keeps its rules apart, so none of its rows go in.
 */
export function allowBlocks(
  rows: readonly RuleRow[],
  chosen: (row: RuleRow) => boolean,
): AllowBlock[] {
  const global: AllowBlock = { scope: 'global', root: null, name: null, rules: [] };
  const projects = new Map<string, AllowBlock>();
  for (const row of rows) {
    if (row.agent !== 'claude-code' || !chosen(row)) continue;
    const where = scopeOf(row);
    if (where.scope === 'global') {
      global.rules.push(row.key);
      continue;
    }
    const block = projects.get(where.root) ?? {
      scope: 'project',
      root: where.root,
      name: where.name,
      rules: [],
    };
    block.rules.push(row.key);
    projects.set(where.root, block);
  }
  const named = [...projects.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  return global.rules.length > 0 ? [global, ...named] : named;
}

/** A block as the settings JSON it belongs in: merge its `allow` into the file's. */
export const allowJson = (rules: readonly string[]): string =>
  JSON.stringify({ permissions: { allow: rules } }, null, 2);

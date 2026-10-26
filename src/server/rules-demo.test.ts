import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type RuleRow,
  type RulesLine,
  type RulesResult,
  type RulesWindowKind,
  rulesPath,
  scopeOf,
} from '../shared/permissions.js';
import { createApp } from './app.js';
import { DemoStore } from './demo-store.js';
import { createDemoRules } from './rules-demo.js';

let store: DemoStore;

beforeEach(() => {
  store = new DemoStore();
});

afterEach(async () => {
  await store.stop();
});

async function rules(kind: RulesWindowKind): Promise<RulesResult> {
  const app = createApp({ store, log: () => {} });
  const lines = (await (await app.request(rulesPath(kind))).text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RulesLine);
  const last = lines.at(-1);
  if (last?.type !== 'result') throw new Error(`no result: ${JSON.stringify(last)}`);
  return last.result;
}

describe('the demo’s Rules', () => {
  it('has a rule for each thing the page shows', async () => {
    const result = await rules('30d');
    const row = (key: string): RuleRow => {
      const found = result.rows.find((r) => r.key === key);
      if (!found) throw new Error(`no ${key} in ${result.rows.map((r) => r.key).join(', ')}`);
      return found;
    };
    // Asked often, always allowed: suggested, for your settings and for one project's.
    expect(row('mcp__tracker__create_issue').suggested).toBe(true);
    expect(scopeOf(row('mcp__tracker__create_issue'))).toEqual({ scope: 'global' });
    expect(row('Bash(npm run e2e:*)').suggested).toBe(true);
    expect(scopeOf(row('Bash(npm run e2e:*)'))).toMatchObject({
      scope: 'project',
      name: 'shopfront',
    });
    expect(row('WebFetch(domain:docs.example.dev)').suggested).toBe(true);
    // Denied, and each kind of harm.
    expect(row('Bash(git push:*)')).toMatchObject({ danger: 'force-push', suggested: false });
    expect(row('Bash(git push:*)').denied).toBeGreaterThan(0);
    expect(row('Bash(rm:*)').danger).toBe('delete');
    expect(row('Bash(sudo:*)').danger).toBe('sudo');
    expect(row('Bash(for:*)').danger).toBe('shell');
    expect(row('Bash(curl:*)').danger).toBe('pipe-to-shell');
    expect(row('Edit(~/notes/**)').danger).toBe('outside');
    // Held by your settings, and denied by a project's.
    expect(row('Bash(npm test:*)').inSettings[0]).toMatchObject({ scope: 'global', list: 'allow' });
    expect(row('Bash(rm:*)').inSettings[0]).toMatchObject({ scope: 'project', list: 'deny' });
    // Codex, in its own rule syntax: a command that asked to leave its sandbox, one refused.
    expect(row('prefix_rule(pattern=["npm", "ci"])')).toMatchObject({ agent: 'codex', denied: 0 });
    expect(row('prefix_rule(pattern=["git", "push"])')).toMatchObject({
      agent: 'codex',
      denied: 1,
    });
    expect(result.settings.map((f) => f.scope)).toContain('global');
  });

  it('has less to show over the last 7 days than over 30', async () => {
    const week = await rules('7d');
    const month = await rules('30d');
    const asked = (r: RulesResult) => r.rows.reduce((n, row) => n + row.asked, 0);
    expect(asked(week)).toBeGreaterThan(0);
    expect(asked(week)).toBeLessThan(asked(month));
  });

  it('keeps its history to the Rules page: the session list and the week never see it', () => {
    const ids = new Set(createDemoRules(Date.now()).sessions.map((s) => s.session.id));
    expect(ids.size).toBeGreaterThan(0);
    expect(store.listSessions().filter((s) => ids.has(s.id))).toEqual([]);
    expect(store.weekSessions().filter((s) => ids.has(s.id))).toEqual([]);
  });
});

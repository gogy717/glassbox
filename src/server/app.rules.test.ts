import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '../core/model.js';
import { type RulesLine, rulesPath } from '../shared/permissions.js';
import { type AppStore, createApp } from './app.js';
import { RulesService } from './rules.js';
import type { WeekStore } from './week.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');

function session(id: string, command: string): SessionSnapshot {
  const at = new Date(NOW - 3_600_000).toISOString();
  return {
    session: {
      id,
      agent: 'claude-code',
      nativeId: id,
      title: null,
      cwd: '/work/shop',
      project: 'shop',
      repo: { root: '/work/shop', dir: '/work/shop', name: 'shop' },
      startedAt: at,
      updatedAt: at,
      live: 'closed',
      version: null,
      model: null,
      usage: null,
      counts: null,
    },
    agents: [],
    turns: [],
    requests: [],
    toolCalls: [
      {
        id: `${id}-t`,
        agentId: 'main',
        requestId: 'r',
        name: 'Bash',
        input: { command },
        status: 'complete',
        startedAt: at,
        endedAt: null,
        durationMs: null,
        resultPreview: 'ok',
        hasFullResult: false,
        spawned: null,
      },
    ],
    workflows: [],
    diagnostics: { unknownRecordTypes: {}, parseErrors: 0, unavailable: [] },
  };
}

function rulesApp(source?: WeekStore) {
  const snaps = [session('a', 'npm test'), session('b', 'npm test -- x')];
  const store: WeekStore = source ?? {
    weekSessions: () => snaps.map((s) => s.session),
    readSession: async (id) => {
      const snapshot = snaps.find((s) => s.session.id === id);
      return snapshot ? { snapshot, bytes: 10 } : null;
    },
  };
  // The rules route needs nothing else from the store.
  return createApp({
    store: {} as AppStore,
    rules: new RulesService(store, { now: () => NOW }),
    log: () => {},
  });
}

const ndjson = async (res: Response): Promise<RulesLine[]> =>
  (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RulesLine);

describe('GET /api/rules', () => {
  it('streams progress, then the result, as NDJSON, over the last 30 days unless asked', async () => {
    const res = await rulesApp().request('/api/rules');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = await ndjson(res);
    expect(lines[0]).toEqual({ type: 'progress', done: 0, total: 2 });
    const last = lines.at(-1);
    expect(last?.type).toBe('result');
    if (last?.type !== 'result') return;
    expect(last.result.window.kind).toBe('30d');
    expect(last.result.rows.map((r) => [r.key, r.asked])).toEqual([['Bash(npm test:*)', 2]]);
  });

  it('takes the three windows only, behind the host guard', async () => {
    const app = rulesApp();
    const all = await ndjson(await app.request(rulesPath('all', true)));
    expect(all.at(-1)?.type).toBe('result');
    expect((await app.request('/api/rules?window=week')).status).toBe(400);
    const foreign = await app.request(rulesPath('7d'), { headers: { host: 'evil.example:7842' } });
    expect(foreign.status).toBe(403);
  });

  it('ends in an error line when the sessions cannot be read', async () => {
    const lines = await ndjson(
      await rulesApp({
        weekSessions: () => {
          throw new Error('disk gone');
        },
        readSession: async () => null,
      }).request(rulesPath('7d')),
    );
    expect(lines.at(-1)).toEqual({ type: 'error', error: 'disk gone' });
  });

  it('is not there without a rules service', async () => {
    const app = createApp({ store: {} as AppStore, log: () => {} });
    expect((await app.request(rulesPath('7d'))).status).toBe(404);
  });
});

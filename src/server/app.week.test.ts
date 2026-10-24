import { describe, expect, it } from 'vitest';
import { createDemoSideSnapshots, createDemoSnapshot } from '../core/fixtures/demo.js';
import { type WeekLine, weekPath } from '../shared/week.js';
import { type AppStore, createApp } from './app.js';
import { WeekService, type WeekStore } from './week.js';

const NOW = new Date(2026, 10, 21, 20, 41).getTime();

function weekApp() {
  const snaps = [createDemoSnapshot(new Date(NOW)), ...createDemoSideSnapshots(new Date(NOW))];
  const reads: string[] = [];
  const source: WeekStore = {
    weekSessions: () => snaps.map((s) => s.session),
    readSession: async (id) => {
      reads.push(id);
      await new Promise((r) => setTimeout(r, 5));
      const snapshot = snaps.find((s) => s.session.id === id);
      return snapshot ? { snapshot, bytes: 10 } : null;
    },
  };
  const week = new WeekService(source, { now: () => NOW });
  // The week route needs nothing else from the store.
  const app = createApp({ store: {} as AppStore, week, log: () => {} });
  return { app, reads };
}

const ndjson = async (res: Response): Promise<WeekLine[]> =>
  (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as WeekLine);

describe('GET /api/week', () => {
  it('streams progress, then the result, as NDJSON', async () => {
    const { app } = weekApp();
    const res = await app.request(weekPath('week'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = await ndjson(res);
    const progress = lines.filter((l) => l.type === 'progress');
    expect(progress[0]).toEqual({ type: 'progress', done: 0, total: 3 });
    const dones = progress.map((l) => (l.type === 'progress' ? l.done : -1));
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
    const last = lines.at(-1);
    expect(last?.type).toBe('result');
    if (last?.type !== 'result') return;
    expect(last.result.window.kind).toBe('week');
    expect(last.result.sessions).toHaveLength(3);
    expect(last.result.sessions[0]?.hours).toHaveLength(168);
  });

  it('computes once for requests made together', async () => {
    const { app, reads } = weekApp();
    const [a, b] = await Promise.all([app.request(weekPath('7d')), app.request(weekPath('7d'))]);
    const [la, lb] = await Promise.all([ndjson(a), ndjson(b)]);
    expect(reads).toHaveLength(3);
    expect(la.at(-1)).toEqual(lb.at(-1));
  });

  it('is behind the host guard, and takes only the two windows', async () => {
    const { app } = weekApp();
    const foreign = await app.request(weekPath('week'), { headers: { host: 'evil.example:7842' } });
    expect(foreign.status).toBe(403);
    const bad = await app.request('/api/week?window=month');
    expect(bad.status).toBe(400);
  });

  it('ends in an error line when the week cannot be read (M4)', async () => {
    const source: WeekStore = {
      weekSessions: () => {
        throw new Error('disk gone');
      },
      readSession: async () => null,
    };
    const app = createApp({
      store: {} as AppStore,
      week: new WeekService(source, { now: () => NOW }),
      log: () => {},
    });
    const lines = await ndjson(await app.request(weekPath('week')));
    expect(lines.at(-1)).toEqual({ type: 'error', error: 'disk gone' });
  });

  it('serves the store’s own week by default', async () => {
    const snaps = [createDemoSnapshot(new Date(NOW))];
    const week = new WeekService(
      { weekSessions: () => snaps.map((s) => s.session), readSession: async () => null },
      { now: () => NOW },
    );
    const app = createApp({ store: { week } as AppStore, log: () => {} });
    const lines = await ndjson(await app.request(weekPath('7d')));
    expect(lines.at(-1)?.type).toBe('result');
  });

  it('is not found without a week source', async () => {
    const app = createApp({ store: {} as AppStore, log: () => {} });
    expect((await app.request(weekPath('week'))).status).toBe(404);
  });
});

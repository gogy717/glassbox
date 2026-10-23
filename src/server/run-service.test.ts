import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoSessions } from '../core/fixtures/demo.js';
import type { SessionSummary } from '../core/model.js';
import { blankRun, StubRuns } from './__tests__/stub-runs.js';
import { linkRunSessions, recentDirectories, sessionResolver } from './run-service.js';

const base = createDemoSessions(new Date('2026-10-23T02:00:00.000Z'))[0] as SessionSummary;
const summary = (id: string, cwd: string | null, updatedAt: string, live = 'closed') =>
  ({
    ...base,
    id: `claude-code:${id}`,
    nativeId: id,
    cwd,
    updatedAt,
    live,
  }) as SessionSummary;

describe('sessionResolver', () => {
  it('resolves a glassbox session id to what a run needs', () => {
    const resolve = sessionResolver({
      listSessions: () => [summary('a', '/repo/a', '2026-10-23T01:00:00.000Z', 'idle')],
    });
    expect(resolve('claude-code:a')).toEqual({ nativeId: 'a', cwd: '/repo/a', live: 'idle' });
    expect(resolve('claude-code:nope')).toBeNull();
  });
});

describe('recentDirectories', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'glassbox-dirs-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists existing session directories, most recently updated first, without repeats', async () => {
    for (const d of ['a', 'b', 'c']) await mkdir(join(root, d));
    await writeFile(join(root, 'file'), '');
    const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 1, min)).toISOString();
    const sessions = [
      // Busy first, as the session list orders them; directories order by time only.
      summary('s1', join(root, 'a'), at(1), 'busy'),
      summary('s2', join(root, 'b'), at(5)),
      summary('s3', join(root, 'gone'), at(9)),
      summary('s4', join(root, 'file'), at(8)),
      summary('s5', null, at(7)),
      summary('s6', join(root, 'b'), at(3)),
      summary('s7', join(root, 'c'), at(4)),
    ];
    expect(await recentDirectories(sessions)).toEqual([
      join(root, 'b'),
      join(root, 'c'),
      join(root, 'a'),
    ]);
  });

  it('returns at most 20', async () => {
    const sessions: SessionSummary[] = [];
    for (let i = 0; i < 25; i++) {
      await mkdir(join(root, `d${i}`));
      sessions.push(
        summary(`s${i}`, join(root, `d${i}`), new Date(Date.UTC(2026, 9, 23, 1, i)).toISOString()),
      );
    }
    const dirs = await recentDirectories(sessions);
    expect(dirs).toHaveLength(20);
    expect(dirs[0]).toBe(join(root, 'd24'));
  });
});

describe('linkRunSessions', () => {
  it('asks the store to look for each new run session once', () => {
    const runs = new StubRuns();
    const expected: string[] = [];
    const off = linkRunSessions(runs, {
      expectSession: async (id) => {
        expected.push(id);
        return true;
      },
    });

    runs.emit(blankRun('run-1')); // no session id yet
    runs.emit({ ...blankRun('run-1'), sessionId: 'claude-code:s1' });
    runs.emit({ ...blankRun('run-1'), sessionId: 'claude-code:s1', status: 'idle' });
    runs.emit({ ...blankRun('run-2'), sessionId: 'claude-code:s2' });
    expect(expected).toEqual(['claude-code:s1', 'claude-code:s2']);

    off();
    runs.emit({ ...blankRun('run-3'), sessionId: 'claude-code:s3' });
    expect(expected).toHaveLength(2);
    expect(runs.listenerCount).toBe(0);
  });
});

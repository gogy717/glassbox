import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at } from './__fixtures__/builders.js';
import { createGrokAdapter } from './index.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const DEAD_PID = 2147483646;

let grokDir: string;

async function put(path: string, content: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

function summary(id: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    info: { id, cwd: '/work/garden' },
    generated_title: 'Garden plan',
    session_summary: '',
    created_at: at(0),
    updated_at: at(30),
    current_model_id: 'grok-4.7',
    reasoning_effort: 'xhigh',
    ...over,
  });
}

beforeEach(async () => {
  grokDir = await realpath(await mkdtemp(join(tmpdir(), 'glassbox-grok-')));
});
afterEach(async () => {
  await rm(grokDir, { recursive: true, force: true });
});

describe('discover', () => {
  it('reads each session from summary.json and the install version', async () => {
    const dir = join(grokDir, 'sessions', '%2Fwork%2Fgarden', S1);
    await put(join(dir, 'summary.json'), summary(S1));
    await put(join(dir, 'updates.jsonl'), 'this catalog scan must not care\n');
    await put(join(grokDir, 'version.json'), JSON.stringify({ version: '1.0.67' }));
    const sources = await createGrokAdapter({ grokDir }).discover();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ agent: 'grok', nativeId: S1, location: dir });
    expect(sources[0]?.summary).toEqual({
      id: `grok:${S1}`,
      agent: 'grok',
      nativeId: S1,
      title: 'Garden plan',
      cwd: '/work/garden',
      project: 'garden',
      startedAt: at(0),
      updatedAt: at(30),
      live: 'closed',
      version: '1.0.67',
      model: 'grok-4.7',
      usage: null,
      counts: null,
    });
  });

  it('uses session_summary when no title was generated, and drops a blank one', async () => {
    const dir = join(grokDir, 'sessions', 'group', S1);
    await put(
      join(dir, 'summary.json'),
      summary(S1, { generated_title: '', session_summary: 'Herb notes' }),
    );
    await put(
      join(grokDir, 'sessions', 'group', S2, 'summary.json'),
      summary(S2, {
        generated_title: '   ',
        session_summary: '   ',
        updated_at: undefined,
        last_active_at: at(12),
      }),
    );
    const sources = await createGrokAdapter({ grokDir }).discover();
    const byId = new Map(sources.map((s) => [s.nativeId, s.summary]));
    expect(byId.get(S1)).toMatchObject({ title: 'Herb notes' });
    expect(byId.get(S2)).toMatchObject({ title: null, updatedAt: at(12) });
  });

  it('marks a listed session busy only while its pid is alive', async () => {
    await put(join(grokDir, 'sessions', 'group', S1, 'summary.json'), summary(S1));
    await put(
      join(grokDir, 'sessions', 'group', S2, 'summary.json'),
      summary(S2, { info: { id: S2, cwd: '/work/other' } }),
    );
    await put(
      join(grokDir, 'active_sessions.json'),
      JSON.stringify([
        { session_id: S1, pid: process.pid, pid_start: 1, cwd: '/work/garden', opened_at: at(1) },
        { session_id: S2, pid: DEAD_PID, pid_start: 1, cwd: '/work/other', opened_at: at(1) },
      ]),
    );
    const sources = await createGrokAdapter({ grokDir }).discover();
    const live = new Map(sources.map((s) => [s.nativeId, s.summary.live]));
    expect(live.get(S1)).toBe('busy');
    expect(live.get(S2)).toBe('closed');
    expect(await createGrokAdapter({ grokDir }).liveStatus()).toEqual(new Map([[S1, 'busy']]));
  });

  it('salvages a corrupt active-sessions file and ignores one that cannot be read', async () => {
    await put(join(grokDir, 'sessions', 'group', S1, 'summary.json'), summary(S1));
    await put(join(grokDir, 'active_sessions.json'), '{');
    await put(
      join(grokDir, 'active_sessions.json.corrupt'),
      JSON.stringify([{ session_id: S1, pid: process.pid }]),
    );
    const adapter = createGrokAdapter({ grokDir });
    expect((await adapter.discover())[0]?.summary.live).toBe('busy');

    await put(join(grokDir, 'active_sessions.json.corrupt'), 'still { broken');
    expect((await adapter.discover())[0]?.summary.live).toBe('closed');
    expect(await adapter.liveStatus()).toEqual(new Map());
  });

  it('skips catalogs without an id, group indexes, and a second path to the same directory', async () => {
    const real = join(grokDir, 'sessions', 'real-group');
    await put(join(real, S1, 'summary.json'), summary(S1));
    await put(join(real, 'prompt_history.jsonl'), '{}\n');
    await put(join(grokDir, 'sessions', 'session_search.sqlite'), 'not a database');
    await put(
      join(grokDir, 'sessions', 'no-id', S2, 'summary.json'),
      JSON.stringify({ session_summary: 'no id' }),
    );
    await put(join(grokDir, 'sessions', 'broken', S2, 'summary.json'), '{');
    await symlink(real, join(grokDir, 'sessions', 'alias-group'));
    const sources = await createGrokAdapter({ grokDir }).discover();
    expect(sources.map((s) => s.nativeId)).toEqual([S1]);
  });

  it('returns nothing when the sessions directory is missing', async () => {
    expect(await createGrokAdapter({ grokDir }).discover()).toEqual([]);
  });
});

describe('files', () => {
  it('lists parser inputs and watches the session directory for sub-agents', async () => {
    const dir = join(grokDir, 'sessions', 'group', S1);
    await put(join(dir, 'summary.json'), summary(S1));
    await put(join(dir, 'updates.jsonl'), '{}\n');
    await put(join(dir, 'events.jsonl'), '{}\n');
    await put(join(dir, 'chat_history.jsonl'), '{}\n');
    await put(join(dir, 'usage.json'), '{}');
    await put(join(dir, 'tool_definitions.json'), '[]');
    await put(join(dir, 'updates.jsonl.lock'), '');
    await put(join(dir, 'signals.json'), '{}');
    await put(join(dir, 'system_prompt.txt'), 'secret-looking but not a credential file');
    await put(join(dir, 'terminal', 'call-1.log'), 'command output');
    await put(join(dir, 'subagents', 'child', 'meta.json'), '{}');
    await put(join(dir, 'subagents', 'child', 'events.jsonl'), '{}\n');
    const adapter = createGrokAdapter({ grokDir });
    const [source] = await adapter.discover();
    if (!source) throw new Error('missing session');
    const files = await adapter.listFiles(source);
    expect(files.map((f) => `${f.role}:${f.format}`).sort()).toEqual([
      'chat-history:jsonl',
      'events:jsonl',
      'subagent-meta:json',
      'subagent:jsonl',
      'summary:json',
      'tool-definitions:json',
      'updates:jsonl',
      'usage:json',
    ]);
    expect(adapter.classify(source, join(dir, 'events.jsonl'))).toMatchObject({
      role: 'events',
      format: 'jsonl',
      agentId: null,
    });
    expect(adapter.classify(source, join(dir, 'updates.jsonl.lock'))).toBeNull();
    expect(adapter.classify(source, join(dir, 'terminal', 'call-1.log'))).toBeNull();
    expect(adapter.classify(source, join(dir, '..', 'prompt_history.jsonl'))).toBeNull();
    expect(adapter.watchDirs(source)).toEqual([dir, join(dir, 'subagents')]);
    expect(adapter.kind).toBe('grok');
    expect(adapter.createParser(source).snapshot().session.nativeId).toBe(S1);
  });
});

describe('discover never fails as a whole', () => {
  it('a summary with impossible times is listed with those times missing, and others still load', async () => {
    await put(
      join(grokDir, 'sessions', '%2Fwork', 'a', 'summary.json'),
      summary(S1, { created_at: 1e300, updated_at: 1e300 }),
    );
    await put(join(grokDir, 'sessions', '%2Fwork', 'b', 'summary.json'), summary(S2));
    const mtime = new Date('2026-01-02T03:04:05.000Z');
    await utimes(join(grokDir, 'sessions', '%2Fwork', 'a', 'summary.json'), mtime, mtime);
    const sources = await createGrokAdapter({ grokDir }).discover();
    expect(sources.map((s) => [s.nativeId, s.summary.startedAt]).sort()).toEqual([
      [S1, null],
      [S2, at(0)],
    ]);
    // Without usable times it sorts by when its catalog was written, not as "now".
    expect(sources.find((s) => s.nativeId === S1)?.summary.updatedAt).toBe(mtime.toISOString());
  });

  it('an unreadable summary skips only its own session', async () => {
    await put(join(grokDir, 'sessions', '%2Fwork', 'a', 'summary.json'), '{"info": {"id": ');
    await put(join(grokDir, 'sessions', '%2Fwork', 'b', 'summary.json'), summary(S2));
    const sources = await createGrokAdapter({ grokDir }).discover();
    expect(sources.map((s) => s.nativeId)).toEqual([S2]);
  });
});

describe('live status details', () => {
  /** This process's start time in microseconds since the epoch, as Grok writes `pid_start`. */
  const ownStartUs = () => Math.round((Date.now() - process.uptime() * 1000) * 1000);
  const register = (rows: object[]) =>
    put(join(grokDir, 'active_sessions.json'), JSON.stringify(rows));
  const events = (id: string, types: object[]) =>
    put(
      join(grokDir, 'sessions', 'group', id, 'events.jsonl'),
      `${types.map((e) => JSON.stringify({ ts: at(1), ...e })).join('\n')}\n`,
    );

  it('a pid whose start time does not match pid_start is a reused pid: closed', async () => {
    await put(join(grokDir, 'sessions', 'group', S1, 'summary.json'), summary(S1));
    await put(join(grokDir, 'sessions', 'group', S2, 'summary.json'), summary(S2));
    await register([
      { session_id: S1, pid: process.pid, pid_start: ownStartUs() },
      { session_id: S2, pid: process.pid, pid_start: ownStartUs() - 3_600_000_000 },
    ]);
    expect(await createGrokAdapter({ grokDir }).liveStatus()).toEqual(new Map([[S1, 'busy']]));
  });

  it('reads idle, busy and waiting from the session’s events', async () => {
    const S3 = '33333333-3333-4333-8333-333333333333';
    for (const id of [S1, S2, S3])
      await put(join(grokDir, 'sessions', 'group', id, 'summary.json'), summary(id));
    await events(S1, [
      { type: 'turn_started', turn_number: 0 },
      { type: 'loop_started', loop_index: 0 },
      { type: 'turn_ended', outcome: 'completed' },
    ]);
    await events(S2, [
      { type: 'turn_started', turn_number: 0 },
      { type: 'phase_changed', phase: 'streaming_text' },
    ]);
    await events(S3, [{ type: 'turn_started', turn_number: 0 }, { type: 'permission_requested' }]);
    await register(
      [S1, S2, S3].map((id) => ({ session_id: id, pid: process.pid, pid_start: ownStartUs() })),
    );
    expect(Object.fromEntries(await createGrokAdapter({ grokDir }).liveStatus())).toEqual({
      [S1]: 'idle',
      [S2]: 'busy',
      [S3]: 'waiting',
    });
  });
});

describe('the Grok adapter', () => {
  it('reports usage per turn: a turn’s tokens arrive only as it ends', async () => {
    const { createGrokAdapter } = await import('./index.js');
    expect(createGrokAdapter({ grokDir: '/nowhere' }).usageReporting).toBe('turn');
  });
});

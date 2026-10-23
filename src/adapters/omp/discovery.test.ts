import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionSource } from '../../core/adapter.js';
import {
  at,
  CHILD_ID,
  header,
  SESSION_ID,
  Transcript,
  titleSlot,
} from './__fixtures__/builders.js';
import {
  classifyPath,
  discoverSessions,
  listSessionFiles,
  newCache,
  readArtifact,
  readLiveStatus,
  sessionWatchDirs,
} from './discovery.js';
import { createOmpAdapter } from './index.js';
import { leaseName } from './live.js';

let ompDir: string;
let agentDir: string;
const group = () => join(agentDir, 'sessions', '-work-garden');
const sessionPath = (id = SESSION_ID) => join(group(), `2026-01-01T00-00-00-000Z_${id}.jsonl`);

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function session(id: string, lines: string[] = [], title = '🌱 GARDEN: Plan the garden'): string {
  return `${[titleSlot(title, 8), header({ id }), ...lines].join('\n')}\n`;
}

const answered = () => {
  const t = new Transcript();
  t.user('Plan it', 1);
  t.answer({ sec: 2, text: 'Planned.' });
  return t.lines;
};

beforeEach(async () => {
  ompDir = await realpath(await mkdtemp(join(tmpdir(), 'glassbox-omp-')));
  agentDir = join(ompDir, 'agent');
});
afterEach(async () => {
  await rm(ompDir, { recursive: true, force: true });
});

describe('discoverSessions', () => {
  it('reads each session from its title slot and header, and the build from its tail', async () => {
    await put(sessionPath(), session(SESSION_ID, answered()));
    await utimes(sessionPath(), new Date(at(30)), new Date(at(30)));
    const sources = await discoverSessions(agentDir, ompDir, newCache(), null);
    expect(sources).toEqual([
      {
        agent: 'oh-my-pi',
        nativeId: SESSION_ID,
        location: sessionPath(),
        summary: {
          id: `oh-my-pi:${SESSION_ID}`,
          agent: 'oh-my-pi',
          nativeId: SESSION_ID,
          title: 'GARDEN: Plan the garden',
          cwd: '/work/garden',
          project: 'garden',
          startedAt: at(0),
          updatedAt: at(30),
          live: 'closed',
          version: '18.12.6',
          model: null,
          usage: null,
          counts: null,
        },
      },
    ]);
  });

  it('skips backups, advisor transcripts, sub-agents and files without a header', async () => {
    await put(sessionPath(), session(SESSION_ID));
    await put(`${sessionPath()}.1234.bak`, session(SESSION_ID));
    await put(join(group(), '__advisor.jsonl'), session('advisor'));
    await put(join(group(), 'empty.jsonl'), '');
    await put(join(group(), 'torn.jsonl'), '{"type":"title"');
    await put(
      join(group(), `2026-01-01T00-00-00-000Z_${SESSION_ID}`, 'Scout.jsonl'),
      session(CHILD_ID),
    );
    const sources = await discoverSessions(agentDir, ompDir, newCache(), null);
    expect(sources.map((s) => s.nativeId)).toEqual([SESSION_ID]);
  });

  it('keeps the newest copy of a session found twice, and survives a missing dir', async () => {
    await put(sessionPath(), session(SESSION_ID, [], 'Old'));
    const moved = join(agentDir, 'sessions', '-elsewhere', 'moved.jsonl');
    await put(moved, session(SESSION_ID, [], 'New'));
    await utimes(sessionPath(), new Date(at(10)), new Date(at(10)));
    await utimes(moved, new Date(at(20)), new Date(at(20)));
    const sources = await discoverSessions(agentDir, ompDir, newCache(), null);
    expect(sources.map((s) => [s.location, s.summary.title])).toEqual([[moved, 'New']]);
    expect(await discoverSessions(join(ompDir, 'nope'), ompDir, newCache(), null)).toEqual([]);
  });

  it('reads a file again only once it changed', async () => {
    const cache = newCache();
    await put(sessionPath(), session(SESSION_ID, [], 'First'));
    expect((await discoverSessions(agentDir, ompDir, cache, null))[0]?.summary.title).toBe('First');
    // The slot is rewritten in place: same size, new mtime.
    await put(sessionPath(), session(SESSION_ID, [], 'Other'));
    await utimes(sessionPath(), new Date(at(40)), new Date(at(40)));
    expect((await discoverSessions(agentDir, ompDir, cache, null))[0]?.summary.title).toBe('Other');
    expect(cache.heads.size).toBe(1);
    await rm(sessionPath());
    await discoverSessions(agentDir, ompDir, cache, null);
    expect(cache.heads.size).toBe(0);
  });
});

describe('files of a session', () => {
  let source: SessionSource;
  const stem = () => sessionPath().slice(0, -'.jsonl'.length);

  beforeEach(async () => {
    await put(sessionPath(), session(SESSION_ID));
    [source] = (await discoverSessions(agentDir, ompDir, newCache(), null)) as [SessionSource];
  });

  it('lists the session and its sub-agents, nested by spawner', async () => {
    await put(join(stem(), 'Scout.jsonl'), session('s1'));
    await put(join(stem(), 'Scout', 'Helper.jsonl'), session('s2'));
    await put(join(stem(), 'Scout', 'Helper', 'Deep.jsonl'), session('s3'));
    await put(join(stem(), 'Stray', 'Lost.jsonl'), session('s4'));
    await put(join(stem(), '__advisor.jsonl'), session('a'));
    await put(join(stem(), '0.read.log'), 'output');
    await put(join(stem(), 'Scout.md'), 'result');
    expect((await listSessionFiles(source)).map((f) => [f.role, f.agentId])).toEqual([
      ['main', null],
      ['subagent', 'Scout'],
      ['subagent', 'Scout/Helper'],
      ['subagent', 'Scout/Helper/Deep'],
    ]);
  });

  it('classifies what a watcher reports', () => {
    expect(classifyPath(source, sessionPath())).toMatchObject({ role: 'main', format: 'jsonl' });
    expect(classifyPath(source, join(stem(), 'Scout.jsonl'))).toMatchObject({
      role: 'subagent',
      agentId: 'Scout',
    });
    expect(classifyPath(source, join(stem(), 'Scout', 'Helper.jsonl'))?.agentId).toBe(
      'Scout/Helper',
    );
    for (const other of [
      join(group(), 'other.jsonl'),
      join(stem(), '0.read.log'),
      join(stem(), 'Scout.jsonl.tombstone'),
      join(stem(), '__advisor.1.jsonl'),
      join(stem(), 'x.jsonl.123.bak'),
      stem(),
    ])
      expect(classifyPath(source, other)).toBeNull();
  });

  it('watches the session dir, the dir beside it, and each sub-agent’s dir', () => {
    expect(sessionWatchDirs(source, ['Scout', 'Scout/Helper'])).toEqual([
      group(),
      stem(),
      join(stem(), 'Scout'),
      join(stem(), 'Scout', 'Helper'),
    ]);
  });

  it('reads an artifact on demand, regular files only, capped', async () => {
    await put(join(stem(), '5.read.log'), 'the whole output');
    await put(join(stem(), '50.bash.log'), 'another');
    expect(readArtifact(source, '5')).toBe('the whole output');
    expect(readArtifact(source, '50')).toBe('another');
    expect(readArtifact(source, '7')).toBeNull();
    expect(readArtifact(source, '../5')).toBeNull();
    await symlink(join(ompDir, 'agent'), join(stem(), '6.read.log'));
    expect(readArtifact(source, '6')).toBeNull();
    await put(join(stem(), '9.bash.log'), 'y'.repeat(9 * 1024 * 1024));
    const big = readArtifact(source, '9') as string;
    expect(big.startsWith('yyyy')).toBe(true);
    expect(big).toMatch(
      /\[glassbox: the first 8\.0 MB of 9\.0 MB; the rest is in .*9\.bash\.log\]$/,
    );
  });
});

describe('readLiveStatus', () => {
  it('is busy or idle for sessions whose lease is held, closed for the rest', async () => {
    const idle = sessionPath();
    await put(idle, session(SESSION_ID, answered()));
    const busyId = '33333333-3333-4333-8333-333333333333';
    const t = new Transcript();
    t.user('Go', 1);
    await put(sessionPath(busyId), session(busyId, t.lines));
    const closedId = '44444444-4444-4444-8444-444444444444';
    await put(sessionPath(closedId), session(closedId, t.lines));
    const held = new Set([leaseName(ompDir, SESSION_ID), leaseName(ompDir, busyId)] as string[]);
    const sources = await discoverSessions(agentDir, ompDir, newCache(), held);
    const live = Object.fromEntries(sources.map((s) => [s.nativeId, s.summary.live]));
    expect(live).toEqual({ [SESSION_ID]: 'idle', [busyId]: 'busy', [closedId]: 'closed' });
    expect(await readLiveStatus(ompDir, sources, newCache(), null)).toEqual(new Map());
  });

  it('is busy while a sub-agent works for an idle parent', async () => {
    await put(sessionPath(), session(SESSION_ID, answered()));
    const stem = sessionPath().slice(0, -'.jsonl'.length);
    const t = new Transcript('k');
    t.user('Count beds', 1, { attribution: 'agent' });
    await put(join(stem, 'Scout.jsonl'), session(CHILD_ID, t.lines));
    const cache = newCache();
    const sources = await discoverSessions(agentDir, ompDir, cache, null);
    const parentOnly = new Set([leaseName(ompDir, SESSION_ID)] as string[]);
    expect(await readLiveStatus(ompDir, sources, cache, parentOnly)).toEqual(
      new Map([[SESSION_ID, 'idle']]),
    );
    const both = new Set([...parentOnly, leaseName(ompDir, CHILD_ID) as string]);
    expect(await readLiveStatus(ompDir, sources, cache, both)).toEqual(
      new Map([[SESSION_ID, 'busy']]),
    );
  });
});

describe('createOmpAdapter', () => {
  it('reads sessions from <ompDir>/agent unless told otherwise', async () => {
    await put(sessionPath(), session(SESSION_ID, answered()));
    expect((await createOmpAdapter({ ompDir }).discover()).map((s) => s.nativeId)).toEqual([
      SESSION_ID,
    ]);
    expect(
      await createOmpAdapter({ ompDir, agentDir: join(ompDir, 'elsewhere') }).discover(),
    ).toEqual([]);
  });

  it('watches the dirs of sub-agents it has seen, listed or reported', async () => {
    await put(sessionPath(), session(SESSION_ID));
    const stem = sessionPath().slice(0, -'.jsonl'.length);
    await put(join(stem, 'Scout.jsonl'), session('s1'));
    const adapter = createOmpAdapter({ ompDir });
    const [source] = (await adapter.discover()) as [SessionSource];
    expect(adapter.watchDirs(source)).toEqual([group(), stem]);
    await adapter.listFiles(source);
    expect(adapter.watchDirs(source)).toContain(join(stem, 'Scout'));
    adapter.classify(source, join(stem, 'Scout', 'Helper.jsonl'));
    expect(adapter.watchDirs(source)).toContain(join(stem, 'Scout', 'Helper'));
  });

  it('gives its parser the session’s artifacts', async () => {
    const t = new Transcript();
    t.user('Read it', 1);
    t.answer({ sec: 2, tools: [{ id: 'c1', name: 'read' }] });
    t.toolResult('c1', 'read', 'head only', 3, {
      details: { meta: { truncation: { direction: 'head', artifactId: '0' } } },
    });
    await put(sessionPath(), session(SESSION_ID, t.lines));
    await put(join(sessionPath().slice(0, -'.jsonl'.length), '0.read.log'), 'head only\nand tail');
    const adapter = createOmpAdapter({ ompDir });
    const [source] = (await adapter.discover()) as [SessionSource];
    const parser = adapter.createParser(source);
    for (const file of await adapter.listFiles(source))
      parser.ingestLines(file, readFileSync(file.path, 'utf8').split('\n'));
    expect(parser.toolResult('c1')).toBe('head only\nand tail');
  });
});

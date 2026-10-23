/**
 * How often `classify` opens a file. It runs on the event loop, once per watcher report.
 */
import * as fs from 'node:fs';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, CWD, line } from './__fixtures__/builders.js';
import { createCodexAdapter } from './index.js';

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, openSync: vi.fn(real.openSync) };
});

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const GHOST = '33333333-3333-4333-8333-333333333333';

let codexDir: string;
beforeEach(async () => {
  codexDir = await realpath(await mkdtemp(join(tmpdir(), 'glassbox-codex-reads-')));
});
afterEach(async () => {
  await rm(codexDir, { recursive: true, force: true });
});

function meta(id: string, over: Record<string, unknown> = {}): string {
  return `${line('session_meta', 0, 0, { id, timestamp: at(0), cwd: CWD, ...over })}\n`;
}

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe('classify reads', () => {
  it('reads a waiting sub-agent’s header once, however often it is written', async () => {
    const dir = join(codexDir, 'sessions', '2026', '01', '01');
    await put(join(dir, `rollout-2026-01-01T00-00-00-${PARENT}.jsonl`), meta(PARENT));
    const adapter = createCodexAdapter({ codexDir });
    const [source] = await adapter.discover();
    if (!source) throw new Error('no session');
    // Its parent is not known yet: every write reports it again.
    const waiting = join(dir, `rollout-2026-01-01T00-00-01-${GHOST}.jsonl`);
    await put(waiting, meta(GHOST, { parent_thread_id: CHILD }));
    const opens = vi.mocked(fs.openSync);
    opens.mockClear();
    for (let i = 0; i < 5; i++) {
      expect(adapter.classify(source, waiting)).toBe('later');
      await appendFile(waiting, `${line('event_msg', i + 1, i + 1, { type: 'agent_message' })}\n`);
    }
    expect(opens.mock.calls.filter(([path]) => path === waiting)).toHaveLength(1);
  });
});

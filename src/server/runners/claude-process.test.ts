import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ClaudeProcess, type ExitInfo, spawnClaude } from './claude-process.js';

const FAKE = join(import.meta.dirname, '__tests__', 'fake-claude.mjs');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassbox-proc-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function start(scenario: object[], extraEnv: Record<string, string> = {}) {
  const logFile = join(dir, 'fake.log');
  const proc = spawnClaude({
    bin: process.execPath,
    cwd: dir,
    args: [FAKE, '--input-format', 'stream-json'],
    env: {
      ...process.env,
      FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario),
      FAKE_CLAUDE_LOG: logFile,
      ...extraEnv,
    },
  });
  const messages: unknown[] = [];
  proc.onMessage((m) => messages.push(m));
  const exited = new Promise<ExitInfo>((resolve) => proc.onExit(resolve));
  const fakeLog = async () =>
    (await readFile(logFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { proc, messages, exited, fakeLog };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('spawnClaude', () => {
  it('writes one JSON line per message and parses each stdout line', async () => {
    const { proc, messages, exited, fakeLog } = start([
      { wait: { type: 'user' } },
      { emit: { type: 'result', subtype: 'success', result: 'ok' } },
    ]);
    proc.send({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null });
    await until(() => messages.length === 1);
    expect(messages).toEqual([{ type: 'result', subtype: 'success', result: 'ok' }]);
    proc.end();
    expect((await exited).code).toBe(0);
    expect((await fakeLog()).find((e) => e.stdin)?.stdin).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      parent_tool_use_id: null,
    });
  });

  it('writes a message too deep for JSON.stringify as one line holding all of it', async () => {
    const depth = 20_000;
    const deep = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
    const { proc, exited } = start([{ wait: { type: 'control_response' } }]);
    proc.send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'perm-1',
        response: { updatedInput: JSON.parse(deep) },
      },
    });
    proc.end();
    expect((await exited).code).toBe(0);
    const written = (await readFile(join(dir, 'fake.log'), 'utf8'))
      .split('\n')
      .filter((l) => l.startsWith('{"stdin":'));
    expect(written).toEqual([
      `{"stdin":{"type":"control_response","response":{"subtype":"success","request_id":"perm-1","response":{"updatedInput":${deep}}}}}`,
    ]);
  });

  it('passes args, cwd and env to the binary', async () => {
    const { proc, exited, fakeLog } = start([], { FAKE_MARK: 'present' });
    proc.end();
    await exited;
    const log = await fakeLog();
    expect(log[0].argv).toEqual(['--input-format', 'stream-json']);
    expect(log[1].cwd).toContain('glassbox-proc-');
    expect(log[2].env.FAKE_MARK).toBe('present');
  });

  it('reassembles a line split across writes, multi-byte characters included', async () => {
    const { proc, messages, exited } = start([
      { raw: '{"type":"assistant","text":"héllo ' },
      { sleep: 30 },
      { raw: '世界"}\n{"type":"res' },
      { sleep: 30 },
      { raw: 'ult"}\n' },
    ]);
    await until(() => messages.length === 2);
    expect(messages).toEqual([{ type: 'assistant', text: 'héllo 世界' }, { type: 'result' }]);
    proc.end();
    await exited;
  });

  it('counts malformed lines and keeps going', async () => {
    const { proc, messages, exited } = start([
      { raw: 'not json at all\n' },
      { raw: '[1,2]\n\n' },
      { emit: { type: 'result' } },
    ]);
    await until(() => messages.length === 1);
    expect(proc.malformedLines).toBe(2);
    proc.end();
    await exited;
  });

  it('reports the exit code and the last stderr lines', async () => {
    const { exited } = start([{ stderr: 'warming up' }, { stderr: 'Error: boom' }, { exit: 3 }]);
    const info = await exited;
    expect(info).toMatchObject({ code: 3, error: null });
    expect(info.stderrTail.at(-1)).toBe('Error: boom');
  });

  it('kill() ends a process that never exits on its own', async () => {
    const { proc, exited } = start([{ hang: true }]);
    proc.kill();
    expect((await exited).signal).toBe('SIGTERM');
  });

  it('a binary that cannot be started reports an error instead of throwing', async () => {
    const proc: ClaudeProcess = spawnClaude({
      bin: join(dir, 'no-such-claude'),
      cwd: dir,
      args: [],
      env: process.env,
    });
    const info = await new Promise<ExitInfo>((resolve) => proc.onExit(resolve));
    expect(info.code).toBeNull();
    expect(info.error).toMatch(/ENOENT/);
    expect(() => proc.send({ type: 'user' })).not.toThrow();
    const late = await new Promise<ExitInfo>((resolve) => proc.onExit(resolve));
    expect(late).toEqual(info);
  });
});

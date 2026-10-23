import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childEnv, findClaudeBin } from './claude-bin.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'glassbox-bin-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function file(path: string, mode: number) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, mode);
  return path;
}

describe('findClaudeBin', () => {
  it('prefers --claude-bin', async () => {
    const bin = await file(join(root, 'custom', 'my-claude'), 0o755);
    const onPath = await file(join(root, 'p', 'claude'), 0o755);
    const env = { PATH: join(onPath, '..') };
    expect(await findClaudeBin({ flag: bin, env, platform: 'darwin' })).toBe(bin);
  });

  it('fails loudly when --claude-bin points at nothing', async () => {
    await expect(
      findClaudeBin({ flag: join(root, 'missing'), env: {}, platform: 'darwin' }),
    ).rejects.toThrow(/--claude-bin.*missing/);
  });

  it('takes the first executable claude on PATH', async () => {
    await mkdir(join(root, 'a'));
    await file(join(root, 'b', 'claude'), 0o644); // not executable
    await mkdir(join(root, 'c', 'claude'), { recursive: true }); // a directory
    const want = await file(join(root, 'd', 'claude'), 0o755);
    await file(join(root, 'e', 'claude'), 0o755);
    const PATH = ['a', 'b', 'c', 'd', 'e'].map((d) => join(root, d)).join(delimiter);
    expect(await findClaudeBin({ flag: null, env: { PATH }, platform: 'linux' })).toBe(want);
  });

  it('returns null when no claude is installed', async () => {
    await mkdir(join(root, 'a'));
    expect(
      await findClaudeBin({ flag: null, env: { PATH: join(root, 'a') }, platform: 'darwin' }),
    ).toBeNull();
    expect(await findClaudeBin({ flag: null, env: {}, platform: 'darwin' })).toBeNull();
  });

  it('honours PATHEXT on Windows', async () => {
    const want = await file(join(root, 'w', 'claude.cmd'), 0o644);
    const env = { Path: join(root, 'w'), PATHEXT: '.COM;.EXE;.CMD' };
    expect(await findClaudeBin({ flag: null, env, platform: 'win32' })).toBe(want);
  });
});

describe('childEnv', () => {
  it('drops ANTHROPIC_API_KEY so the subscription login is used, without touching the input', () => {
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-test', HOME: '/home/u' };
    expect(childEnv(env, false)).toEqual({ PATH: '/bin', HOME: '/home/u' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('keeps ANTHROPIC_API_KEY with --use-api-key', () => {
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-test' };
    expect(childEnv(env, true)).toEqual(env);
  });
});

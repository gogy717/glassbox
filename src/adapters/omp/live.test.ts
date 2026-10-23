import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { header, SESSION_ID, Transcript, titleSlot } from './__fixtures__/builders.js';
import { activityOf, heldLeases, leaseName, xxh64 } from './live.js';

describe('xxh64', () => {
  // Reference values of XXH64 (seed 0), short and long (≥ 32 bytes) inputs.
  it.each([
    ['', 'ef46db3751d8e999'],
    ['abc', '44bc2cf5ad770999'],
    ['Nobody inspects the spammish repetition', 'fbcea83c8a378bf1'],
  ])('%j → %s', (input, hash) => {
    expect(xxh64(Buffer.from(input), 0n).toString(16)).toBe(hash);
  });
});

describe('leaseName', () => {
  it('names the socket omp binds for a session it has open', () => {
    // The same derivation matched the sockets of a running omp 18.12.6 for its session and a
    // sub-agent's; this value guards the derivation.
    expect(leaseName('/home/user/.omp', SESSION_ID)).toBe(
      'omp-file-lock-fab4933d11169cb387f3674833645ef9',
    );
    expect(leaseName('/home/user/.omp/', SESSION_ID)).toBe(
      leaseName('/home/user/.omp', SESSION_ID),
    );
  });

  it('gives up on ids omp would hash first', () => {
    expect(leaseName('/home/user/.omp', 'has spaces')).toBeNull();
    expect(leaseName('/home/user/.omp', 'x'.repeat(129))).toBeNull();
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassbox-omp-live-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('heldLeases', () => {
  it('reads the abstract socket names from the kernel table', async () => {
    const table = join(dir, 'unix');
    await writeFile(
      table,
      [
        'Num       RefCount Protocol Flags    Type St Inode Path',
        '0000000000000000: 00000002 00000000 00000000 0002 01 212242 @omp-file-lock-fab4933d11169cb387f3674833645ef9',
        '0000000000000000: 00000003 00000000 00000000 0001 03 220180 /home/user/.omp/run/daemons/broker.sock',
        '0000000000000000: 00000002 00000000 00000000 0002 01 216426 @some-other-socket',
      ].join('\n'),
    );
    expect(await heldLeases(table, 'linux')).toEqual(
      new Set(['omp-file-lock-fab4933d11169cb387f3674833645ef9']),
    );
  });

  it('cannot see leases elsewhere, or without the table', async () => {
    expect(await heldLeases(join(dir, 'unix'), 'darwin')).toBeNull();
    expect(await heldLeases(join(dir, 'missing'), 'linux')).toBeNull();
  });
});

describe('activityOf', () => {
  const write = async (lines: string[]) => {
    const path = join(dir, 's.jsonl');
    await writeFile(path, `${[titleSlot(''), header(), ...lines].join('\n')}\n`);
    return path;
  };

  it('is idle at the prompt and after an answer that asked for nothing', async () => {
    expect(await activityOf(await write([]))).toBe('idle');
    const t = new Transcript();
    t.user('Go', 1);
    t.answer({ sec: 2, text: 'Done.' });
    t.injected('plan-mode-context', 'Plan mode is on', 3);
    expect(await activityOf(await write(t.lines))).toBe('idle');
  });

  it('is busy on a prompt, while tools run, and on a background result', async () => {
    const t = new Transcript();
    t.user('Go', 1);
    expect(await activityOf(await write(t.lines))).toBe('busy');
    t.answer({ sec: 2, tools: [{ id: 'c1', name: 'bash' }] });
    expect(await activityOf(await write(t.lines))).toBe('busy');
    t.toolResult('c1', 'bash', 'ok', 3);
    expect(await activityOf(await write(t.lines))).toBe('busy');
    t.answer({ sec: 4, text: 'ok' });
    t.injected('async-result', 'Scout finished', 5);
    expect(await activityOf(await write(t.lines))).toBe('busy');
  });

  it('reads only the tail of a long file, and nothing from a missing one', async () => {
    const t = new Transcript();
    t.user('Go', 1);
    t.toolResult('c0', 'read', 'x'.repeat(200_000), 2);
    t.answer({ sec: 3, text: 'Done.' });
    expect(await activityOf(await write(t.lines))).toBe('idle');
    expect(await activityOf(join(dir, 'missing.jsonl'))).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createRepoLookup, type RepoFs, repoOf } from './repo.js';

/** A filesystem of `.git` entries only: directories, and files with their one gitdir line. */
function fsOf(entries: Record<string, 'dir' | string>): RepoFs {
  return {
    kind: (p: string) => (p in entries ? (entries[p] === 'dir' ? 'dir' : 'file') : null),
    head: (p: string) => (p in entries && entries[p] !== 'dir' ? (entries[p] as string) : null),
  };
}

describe('repoOf', () => {
  const fs = fsOf({
    '/home/dev/src/glassbox/.git': 'dir',
    '/home/dev/work/glassbox/weever/.git': 'gitdir: /home/dev/src/glassbox/.git/worktrees/weever\n',
    '/home/dev/work/glassbox/rel/.git': 'gitdir: ../../../src/glassbox/.git/worktrees/rel\n',
    '/home/dev/src/app/.git': 'dir',
    '/home/dev/src/app/vendor/lib/.git': 'gitdir: ../../.git/modules/vendor/lib\n',
  });

  it('names the main working tree by its own directory', () => {
    expect(repoOf('/home/dev/src/glassbox', fs)).toEqual({
      root: '/home/dev/src/glassbox',
      dir: '/home/dev/src/glassbox',
      name: 'glassbox',
    });
  });

  it('follows a worktree’s gitdir line to the repository it belongs to, absolute or relative', () => {
    expect(repoOf('/home/dev/work/glassbox/weever', fs)).toEqual({
      root: '/home/dev/src/glassbox',
      dir: '/home/dev/work/glassbox/weever',
      name: 'glassbox',
    });
    expect(repoOf('/home/dev/work/glassbox/rel', fs)?.root).toBe('/home/dev/src/glassbox');
  });

  it('climbs from a subdirectory to the working tree that holds it', () => {
    expect(repoOf('/home/dev/work/glassbox/weever/web/src', fs)).toEqual({
      root: '/home/dev/src/glassbox',
      dir: '/home/dev/work/glassbox/weever',
      name: 'glassbox',
    });
  });

  it('takes a submodule for a repository of its own', () => {
    expect(repoOf('/home/dev/src/app/vendor/lib', fs)).toEqual({
      root: '/home/dev/src/app/vendor/lib',
      dir: '/home/dev/src/app/vendor/lib',
      name: 'lib',
    });
  });

  it('answers null outside any repository, and for a .git file it cannot read', () => {
    expect(repoOf('/home/dev/notes', fs)).toBeNull();
    expect(repoOf('/tmp/x', fsOf({ '/tmp/x/.git': 'not a pointer' }))).toBeNull();
  });
});

describe('createRepoLookup', () => {
  it('reads a directory once within the ttl, misses included, then again', () => {
    const kind = vi.fn((p: string) => (p === '/r/.git' ? ('dir' as const) : null));
    let t = 0;
    const lookup = createRepoLookup({ kind, head: () => null }, 1000, () => t);
    expect(lookup('/r')?.name).toBe('r');
    expect(lookup('/r')?.name).toBe('r');
    expect(lookup('/nowhere')).toBeNull();
    expect(lookup('/nowhere')).toBeNull();
    const calls = kind.mock.calls.length;
    t = 1000;
    lookup('/r');
    expect(kind.mock.calls.length).toBeGreaterThan(calls);
  });
});

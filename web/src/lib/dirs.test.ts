import { describe, expect, it } from 'vitest';
import { recentDirChoices, shortPath } from './dirs';

describe('shortPath', () => {
  it.each([
    ['/Users/demo/Dev/glassbox', 'Dev/glassbox'],
    ['/Users/demo/Dev/glassbox/', 'Dev/glassbox'],
    ['/repo', '/repo'],
    ['C:\\Users\\demo\\proj', 'demo/proj'],
  ])('%s → %s', (p, want) => {
    expect(shortPath(p)).toBe(want);
  });
});

describe('recentDirChoices', () => {
  it('puts temporary and scratch folders aside and keeps at most 8, in order', () => {
    const dirs = [
      '/Users/demo/Dev/a',
      '/private/tmp/claude-501/x',
      '/Users/demo/Dev/b',
      '/var/folders/lc/abc/T/y',
      '/Users/demo/Library/Application Support/Claude/scratch-workspaces/z',
      '/tmp/w',
      ...Array.from({ length: 9 }, (_, i) => `/Users/demo/Dev/p${i}`),
    ];
    const { shown, temporary } = recentDirChoices(dirs);
    expect(shown).toEqual([
      '/Users/demo/Dev/a',
      '/Users/demo/Dev/b',
      '/Users/demo/Dev/p0',
      '/Users/demo/Dev/p1',
      '/Users/demo/Dev/p2',
      '/Users/demo/Dev/p3',
      '/Users/demo/Dev/p4',
      '/Users/demo/Dev/p5',
    ]);
    expect(temporary).toEqual([
      '/private/tmp/claude-501/x',
      '/var/folders/lc/abc/T/y',
      '/Users/demo/Library/Application Support/Claude/scratch-workspaces/z',
      '/tmp/w',
    ]);
  });
});

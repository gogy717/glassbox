import { describe, expect, it } from 'vitest';
import { lineChangesOf } from './line-changes.js';

/** A tool result as Claude Code records it after an edit: one hunk of a structured patch. */
const edited = (...hunks: unknown[]) => ({
  filePath: '/w/app/src/a.ts',
  oldString: 'b',
  newString: 'c\nd',
  structuredPatch: hunks,
});

describe('lineChangesOf', () => {
  it('reads where an edit landed: each run of lines removed and put in, context left out', () => {
    const hunk = {
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4,
      lines: [' a', '-b', '+c', '+d', ' e'],
    };
    expect(lineChangesOf(edited(hunk))).toEqual([[11, 1, 2]]);
  });

  it('reads two runs in one hunk, a pure insertion and a pure removal, across hunks', () => {
    const first = {
      oldStart: 1,
      oldLines: 6,
      newStart: 1,
      newLines: 7,
      lines: ['+import x;', ' a', ' b', '-c', ' d', '+e', '+f', ' g', '-h'],
    };
    const second = { oldStart: 40, oldLines: 2, newStart: 41, newLines: 1, lines: [' p', '-q'] };
    expect(lineChangesOf(edited(first, second))).toEqual([
      [1, 0, 1],
      [3, 1, 0],
      [5, 0, 2],
      [6, 1, 0],
      [41, 1, 0],
    ]);
  });

  it('skips the no-newline marker and a hunk it cannot read', () => {
    const hunk = {
      oldStart: 3,
      oldLines: 1,
      newStart: 3,
      newLines: 1,
      lines: ['-x', '\\ No newline at end of file', '+y', '\\ No newline at end of file'],
    };
    expect(lineChangesOf(edited(hunk, { oldStart: 9, lines: 'nope' }, null, 'x'))).toEqual([
      [3, 1, 1],
    ]);
  });

  it('knows nothing of a file it created, an error, or a result without a patch', () => {
    expect(lineChangesOf({ type: 'create', filePath: '/a', structuredPatch: [] })).toBeNull();
    expect(lineChangesOf('Error: String to replace not found in file.')).toBeNull();
    expect(lineChangesOf({ stdout: 'x' })).toBeNull();
    expect(lineChangesOf({ structuredPatch: 'x' })).toBeNull();
    expect(lineChangesOf(undefined)).toBeNull();
  });

  it('says a Write over a file that changed nothing changed no line', () => {
    expect(lineChangesOf({ type: 'update', filePath: '/a', structuredPatch: [] })).toEqual([]);
  });
});

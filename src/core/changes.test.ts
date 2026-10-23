import { describe, expect, it } from 'vitest';
import { emptyChanges, isEmptyChanges, mergeChanges } from './changes.js';

describe('change sets', () => {
  it('detects empty change sets', () => {
    expect(isEmptyChanges(emptyChanges())).toBe(true);
    expect(isEmptyChanges({ ...emptyChanges(), requests: ['r1'] })).toBe(false);
    expect(isEmptyChanges({ ...emptyChanges(), session: true })).toBe(false);
    expect(isEmptyChanges({ ...emptyChanges(), removed: { requests: ['r1'] } })).toBe(false);
    expect(isEmptyChanges({ ...emptyChanges(), removed: { requests: [] } })).toBe(true);
  });

  it('merges with de-duplication in first-seen order', () => {
    const merged = mergeChanges(
      { ...emptyChanges(), requests: ['b', 'a'] },
      { ...emptyChanges(), requests: ['a', 'c'], session: true },
    );
    expect(merged.requests).toEqual(['b', 'a', 'c']);
    expect(merged.session).toBe(true);
    expect(merged.diagnostics).toBe(false);
    expect(merged.removed).toBeUndefined();
  });

  it('lets a later removal win over an earlier change', () => {
    const merged = mergeChanges(
      { ...emptyChanges(), requests: ['ghost', 'real'], turns: ['t1'] },
      { ...emptyChanges(), requests: ['real'], removed: { requests: ['ghost'] } },
    );
    expect(merged.requests).toEqual(['real']);
    expect(merged.removed).toEqual({ requests: ['ghost'] });
    expect(merged.turns).toEqual(['t1']);
  });

  it('lets a later change win over an earlier removal', () => {
    const merged = mergeChanges(
      { ...emptyChanges(), removed: { requests: ['r1'], toolCalls: ['x'] } },
      { ...emptyChanges(), requests: ['r1'] },
    );
    expect(merged.requests).toEqual(['r1']);
    expect(merged.removed).toEqual({ toolCalls: ['x'] });
  });
});

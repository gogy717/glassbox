import type { ChangeSet } from './adapter.js';
import type { EntityKind } from './model.js';

const KINDS: readonly EntityKind[] = ['agents', 'turns', 'requests', 'toolCalls', 'workflows'];

export function emptyChanges(): ChangeSet {
  return {
    session: false,
    agents: [],
    turns: [],
    requests: [],
    toolCalls: [],
    workflows: [],
    diagnostics: false,
  };
}

export function isEmptyChanges(c: ChangeSet): boolean {
  return (
    !c.session &&
    !c.diagnostics &&
    KINDS.every((k) => c[k].length === 0 && (c.removed?.[k]?.length ?? 0) === 0)
  );
}

/**
 * Union of change sets, applied in order: ids are de-duplicated in first-seen order, and when
 * one id is both changed and removed across the sets, the later operation wins — a request that
 * was shown in flight and then dropped ends up removed, one that was dropped and then came back
 * ends up changed.
 */
export function mergeChanges(...sets: ChangeSet[]): ChangeSet {
  const out = emptyChanges();
  const changed = new Map(KINDS.map((k) => [k, new Set<string>()]));
  const removed = new Map(KINDS.map((k) => [k, new Set<string>()]));
  for (const s of sets) {
    out.session ||= s.session;
    out.diagnostics ||= s.diagnostics;
    for (const k of KINDS) {
      const c = changed.get(k) as Set<string>;
      const r = removed.get(k) as Set<string>;
      for (const id of s[k]) {
        r.delete(id);
        c.add(id);
      }
      for (const id of s.removed?.[k] ?? []) {
        c.delete(id);
        r.add(id);
      }
    }
  }
  for (const k of KINDS) {
    out[k] = [...(changed.get(k) as Set<string>)];
    const r = removed.get(k) as Set<string>;
    if (r.size > 0) {
      out.removed ??= {};
      out.removed[k] = [...r];
    }
  }
  return out;
}

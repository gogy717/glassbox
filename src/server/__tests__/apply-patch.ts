import type { EntityKind, SessionPatch, SessionSnapshot } from '../../core/model.js';

const KINDS: readonly EntityKind[] = ['agents', 'turns', 'requests', 'toolCalls', 'workflows'];

/** What a client holds after applying a patch: upserts by id first, then removals. */
export function applyPatch(s: SessionSnapshot, p: SessionPatch): SessionSnapshot {
  const out: SessionSnapshot = {
    ...s,
    session: p.session,
    diagnostics: p.diagnostics ?? s.diagnostics,
  };
  for (const k of KINDS) {
    const list: { id: string }[] = [...s[k]];
    for (const item of p[k]) {
      const i = list.findIndex((x) => x.id === item.id);
      if (i === -1) list.push(item);
      else list[i] = item;
    }
    const gone = new Set(p.removed?.[k] ?? []);
    (out[k] as { id: string }[]) = list.filter((x) => !gone.has(x.id));
  }
  return out;
}

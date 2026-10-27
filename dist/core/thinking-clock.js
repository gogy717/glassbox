/**
 * Where a call in flight's "Thinking · m:ss" clock starts: at its last step, the end of the
 * latest of its own tools, else the call's start. A call that spans its tools (Codex, Grok,
 * OpenCode) would otherwise jump back to its start once a tool ends. `tools` may hold others.
 */
export function thinkingSince(call, tools) {
    const own = new Set(call.toolCallIds);
    let since = call.startedAt;
    for (const t of tools)
        if (own.has(t.id))
            since = latest(since, t.endedAt);
    return since;
}
/** Epoch ms of `t`; -Infinity when unknown or unreadable, so it sorts first. */
export const ms = (t) => {
    const v = t === null ? Number.NaN : Date.parse(t);
    return Number.isNaN(v) ? Number.NEGATIVE_INFINITY : v;
};
/** The later of two times, by instant: "…:05Z" and "…:04.900Z" do not compare as text. */
export function latest(a, b) {
    return b !== null && ms(b) > ms(a) ? b : a;
}
//# sourceMappingURL=thinking-clock.js.map
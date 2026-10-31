import { toolSpan } from './segments.js';
import { toolCategory } from './tool-category.js';
const ms = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
};
const PLAN_TOOL = /^exit_?plan_?mode$/i;
/** What kind of wait holding this tool open is, if it holds the person to answer. */
export function waitKindOf(name, input) {
    if (toolCategory(name, input) === 'ask')
        return 'question';
    if (PLAN_TOOL.test(name))
        return 'plan';
    return null;
}
/**
 * The waits of some tool calls, `now` standing for a running one's end. A tool that waits on a
 * question or a plan approval contributes its whole span; any other contributes the part of its
 * span an approval window covers (none when the window was still open after the tool ended).
 */
export function waitsOf(tools, now, approvals) {
    const out = [];
    for (const t of tools) {
        const span = toolSpan(t, now);
        if (!span)
            continue;
        const [start, end] = span;
        const base = { agentId: t.agentId, of: t.id };
        const held = waitKindOf(t.name, t.input);
        if (held) {
            if (end > start)
                out.push({ kind: held, ...base, start, end });
            continue;
        }
        const window = approvals?.get(t.id);
        if (!window)
            continue;
        const waitEnd = window.decidedAt ?? (t.status === 'running' ? end : null);
        if (waitEnd === null)
            continue;
        const from = Math.max(start, window.requestedAt);
        const to = Math.min(end, waitEnd);
        if (to > from)
            out.push({ kind: 'permission', ...base, start: from, end: to });
    }
    return out;
}
/**
 * The gaps from the end of a turn to the start of the next one the person sent (`human`), agent
 * by agent, cut to the live spans (`now` ends an open one). Without live spans, none: nothing
 * says the session was there through the gap. The gap after the last reply is not one yet.
 */
export function turnWaitsOf(turns, now, live) {
    const out = [];
    if (!live || live.length === 0)
        return out;
    const byAgent = new Map();
    for (const t of turns) {
        const list = byAgent.get(t.agentId);
        if (list)
            list.push(t);
        else
            byAgent.set(t.agentId, [t]);
    }
    for (const list of byAgent.values()) {
        list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        for (let i = 1; i < list.length; i++) {
            const next = list[i];
            if (next.origin !== 'human')
                continue;
            const from = ms(list[i - 1]?.endedAt ?? '');
            const to = ms(next.startedAt);
            if (from === null || to === null || to <= from)
                continue;
            for (const [start, end] of live) {
                const a = Math.max(from, start);
                const b = Math.min(to, end ?? now);
                if (b > a)
                    out.push({ kind: 'turn', agentId: next.agentId, of: next.id, start: a, end: b });
            }
        }
    }
    return out;
}
/** The sum of the waits' lengths, as the figures add them up. */
export const waitMs = (waits) => {
    let total = 0;
    for (const w of waits)
        total += w.end - w.start;
    return total;
};
/**
 * The approval windows of a session's glassbox runs, closed runs included: the answered prompts
 * of each run (at most the history a run keeps) and its open ones. Runs that predate the answered
 * history only contribute their open prompts.
 */
export function approvalsOf(runs, sessionId) {
    const out = new Map();
    if (!sessionId)
        return out;
    for (const run of runs) {
        if (run.sessionId !== sessionId)
            continue;
        for (const d of run.decidedPermissions ?? []) {
            const requestedAt = ms(d.requestedAt);
            const decidedAt = ms(d.decidedAt);
            if (requestedAt !== null && decidedAt !== null)
                out.set(d.id, { requestedAt, decidedAt });
        }
        for (const p of run.pendingPermissions) {
            const requestedAt = ms(p.requestedAt);
            if (requestedAt !== null)
                out.set(p.id, { requestedAt, decidedAt: null });
        }
    }
    return out;
}
/**
 * The stretches the session's glassbox runs were live: from the start of each run to now while
 * it lives, else to its last change (closing it, or failing).
 */
export function liveSpansOf(runs, sessionId) {
    const out = [];
    if (!sessionId)
        return out;
    for (const run of runs) {
        if (run.sessionId !== sessionId)
            continue;
        const start = ms(run.startedAt);
        if (start === null)
            continue;
        const over = run.status === 'closed' || run.status === 'error';
        const end = over ? ms(run.updatedAt) : null;
        if (over && end === null)
            continue;
        out.push([start, end]);
    }
    return out;
}
/** What the session's glassbox runs know of its waits (`WaitSource`). */
export function waitSourceOf(runs, sessionId) {
    return { approvals: approvalsOf(runs, sessionId), live: liveSpansOf(runs, sessionId) };
}
//# sourceMappingURL=waiting.js.map
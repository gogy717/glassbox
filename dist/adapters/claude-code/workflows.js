import { msToIso } from './records.js';
export function newRun(id) {
    return {
        id,
        name: null,
        taskId: null,
        toolCallId: null,
        agentIds: [],
        journal: new Map(),
        attempts: new Map(),
        journalPhases: [],
        final: null,
        notified: null,
    };
}
const str = (v) => (typeof v === 'string' ? v : null);
/** One `journal.jsonl` line, or null when it is not valid JSON. */
export function parseJournalLine(line) {
    let v;
    try {
        v = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (typeof v !== 'object' || v === null)
        return null;
    const r = v;
    const agentId = str(r.agentId);
    if (r.type === 'launched')
        return { type: 'launched' };
    if (r.type === 'started' && agentId)
        return { type: 'started', agentId, key: str(r.key), label: str(r.label), phase: str(r.phase) };
    if ((r.type === 'result' || r.type === 'failed') && agentId)
        return { type: r.type, agentId };
    return { type: 'other' };
}
/** Applies a journal event; returns the agent it concerns, if any. */
export function applyJournal(run, e) {
    if (e.type === 'launched' || e.type === 'other')
        return null;
    addAgent(run, e.agentId);
    const entry = run.journal.get(e.agentId) ?? {
        key: null,
        label: null,
        phase: null,
        outcome: null,
    };
    run.journal.set(e.agentId, entry);
    if (e.type === 'started') {
        entry.key = e.key;
        entry.label = e.label;
        entry.phase = e.phase;
        if (e.phase && !run.journalPhases.includes(e.phase))
            run.journalPhases.push(e.phase);
        if (e.key) {
            const list = run.attempts.get(e.key) ?? [];
            if (!list.includes(e.agentId))
                list.push(e.agentId);
            run.attempts.set(e.key, list);
        }
    }
    else
        entry.outcome = e.type;
    return e.agentId;
}
export function addAgent(run, agentId) {
    if (!run.agentIds.includes(agentId))
        run.agentIds.push(agentId);
}
/** True when a later attempt with the same journal key replaced this agent. */
export function isRetried(run, agentId) {
    const key = run.journal.get(agentId)?.key;
    const list = key ? run.attempts.get(key) : undefined;
    return list !== undefined && list.at(-1) !== agentId;
}
/** Final `status` of the state file → run status. */
export function finalStatus(status, error) {
    switch (status) {
        case 'completed':
            return typeof error === 'string' && error ? 'error' : 'complete';
        case 'killed':
        case 'stopped':
        case 'cancelled':
            return 'interrupted';
        case 'failed':
        case 'error':
            return 'error';
        default:
            return typeof error === 'string' && error ? 'error' : 'complete';
    }
}
/** Reads `workflows/<runId>.json`. Its `totalTokens` is a context-size sum: never used. */
export function applyState(run, value) {
    const v = (typeof value === 'object' && value !== null ? value : {});
    if (typeof v.workflowName === 'string')
        run.name = v.workflowName;
    if (typeof v.taskId === 'string')
        run.taskId = v.taskId;
    const start = typeof v.startTime === 'number' ? v.startTime : null;
    const duration = typeof v.durationMs === 'number' ? v.durationMs : null;
    const phases = Array.isArray(v.phases)
        ? v.phases.flatMap((p) => {
            const ph = (p ?? {});
            return typeof ph.title === 'string'
                ? [
                    {
                        title: ph.title,
                        detail: typeof ph.detail === 'string' && ph.detail ? ph.detail : null,
                    },
                ]
                : [];
        })
        : null;
    run.final = {
        status: finalStatus(v.status, v.error),
        phases,
        startedAt: start !== null ? msToIso(start) : null,
        endedAt: start !== null && duration !== null ? msToIso(start + duration) : null,
    };
}
//# sourceMappingURL=workflows.js.map
export function newAgent(id, kind, label) {
    return {
        id,
        kind,
        parentId: null,
        spawnedByToolCallId: null,
        agentType: null,
        label,
        workflowRunId: null,
        phase: null,
        turnIds: [],
        requestIds: [],
        toolCallIds: [],
        metaLabel: null,
        finished: false,
        end: null,
        lastTs: null,
        prevTs: null,
        compactPending: false,
    };
}
export function newRequest(id, agentId, turnId, index) {
    return {
        id,
        agentId,
        turnId,
        index,
        apiTs: null,
        triggerTs: null,
        hasApi: false,
        apiModel: null,
        apiEffort: null,
        model: null,
        effort: null,
        stopReason: null,
        usage: null,
        bestOutput: -1,
        blocks: new Map(),
        arrivals: 0,
        toolCallIds: [],
        interruptedAt: null,
        error: null,
        compactedBefore: false,
    };
}
/** Blocks in response order. */
export function orderedBlocks(r) {
    return [...r.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
}
const shift = (iso, ms) => {
    const t = Date.parse(iso) - ms;
    return Number.isFinite(t) && !Number.isNaN(new Date(t).getTime())
        ? new Date(t).toISOString()
        : iso;
};
/**
 * The api-request time when there is one. Otherwise the earlier of the record that triggered
 * the request and, for thinking, the first block's completion minus its thinking time.
 */
export function requestStart(r) {
    if (r.apiTs)
        return r.apiTs;
    const first = orderedBlocks(r)[0];
    const candidates = [
        r.triggerTs,
        first ? (first.thinkingMs ? shift(first.block.at, first.thinkingMs) : first.block.at) : null,
    ].filter((t) => t !== null && !Number.isNaN(Date.parse(t)));
    if (candidates.length === 0)
        return first?.block.at ?? null;
    return candidates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}
//# sourceMappingURL=agent-state.js.map
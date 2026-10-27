import { MAIN_AGENT_ID } from './model.js';
import { sumUsage } from './usage.js';
export function checkSnapshot(s) {
    const problems = [];
    const ids = (kind, items) => {
        const set = new Set();
        for (const item of items) {
            if (set.has(item.id))
                problems.push(`duplicate ${kind} id ${item.id}`);
            set.add(item.id);
        }
        return set;
    };
    const agents = ids('agent', s.agents);
    const turns = ids('turn', s.turns);
    const requests = ids('request', s.requests);
    const tools = ids('toolCall', s.toolCalls);
    const workflows = ids('workflow', s.workflows);
    if (!agents.has(MAIN_AGENT_ID))
        problems.push('missing main agent');
    for (const a of s.agents) {
        if (a.id === MAIN_AGENT_ID ? a.parentId !== null : !agents.has(a.parentId ?? ''))
            problems.push(`agent ${a.id} has bad parent ${a.parentId}`);
        if (a.spawnedByToolCallId && !tools.has(a.spawnedByToolCallId))
            problems.push(`agent ${a.id} spawned by unknown tool call ${a.spawnedByToolCallId}`);
        if (a.workflowRunId && !workflows.has(a.workflowRunId))
            problems.push(`agent ${a.id} in unknown workflow ${a.workflowRunId}`);
    }
    for (const t of s.turns) {
        if (!agents.has(t.agentId))
            problems.push(`turn ${t.id} has unknown agent ${t.agentId}`);
        for (const r of t.requestIds)
            if (!requests.has(r))
                problems.push(`turn ${t.id} lists unknown request ${r}`);
    }
    for (const r of s.requests) {
        if (!agents.has(r.agentId))
            problems.push(`request ${r.id} has unknown agent ${r.agentId}`);
        if (r.turnId !== null && !turns.has(r.turnId))
            problems.push(`request ${r.id} has unknown turn ${r.turnId}`);
        for (const t of r.toolCallIds)
            if (!tools.has(t))
                problems.push(`request ${r.id} lists unknown tool call ${t}`);
        if (r.status === 'in-flight' && r.usage !== null)
            problems.push(`in-flight request ${r.id} has usage`);
    }
    for (const t of s.toolCalls) {
        if (!requests.has(t.requestId))
            problems.push(`tool call ${t.id} has unknown request`);
        if (t.spawned?.kind === 'agent' && !agents.has(t.spawned.agentId))
            problems.push(`tool call ${t.id} spawned unknown agent ${t.spawned.agentId}`);
        if (t.spawned?.kind === 'workflow' && !workflows.has(t.spawned.runId))
            problems.push(`tool call ${t.id} spawned unknown workflow ${t.spawned.runId}`);
    }
    for (const w of s.workflows) {
        if (!agents.has(w.parentAgentId))
            problems.push(`workflow ${w.id} has unknown parent agent`);
        for (const a of w.agentIds)
            if (!agents.has(a))
                problems.push(`workflow ${w.id} lists unknown agent ${a}`);
    }
    // Usage must add up: session = Σ agents = Σ requests (each request counted once).
    const fromRequests = sumUsage(s.requests.map((r) => r.usage));
    const fromAgents = sumUsage(s.agents.map((a) => a.usage));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(fromRequests, fromAgents))
        problems.push('agent usage does not sum to request usage');
    if (s.session.usage && !same(s.session.usage, fromRequests))
        problems.push('session usage does not sum to request usage');
    return problems;
}
//# sourceMappingURL=invariants.js.map
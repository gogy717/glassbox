import type { AgentNode, WorkflowRun } from '../../../src/core/model.js';
import { MAIN_AGENT_ID } from '../../../src/core/model.js';
import { contextSize } from '../../../src/core/usage.js';
import type { OpenSession } from '../data/store';

export type PathItem =
  | { kind: 'agent'; agent: AgentNode }
  | { kind: 'workflow'; workflow: WorkflowRun };

export type TreeRow =
  | { kind: 'agent'; depth: number; agent: AgentNode }
  | { kind: 'workflow'; depth: number; workflow: WorkflowRun }
  | { kind: 'phase'; depth: number; title: string; workflowId: string };

const startOf = (iso: string | null) => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY);

function childrenOf(open: OpenSession, parentId: string): AgentNode[] {
  const out: AgentNode[] = [];
  for (const a of open.agents.values())
    if (a.parentId === parentId && a.id !== parentId) out.push(a);
  return out.sort((a, b) => startOf(a.startedAt) - startOf(b.startedAt));
}

/** The agent and all its descendants. Guards against parent cycles in malformed data. */
export function subtreeIds(open: OpenSession, agentId: string): Set<string> {
  const ids = new Set<string>([agentId]);
  const queue = [agentId];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const child of childrenOf(open, id)) {
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      queue.push(child.id);
    }
  }
  return ids;
}

/** Breadcrumb from main to `agentId`, with the workflow run between a workflow agent and its parent. */
export function agentPath(open: OpenSession, agentId: string): PathItem[] {
  const path: PathItem[] = [];
  const seen = new Set<string>();
  let agent = open.agents.get(agentId);
  while (agent && !seen.has(agent.id)) {
    seen.add(agent.id);
    path.unshift({ kind: 'agent', agent });
    const wf = agent.workflowRunId ? open.workflows.get(agent.workflowRunId) : undefined;
    if (wf) path.unshift({ kind: 'workflow', workflow: wf });
    agent = agent.parentId ? open.agents.get(agent.parentId) : undefined;
  }
  const main = open.agents.get(MAIN_AGENT_ID);
  if (path[0]?.kind !== 'agent' || path[0].agent.id !== MAIN_AGENT_ID) {
    return main ? [{ kind: 'agent', agent: main }] : [];
  }
  return path;
}

/** The agent hierarchy flattened for a dropdown; workflow agents sit under run → phase. */
export function agentTree(open: OpenSession): TreeRow[] {
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const visit = (agent: AgentNode, depth: number) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    rows.push({ kind: 'agent', depth, agent });
    const kids = childrenOf(open, agent.id);
    type Item = { at: number; agent?: AgentNode; workflow?: WorkflowRun };
    const items: Item[] = [];
    const runs = new Map<string, AgentNode[]>();
    for (const k of kids) {
      const wf = k.workflowRunId ? open.workflows.get(k.workflowRunId) : undefined;
      if (!wf) {
        items.push({ at: startOf(k.startedAt), agent: k });
        continue;
      }
      const list = runs.get(wf.id);
      if (list) list.push(k);
      else {
        runs.set(wf.id, [k]);
        items.push({ at: startOf(wf.startedAt ?? k.startedAt), workflow: wf });
      }
    }
    items.sort((a, b) => a.at - b.at);
    for (const item of items) {
      if (item.agent) {
        visit(item.agent, depth + 1);
        continue;
      }
      const wf = item.workflow as WorkflowRun;
      rows.push({ kind: 'workflow', depth: depth + 1, workflow: wf });
      const members = runs.get(wf.id) ?? [];
      const titles = [...wf.phases.map((p) => p.title)];
      for (const m of members) if (m.phase && !titles.includes(m.phase)) titles.push(m.phase);
      for (const m of members) if (!m.phase) visit(m, depth + 2);
      for (const title of titles) {
        const inPhase = members.filter((m) => m.phase === title);
        if (inPhase.length === 0) continue;
        rows.push({ kind: 'phase', depth: depth + 2, title, workflowId: wf.id });
        for (const m of inPhase) visit(m, depth + 3);
      }
    }
  };
  const main = open.agents.get(MAIN_AGENT_ID);
  if (main) visit(main, 0);
  return rows;
}

export interface Summary {
  /** The agent's own turns (sub-agent turns are not the user's turns). */
  turns: number;
  requests: number;
  toolCalls: number;
  /** Sum of the agent's own turn durations; idle time between turns is excluded. */
  activeMs: number;
  /** Context tokens read: uncached + cache read + cache write. */
  input: number;
  cacheHitRate: number | null;
  output: number;
  thinking: number;
}

/** Summary-bar numbers for an agent and its descendants. */
export function summarize(open: OpenSession, agentId: string, now: number): Summary {
  const ids = subtreeIds(open, agentId);
  const s: Summary = {
    turns: 0,
    requests: 0,
    toolCalls: 0,
    activeMs: 0,
    input: 0,
    cacheHitRate: null,
    output: 0,
    thinking: 0,
  };
  let cacheRead = 0;
  for (const t of open.turns.values()) {
    if (t.agentId !== agentId) continue;
    s.turns++;
    const end = t.endedAt ? Date.parse(t.endedAt) : t.status === 'running' ? now : null;
    if (end !== null) s.activeMs += Math.max(0, end - Date.parse(t.startedAt));
  }
  for (const r of open.requests.values()) {
    if (!ids.has(r.agentId)) continue;
    s.requests++;
    if (!r.usage) continue;
    s.input += contextSize(r.usage);
    cacheRead += r.usage.cacheRead;
    s.output += r.usage.output;
    s.thinking += r.usage.thinking;
  }
  for (const t of open.toolCalls.values()) if (ids.has(t.agentId)) s.toolCalls++;
  s.cacheHitRate = s.input > 0 ? cacheRead / s.input : null;
  return s;
}

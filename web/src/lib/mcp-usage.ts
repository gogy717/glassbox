/**
 * What a session's MCP servers cost at run time: per server, its calls, failures, calls still
 * running, time and result size, and the tools used under it, each with its calls. A tool is an
 * MCP server's when its name says so (`mcp__server__tool`, or `server__tool` as Grok and older
 * Codex name them: `mcpTool`). Pure.
 *
 * Time is a finished call's own (its duration, else its ends); a running call adds none yet. A
 * result's size is its characters as the agent recorded them (`resultChars`), else its preview's,
 * which is all of it when it is short; tokens are estimated from characters at the context bill's
 * rate, as the result comes back into the context.
 */
import type { ToolCall } from '../../../src/core/model.js';
import { CHARS_PER_TOKEN } from '../../../src/shared/context-bill.js';
import { mcpTool } from '../../../src/shared/tool-category.js';

/** One tool of a server, and its calls in the order they started. */
export interface McpToolUse {
  name: string;
  calls: ToolCall[];
  failures: number;
  running: number;
  /** Finished calls' time added up. */
  ms: number;
  resultChars: number;
}

/** One server's figures: its tools' added up. */
export interface McpServerUse {
  server: string;
  calls: number;
  failures: number;
  running: number;
  ms: number;
  /** The median time of its finished calls; null while none has finished. */
  medianMs: number | null;
  resultChars: number;
  /** `resultChars` as tokens, estimated. */
  tokens: number;
  /** Most calls first. */
  tools: McpToolUse[];
}

/** A finished call's time: its recorded duration, else from its start to its end. */
function callMs(t: ToolCall): number | null {
  if (t.status === 'running') return null;
  if (t.durationMs !== null) return t.durationMs;
  const a = t.startedAt ? Date.parse(t.startedAt) : Number.NaN;
  const b = t.endedAt ? Date.parse(t.endedAt) : Number.NaN;
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, b - a);
}

const resultChars = (t: ToolCall) => t.resultChars ?? t.resultPreview?.length ?? 0;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const byStart = (a: ToolCall, b: ToolCall) =>
  (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.id.localeCompare(b.id);

/**
 * The MCP servers `calls` used, most calls first: every agent's, or only those of `agents` when
 * given. Empty when none was called.
 */
export function mcpUsage(calls: Iterable<ToolCall>, agents?: ReadonlySet<string>): McpServerUse[] {
  const servers = new Map<string, { tools: Map<string, McpToolUse>; times: number[] }>();
  for (const t of calls) {
    if (agents && !agents.has(t.agentId)) continue;
    const mcp = mcpTool(t.name);
    if (!mcp) continue;
    let s = servers.get(mcp.server);
    if (!s) {
      s = { tools: new Map(), times: [] };
      servers.set(mcp.server, s);
    }
    let tool = s.tools.get(mcp.tool);
    if (!tool) {
      tool = { name: mcp.tool, calls: [], failures: 0, running: 0, ms: 0, resultChars: 0 };
      s.tools.set(mcp.tool, tool);
    }
    tool.calls.push(t);
    if (t.status === 'error') tool.failures += 1;
    if (t.status === 'running') tool.running += 1;
    const ms = callMs(t);
    if (ms !== null) {
      tool.ms += ms;
      s.times.push(ms);
    }
    tool.resultChars += resultChars(t);
  }
  return [...servers]
    .map(([server, s]): McpServerUse => {
      const tools = [...s.tools.values()]
        .map((t) => ({ ...t, calls: t.calls.sort(byStart) }))
        .sort((a, b) => b.calls.length - a.calls.length || a.name.localeCompare(b.name));
      const sum = (k: 'failures' | 'running' | 'ms' | 'resultChars') =>
        tools.reduce((n, t) => n + t[k], 0);
      const chars = sum('resultChars');
      return {
        server,
        calls: tools.reduce((n, t) => n + t.calls.length, 0),
        failures: sum('failures'),
        running: sum('running'),
        ms: sum('ms'),
        medianMs: median(s.times),
        resultChars: chars,
        tokens: Math.round(chars / CHARS_PER_TOKEN),
        tools,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));
}

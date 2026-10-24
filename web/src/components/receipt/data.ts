/**
 * What a session's receipt says, taken from the functions behind the app's own figures: the
 * Summary bar's `summarize`, the Timeline's `timeBreakdown` and segments, the Tokens tab's
 * `rollupByAgent`. Nothing here counts anything new, so the receipt always agrees with the app.
 */
import { type AgentKind, MAIN_AGENT_ID } from '../../../../src/core/model.js';
import { redact } from '../../../../src/core/redact.js';
import { totalTokens } from '../../../../src/core/usage.js';
import type { Approvals } from '../../data/approvals';
import type { OpenSession } from '../../data/store';
import { mayStillRun, summarize } from '../../lib/agents';
import { type Segment, timeBreakdown, timeSegments } from '../../lib/time-stats';
import { rollupByAgent } from '../../lib/token-stats';
import { type ToolCategory, toolCategory } from '../../lib/tool-category';

export interface ReceiptData {
  agent: AgentKind;
  model: string | null;
  /** The first model call's reasoning effort ("max"), when the agent records one. */
  effort: string | null;
  nativeId: string;
  /** Epoch ms; null when the session never said when it started. */
  start: number | null;
  /** Its last write, or now while it still runs. */
  end: number;
  running: boolean;
  /**
   * The working directory's last segment; else the agent's project name if it reads as one, not
   * as an encoded path (`-home-<user>-dev-app`, which would print a user name). Null otherwise.
   */
  project: string | null;
  /**
   * Masked (`redact`), as a first prompt can hold a pasted key, with any absolute path in it cut
   * to its last segment. Null when untitled.
   */
  title: string | null;
  /** The Summary bar's duration; null before any model call, as the bar shows a dash. */
  durationMs: number | null;
  work: {
    requests: number;
    toolCalls: number;
    /** The three biggest tool categories, then the rest as 'other'. */
    categories: { category: ToolCategory; count: number }[];
    subAgents: number;
    turns: number;
    failures: number;
    compactions: number;
  };
  time: {
    thinking: number;
    generating: number;
    tools: number;
    approval: number;
    queued: number;
    longestThink: number;
  };
  tokens: {
    /** False until a call reported usage: the figures are then unknown, not zero. */
    measured: boolean;
    cacheRead: number;
    cacheWrite: number;
    uncached: number;
    output: number;
    thinking: number;
    cacheHit: number | null;
    total: number;
  };
  /** The main agent's timeline, and each sub-agent's span: the barcode. */
  segments: Segment[];
  subAgents: [number, number][];
  failedTools: ReadonlySet<string>;
}

/** Control characters (a terminal's colour codes) break an SVG and mean nothing on paper. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are what it removes
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: string) => s.replace(CONTROL, '');

/** An absolute path of two segments or more (/a/b, ~/a/b, C:\a\b): kept as its last segment. */
const ABSOLUTE = /(^|[\s"'(=])(?:~|[A-Za-z]:)?[\\/](?:[^\s\\/"'()]+[\\/])+([^\s\\/"'()]+)/g;

/** The title as printed: masked, control characters out, absolute paths cut to their ends. */
export const printedTitle = (title: string) =>
  clean(redact(title)).replace(ABSOLUTE, (_m, before: string, last: string) => before + last);

/** The project as printed: see `ReceiptData.project`. */
export function printedProject(cwd: string | null, project: string): string | null {
  if (cwd)
    return (
      clean(
        cwd
          .split(/[\\/]+/)
          .filter(Boolean)
          .at(-1) ?? '',
      ) || null
    );
  return project && !/[\\/]/.test(project) && !project.startsWith('-') ? clean(project) : null;
}

const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

export function receiptData(open: OpenSession, now: number, approvals?: Approvals): ReceiptData {
  const s = summarize(open, MAIN_AGENT_ID, now);
  const running = mayStillRun(open, MAIN_AGENT_ID);
  const breakdown = timeBreakdown(open, MAIN_AGENT_ID, now, approvals);
  const segments =
    timeSegments(open, now, approvals).find((l) => l.agentId === MAIN_AGENT_ID)?.segments ?? [];

  const byCategory = new Map<ToolCategory, number>();
  const failedTools = new Set<string>();
  for (const t of open.toolCalls.values()) {
    const c = toolCategory(t.name, t.input);
    byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
    if (t.status === 'error') failedTools.add(t.id);
  }
  const ranked = [...byCategory].filter(([c]) => c !== 'other').sort((a, b) => b[1] - a[1]);
  const other = (byCategory.get('other') ?? 0) + ranked.slice(3).reduce((n, [, k]) => n + k, 0);
  const categories = ranked.slice(0, 3).map(([category, count]) => ({ category, count }));
  if (other > 0) categories.push({ category: 'other', count: other });

  let failures = failedTools.size;
  let compactions = 0;
  let effort: string | null = null;
  let firstAt = Number.POSITIVE_INFINITY;
  for (const r of open.requests.values()) {
    if (r.status === 'error') failures++;
    if (r.compactedBefore) compactions++;
    const at = ms(r.startedAt);
    if (r.agentId === MAIN_AGENT_ID && r.effort && at !== null && at < firstAt) {
      firstAt = at;
      effort = r.effort;
    }
  }

  const root = rollupByAgent(open).find((r) => r.kind === 'agent' && r.id === MAIN_AGENT_ID);
  const usage = root?.total;
  const subAgents: [number, number][] = [];
  for (const a of open.agents.values()) {
    if (a.id === MAIN_AGENT_ID) continue;
    const from = ms(a.startedAt);
    if (from !== null) subAgents.push([from, ms(a.endedAt) ?? (running ? now : from)]);
  }

  return {
    agent: open.session.agent,
    model: open.session.model ? clean(open.session.model) : null,
    effort: effort ? clean(effort) : null,
    nativeId: open.session.nativeId,
    start: ms(open.session.startedAt),
    end: running ? now : (ms(open.session.updatedAt) ?? now),
    running,
    project: printedProject(open.session.cwd, open.session.project),
    title: open.session.title ? printedTitle(open.session.title) : null,
    durationMs: s.requests === 0 ? null : s.activeMs,
    work: {
      requests: s.requests,
      toolCalls: s.toolCalls,
      categories,
      subAgents: Math.max(0, open.agents.size - 1),
      turns: s.turns,
      failures,
      compactions,
    },
    time: {
      thinking: breakdown.model.thinking,
      generating: breakdown.model.generating,
      tools: Object.values(breakdown.tools).reduce((a, b) => a + (b ?? 0), 0),
      approval: breakdown.approval,
      queued: breakdown.model.waiting,
      longestThink: segments.reduce(
        (m, g) => (g.kind === 'thinking' ? Math.max(m, g.end - g.start) : m),
        0,
      ),
    },
    tokens: {
      measured: s.measured,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      uncached: usage?.input ?? 0,
      output: usage?.output ?? 0,
      thinking: usage?.thinking ?? 0,
      cacheHit: s.cacheHitRate,
      total: usage ? totalTokens(usage) : 0,
    },
    segments,
    subAgents,
    failedTools,
  };
}

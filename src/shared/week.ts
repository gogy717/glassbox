/**
 * The weekly receipt's data: `GET /api/week?window=week|7d[&refresh=1]`.
 *
 * The response is NDJSON: zero or more `progress` lines (`done` never goes down), then one
 * `result` line, or an `error` line. Every session on the machine is read once and kept as sparse
 * hourly buckets, keyed by its id and `updatedAt`; a window is a slice of those buckets, so
 * switching windows reads no file again. Without `refresh` a session read before is served as it
 * was then (the result's `asOf` says when); `refresh=1` reads again every session whose
 * `updatedAt` changed since. Only one computation runs at a time: requests made meanwhile share
 * it, progress included.
 *
 * Every figure follows the session's own R1 receipt, cut to the window: a request, a tool call
 * or a failure counts in the hour its start falls in, usage goes with its request, a turn's
 * active time and a segment's agent time are split at hour boundaries.
 */
import type { AgentKind, TokenUsage } from '../core/model.js';
import type { ToolCategory } from './tool-category.js';

export type WeekWindowKind = 'week' | '7d';

export interface WeekWindow {
  kind: WeekWindowKind;
  /**
   * Start (epoch ms) of each hour of the window, in order: local whole hours. 'week': from this
   * Monday 00:00 to next Monday 00:00 (168 hours; 167 or 169 in a week that changes the clocks),
   * hours after `now` included and empty. '7d': 168 hours ending with the current one (e.g.
   * Sat 17 21:00 → Sat 24 20:00 at 20:41), the current one still in progress.
   */
  hourStarts: number[];
  /** When the window ends: the time of the request. Hours starting after it are the future. */
  now: number;
}

/** What a session did inside the window. */
export interface WeekFigures {
  /** The main agent's turns, cut to the window: the Summary bar's active time. */
  activeMs: number;
  /**
   * Working time of the main agent and its sub-agents (thinking, generating, tools; queueing
   * for the API left out),
   * each agent's overlapping work counted once, the agents added up: parallel agents exceed the
   * wall clock. The sum of `hours`.
   */
  agentMs: number;
  /** Model calls of the main agent and its sub-agents. */
  requests: number;
  toolCalls: number;
  /** Tool calls by `toolCategory`; categories with none are left out. */
  toolCats: Partial<Record<ToolCategory, number>>;
  /** Sub-agents alive at some point in the window. */
  subAgents: number;
  /** Failed requests and failed tool calls. */
  failures: number;
  usage: TokenUsage;
  /** Whether any request in the window reported usage; until one does, `usage` is unknown. */
  measured: boolean;
}

export interface WeekSession {
  id: string;
  agent: AgentKind;
  /** Raw: the client prints them through `printedProject` / `printedTitle`. */
  project: string;
  cwd: string | null;
  title: string | null;
  inWindow: WeekFigures;
  /** Agent time (ms) per hour, aligned with `WeekWindow.hourStarts`. */
  hours: number[];
}

export interface WeekStats {
  /** Sessions whose `updatedAt` falls in the window (the others are not read). */
  considered: number;
  /** Of those, read from disk by this request, and served from what was read before. */
  read: number;
  cached: number;
  /** Could not be read; left out of the result (the server logs why). */
  failed: number;
  /** Bytes of the files read by this request. */
  bytes: number;
  /** How long this request took, reading included. */
  ms: number;
}

export interface WeekResult {
  window: WeekWindow;
  /** Sessions with any activity in the window, most active first. */
  sessions: WeekSession[];
  /** When the oldest data in the result was read (epoch ms). */
  asOf: number;
  stats: WeekStats;
}

/** The endpoint's path for a window. */
export const weekPath = (kind: WeekWindowKind, refresh = false) =>
  `/api/week?window=${kind}${refresh ? '&refresh=1' : ''}`;

export type WeekLine =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; result: WeekResult }
  | { type: 'error'; error: string };

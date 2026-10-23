/**
 * HTTP + Server-Sent Events protocol between the glassbox server and the web UI.
 *
 * CONTRACT: the server and the web UI both depend on this file; change them together.
 */
import type {
  IsoTime,
  QuotaSnapshot,
  RequestDetail,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
} from '../core/model.js';
import type { RunState } from './runs.js';

export const DEFAULT_PORT = 7788;
export const DEFAULT_HOST = '127.0.0.1';

/**
 * Security model (the server can read every transcript and, with runs, start Claude Code):
 * - only connections whose socket peer is a loopback address are served; forwarding headers
 *   are ignored;
 * - every /api request must carry a Host header whose hostname is `localhost`, `127.0.0.1`
 *   or `[::1]` (any port) — this defeats DNS rebinding; otherwise 403;
 * - when an Origin header is present it must have one of those hostnames and no userinfo;
 *   otherwise 403;
 * - every POST/PUT/PATCH/DELETE must carry `TOKEN_HEADER` equal to the per-launch random token
 *   from `api.token()`; otherwise 403. Responses never include CORS headers;
 * - no page may frame glassbox (clickjacking could approve a permission prompt): every response
 *   sends `X-Frame-Options: DENY` and a CSP with `frame-ancestors 'none'`;
 * - parsing is bounded: untrusted transcript text never meets a super-linear regex, so one
 *   hostile file cannot freeze the event loop;
 * - responses are bounded too: every JSON body and event `data` nests at most 256 levels, and a
 *   deeper array or object is replaced by the string `[nested deeper than 256 levels]`, so one
 *   hostile file cannot make the session it is in unviewable.
 */
export const TOKEN_HEADER = 'x-glassbox-token';

const enc = encodeURIComponent;

export const api = {
  /** GET → TokenResponse. The token is random per server launch. */
  token: () => '/api/token',
  /** GET → QuotaResponse. */
  quota: () => '/api/quota',
  /** GET → SessionSummary[]: busy/waiting sessions first, then newest `updatedAt` first. */
  sessions: () => '/api/sessions',
  /** GET → SessionSnapshot. 404 when unknown. */
  session: (sessionId: string) => `/api/sessions/${enc(sessionId)}`,
  /** GET → RequestDetail. 404 when the request is unknown. */
  requestDetail: (sessionId: string, requestId: string) =>
    `/api/sessions/${enc(sessionId)}/requests/${enc(requestId)}/detail`,
  /** GET → ToolResultResponse. 404 when the tool call is unknown. */
  toolResult: (sessionId: string, toolCallId: string) =>
    `/api/sessions/${enc(sessionId)}/tool-calls/${enc(toolCallId)}/result`,
  /**
   * GET → text/event-stream of ServerEvent. Always streams `sessions` updates; with a
   * session id it first sends that session's `snapshot`, then its `patch` events.
   */
  events: (sessionId?: string) =>
    sessionId ? `/api/events?session=${enc(sessionId)}` : '/api/events',
} as const;

export type SessionsResponse = SessionSummary[];
export type SessionResponse = SessionSnapshot;
export type RequestDetailResponse = RequestDetail;
export interface ToolResultResponse {
  toolCallId: string;
  result: unknown;
}
export interface ApiErrorResponse {
  error: string;
}
export interface TokenResponse {
  token: string;
}
/** One snapshot per adapter that reports quota; empty when none does. */
export interface QuotaResponse {
  quotas: QuotaSnapshot[];
}

/**
 * Each SSE message uses the event's `type` as the SSE `event:` name and the whole object,
 * JSON-encoded, as `data:`.
 */
export type ServerEvent =
  /** Full session list; sent on connect and whenever it changes (throttled to ≤ 1/s). */
  | { type: 'sessions'; sessions: SessionSummary[] }
  /**
   * Full state of the subscribed session. Sent after connect, and again whenever the server
   * rebuilds the session (e.g. a file was truncated); clients replace all session state.
   */
  | { type: 'snapshot'; sessionId: string; snapshot: SessionSnapshot }
  /** Changed entities of the subscribed session (batched, ≤ 10/s). */
  | { type: 'patch'; sessionId: string; patch: SessionPatch }
  /**
   * The subscribed session id is still unknown 30 s after connecting (the server keeps
   * looking meanwhile and sends `snapshot` the moment it appears). Sent at most once per
   * connection; the connection stays open.
   */
  | { type: 'session-missing'; sessionId: string }
  /** Plan quota; sent on connect and whenever it changes. */
  | { type: 'quota'; quotas: QuotaSnapshot[] }
  /** A glassbox-owned run changed (see runs.ts). Sent to every connection, ≤ 20/s per run. */
  | { type: 'run'; run: RunState }
  /** Every 15 s so clients can detect a dead connection. */
  | { type: 'heartbeat'; now: IsoTime };

export type ServerEventType = ServerEvent['type'];

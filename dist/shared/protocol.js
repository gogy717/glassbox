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
    /** GET → RateResponse. */
    rate: () => '/api/rate',
    /** GET → SessionSummary[]: busy/waiting sessions first, then newest `updatedAt` first. */
    sessions: () => '/api/sessions',
    /** GET → SessionSnapshot. 404 when unknown. */
    session: (sessionId) => `/api/sessions/${enc(sessionId)}`,
    /** GET → RequestDetail. 404 when the request is unknown. */
    requestDetail: (sessionId, requestId) => `/api/sessions/${enc(sessionId)}/requests/${enc(requestId)}/detail`,
    /**
     * GET → ContextBillResponse: what the agent's finished requests carried in their contexts
     * (`context-bill.ts`). 404 when the session is unknown; an agent without requests has none.
     */
    contextBill: (sessionId, agentId) => `/api/sessions/${enc(sessionId)}/context?agent=${enc(agentId)}`,
    /** GET → ToolResultResponse. 404 when the tool call is unknown. */
    toolResult: (sessionId, toolCallId) => `/api/sessions/${enc(sessionId)}/tool-calls/${enc(toolCallId)}/result`,
    /**
     * GET → text/event-stream of ServerEvent. Always streams `sessions` updates; with a
     * session id it first sends that session's `snapshot`, then its `patch` events.
     */
    events: (sessionId) => sessionId ? `/api/events?session=${enc(sessionId)}` : '/api/events',
};
//# sourceMappingURL=protocol.js.map
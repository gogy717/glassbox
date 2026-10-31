const HOUR_MS = 3_600_000;
const SESSION_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
/** When no window is known, the list covers this much before now: a session window's length. */
export const BURN_FALLBACK_MS = SESSION_MS;
/** The endpoint's path. */
export const burnPath = (provider, since) => `/api/quota/burn?provider=${encodeURIComponent(provider)}&since=${Math.round(since)}`;
/** Every kind of token: thinking is part of output, and web searches are not tokens. */
export const burnTokens = (u) => u.input + u.cacheRead + u.cacheWrite + u.output;
/** The same moment of the calendar month before, in UTC; the 31st of March goes back to 28 February. */
function monthBefore(t) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return Date.UTC(y, m - 1, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}
/** A window's length: its source's, else its kind's (a monthly one: the month to its reset). */
export function windowLength(w, reset) {
    if (w.durationMs !== undefined && w.durationMs > 0)
        return w.durationMs;
    switch (w.kind) {
        case 'session':
            return SESSION_MS;
        case 'weekly':
        case 'weekly-model':
            return WEEK_MS;
        case 'monthly':
            return reset - monthBefore(reset);
        default:
            return null;
    }
}
/**
 * When the window began (epoch ms): its reset less its length. Null without a reset time, for a
 * window of unknown length, or one past its reset (a window gone by, whose start is not now's).
 */
export function windowStart(w, now) {
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
    if (!Number.isFinite(reset) || reset <= now)
        return null;
    const length = windowLength(w, reset);
    return length === null ? null : reset - length;
}
/**
 * The window the list covers: the provider's 5-hour window when it has one (the quickest to
 * move, and the one a person waits on), else its current window closest to its limit. Null when
 * no window is current.
 */
export function burnWindow(q, now) {
    const current = (q?.windows ?? []).filter((w) => windowStart(w, now) !== null);
    return (current.find((w) => w.kind === 'session') ??
        current.reduce((a, b) => (!a || b.usedPercent > a.usedPercent ? b : a), null));
}
/** Where the list starts: the window's start, else `BURN_FALLBACK_MS` before now. */
export function burnSince(q, now) {
    const w = burnWindow(q, now);
    return (w && windowStart(w, now)) ?? now - BURN_FALLBACK_MS;
}
/** The provider of every request of an agent that only ever talks to one. */
const SINGLE_PROVIDER = {
    'claude-code': 'anthropic',
    codex: 'openai',
    grok: 'xai',
};
/** A model's provider, by its name: an explicit `provider/` prefix first, then the family. */
function modelProvider(model) {
    const m = model.toLowerCase();
    const prefix = m.includes('/') ? m.slice(0, m.indexOf('/')) : '';
    if (/copilot/.test(prefix))
        return 'github-copilot';
    const name = /^(anthropic|openai|xai|deepseek)$/.test(prefix) ? prefix : m;
    if (/anthropic|claude/.test(name))
        return 'anthropic';
    if (/xai|grok/.test(name))
        return 'xai';
    if (/deepseek/.test(name))
        return 'deepseek';
    if (/openai|gpt|codex|(^|\/)o\d/.test(name))
        return 'openai';
    return null;
}
/** The provider a request of `agent` to `model` counts against; null when it cannot be told. */
export function requestProvider(agent, model) {
    return SINGLE_PROVIDER[agent] ?? (model ? modelProvider(model) : null);
}
/** Whether a session of `agent` may have used `provider`'s plan at all. */
export function mayUse(agent, provider) {
    const single = SINGLE_PROVIDER[agent];
    return single === undefined || single === provider;
}
/** The first `n` sessions, and the rest folded into one "and N more" with their tokens and share. */
export function topBurn(sessions, n) {
    const rest = sessions.slice(n);
    return {
        top: sessions.slice(0, n),
        more: {
            count: rest.length,
            tokens: rest.reduce((a, s) => a + s.tokens, 0),
            share: rest.reduce((a, s) => a + s.share, 0),
        },
    };
}
//# sourceMappingURL=quota-burn.js.map
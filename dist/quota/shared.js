/** Fetched numbers older than this are shown as stale. */
export const STALE_MS = 60 * 60 * 1000;
export const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
export const obj = (v) => (isObj(v) ? v : null);
export const str = (v) => typeof v === 'string' && v.trim() !== '' ? v : null;
export const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
export function msToIso(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms))
        return null;
    const d = new Date(ms);
    // Beyond ±8.64e15 ms a Date is invalid and toISOString() would throw.
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** The order windows are listed in. */
export const KIND_ORDER = [
    'session',
    'weekly',
    'weekly-model',
    'monthly',
    'other',
];
export const DAY_MINUTES = 24 * 60;
/**
 * A window's kind from its length in minutes, with Codex's own 5% slack: up to 5 hours is a
 * session, a week weekly, a calendar month (28 to 31 days) monthly.
 */
export function windowKind(minutes) {
    if (minutes === null || minutes <= 0)
        return 'other';
    if (minutes <= 5 * 60 * 1.05)
        return 'session';
    if (Math.abs(minutes - 7 * DAY_MINUTES) <= 7 * DAY_MINUTES * 0.05)
        return 'weekly';
    if (minutes >= 28 * DAY_MINUTES && minutes <= 31 * DAY_MINUTES * 1.05)
        return 'monthly';
    return 'other';
}
/** "galaxy_brain" → "Galaxy Brain". */
export function spellOut(id) {
    return id
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map((w) => w[0]?.toUpperCase() + w.slice(1))
        .join(' ');
}
/** The names Codex's /status gives its `PlanType` values (`codex-rs/tui/src/subscription.rs`). */
const PLANS = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro 200',
    prolite: 'Pro 100',
    promax: 'Pro 500',
    team: 'Business',
    self_serve_business_usage_based: 'Business',
    business: 'Enterprise',
    self_serve_business_prolite: 'Business Premium',
    enterprise_cbp_automation: 'Enterprise (Automation)',
    enterprise: 'Enterprise',
    ent26: 'Enterprise',
    enterprise_cbp_usage_based: 'Enterprise',
    edu: 'Edu',
    edu_plus: 'Edu Plus',
    edu_pro: 'Edu Pro',
    sci: 'Academic Researchers',
    sci_plus: 'Academic Researchers Plus',
};
/** A ChatGPT plan name from its `plan_type`; null when missing or "unknown". */
export function codexPlanName(planType) {
    const id = str(planType)?.toLowerCase();
    if (!id || id === 'unknown')
        return null;
    return PLANS[id] ?? spellOut(id);
}
//# sourceMappingURL=shared.js.map
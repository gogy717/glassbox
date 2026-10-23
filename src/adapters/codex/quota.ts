/**
 * Plan quota from Codex rollouts. With a ChatGPT sign-in, the rate limits that come back with
 * every response are written to the rollout as `rate_limits` on an `event_msg` / `token_count`
 * record (`RateLimitSnapshot` in Codex's `codex-rs/protocol/src/protocol.rs`); an API-key
 * sign-in writes null there. No network, no credentials: only the tails of the newest rollouts
 * are read.
 *
 * A snapshot belongs to one bucket (`limit_id`): "codex" (or null) is the plan, others are
 * model allowances such as "codex_bengalfox", named by `limit_name`. Codex records only the
 * bucket it heard about last, so the last snapshot of each bucket in the tail is used.
 */
import { open, stat } from 'node:fs/promises';
import type { QuotaSnapshot, QuotaWindow } from '../../core/model.js';
import type { CodexScan } from './discovery.js';

const STALE_MS = 60 * 60 * 1000;
/** Rollouts looked at, newest first. An older one's rate limits would be long stale. */
const NEWEST_ROLLOUTS = 3;
/** Read from the end of a rollout: Codex writes a token_count after every response. */
const TAIL_BYTES = 1024 * 1024;
const PLAN_BUCKET = 'codex';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function msToIso(ms: number | null): string | null {
  if (ms === null) return null;
  const d = new Date(ms);
  // Beyond ±8.64e15 ms a Date is invalid and toISOString() would throw.
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const DAY_MINUTES = 24 * 60;

/**
 * A window's kind from its length in minutes, with Codex's own 5% slack: up to 5 hours is a
 * session, a week weekly, a calendar month (28 to 31 days) monthly.
 */
export function windowKind(minutes: number | null): QuotaWindow['kind'] {
  if (minutes === null || minutes <= 0) return 'other';
  if (minutes <= 5 * 60 * 1.05) return 'session';
  if (Math.abs(minutes - 7 * DAY_MINUTES) <= 7 * DAY_MINUTES * 0.05) return 'weekly';
  if (minutes >= 28 * DAY_MINUTES && minutes <= 31 * DAY_MINUTES * 1.05) return 'monthly';
  return 'other';
}

/** "galaxy_brain" → "Galaxy Brain". */
export function spellOut(id: string): string {
  return id
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');
}

/** The names Codex's /status gives its `PlanType` values (`codex-rs/tui/src/subscription.rs`). */
const PLANS: Record<string, string> = {
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
export function codexPlanName(planType: unknown): string | null {
  const id = str(planType)?.toLowerCase();
  if (!id || id === 'unknown') return null;
  return PLANS[id] ?? spellOut(id);
}

/** "5h", "1d", "90m". */
function duration(minutes: number): string {
  if (minutes % DAY_MINUTES === 0) return `${minutes / DAY_MINUTES}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

interface Bucket {
  id: string;
  limits: Obj;
  /** When the record was written, in ms. */
  at: number;
}

function bucketOf(line: string): Bucket | null {
  // Cheap filter: most records are transcript items, some of them large.
  if (!line.includes('"rate_limits"')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.type !== 'event_msg' || !isObj(raw.payload)) return null;
  const { payload } = raw;
  if (payload.type !== 'token_count' || !isObj(payload.rate_limits)) return null;
  const at = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const limits = payload.rate_limits;
  return { id: str(limits.limit_id)?.toLowerCase() ?? PLAN_BUCKET, limits, at };
}

function windowOf(bucket: Bucket, key: 'primary' | 'secondary'): QuotaWindow | null {
  const w = bucket.limits[key];
  const used = isObj(w) ? num(w.used_percent) : null;
  if (!isObj(w) || used === null) return null;
  const minutes = num(w.window_minutes);
  const resetsAt = num(w.resets_at);
  const resetsIn = num(w.resets_in_seconds);
  const window = {
    usedPercent: Math.min(100, Math.max(0, used)),
    resetsAt:
      resetsAt !== null
        ? msToIso(resetsAt * 1000)
        : resetsIn !== null
          ? msToIso(bucket.at + resetsIn * 1000)
          : null,
  };
  const kind = windowKind(minutes);
  if (bucket.id === PLAN_BUCKET) return { id: key, kind, label: null, model: null, ...window };
  const model = str(bucket.limits.limit_name) ?? bucket.id;
  const id = `${bucket.id}:${key}`;
  if (kind === 'weekly') return { id, kind: 'weekly-model', label: null, model, ...window };
  const label = minutes !== null && minutes > 0 ? `${model} (${duration(minutes)})` : model;
  return { id, kind: 'other', label, model, ...window };
}

const KIND_ORDER: QuotaWindow['kind'][] = ['session', 'weekly', 'weekly-model', 'monthly', 'other'];

/** Quota from rollout lines (in file order), or null when none carries usable rate limits. */
export function quotaFromRolloutLines(lines: string[], now: number): QuotaSnapshot | null {
  const buckets = new Map<string, Bucket>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const bucket = bucketOf(lines[i] ?? '');
    if (bucket && !buckets.has(bucket.id)) buckets.set(bucket.id, bucket);
  }
  const plan = buckets.get(PLAN_BUCKET);
  const ordered = [...(plan ? [plan] : []), ...[...buckets.values()].filter((b) => b !== plan)];

  const windows: QuotaWindow[] = [];
  let fetchedAtMs = Number.NEGATIVE_INFINITY;
  for (const bucket of ordered) {
    const found = [windowOf(bucket, 'primary'), windowOf(bucket, 'secondary')].filter(
      (w): w is QuotaWindow => w !== null,
    );
    if (found.length > 0) fetchedAtMs = Math.max(fetchedAtMs, bucket.at);
    windows.push(...found);
  }
  const fetchedAt = msToIso(fetchedAtMs);
  if (windows.length === 0 || fetchedAt === null) return null;
  windows.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

  return {
    provider: 'openai',
    agent: 'codex',
    plan: ordered.map((b) => codexPlanName(b.limits.plan_type)).find((p) => p !== null) ?? null,
    fetchedAt,
    stale: now - fetchedAtMs > STALE_MS,
    windows,
    extraUsage: null,
    balance: null,
    source: 'codex-session',
  };
}

/** The last TAIL_BYTES of a file as whole lines; a line cut by the start is dropped. */
async function readTail(path: string): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

/**
 * Quota from the newest rollouts of a scan: the newest few sessions' plain rollouts (sub-agents
 * included, archives not), newest first, until one has rate limits. Never rejects.
 */
export async function readCodexQuota(
  scan: CodexScan,
  now: number = Date.now(),
): Promise<QuotaSnapshot | null> {
  const sessions = [...scan.sources]
    .sort((a, b) => Date.parse(b.summary.updatedAt) - Date.parse(a.summary.updatedAt))
    .slice(0, NEWEST_ROLLOUTS);
  const files = sessions.flatMap((s) => scan.files.get(s.nativeId) ?? []).filter((f) => !f.encoded);
  const dated = await Promise.all(
    files.map(async (f) => ({
      path: f.path,
      mtimeMs: await stat(f.path).then(
        (s) => s.mtimeMs,
        () => null,
      ),
    })),
  );
  const newest = dated
    .filter((f): f is { path: string; mtimeMs: number } => f.mtimeMs !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, NEWEST_ROLLOUTS);
  for (const { path } of newest) {
    const lines = await readTail(path).catch(() => null);
    const quota = lines ? quotaFromRolloutLines(lines, now) : null;
    if (quota) return quota;
  }
  return null;
}

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
import {
  codexPlanName,
  DAY_MINUTES,
  isObj,
  KIND_ORDER,
  msToIso,
  num,
  type Obj,
  STALE_MS,
  str,
  windowKind,
} from '../../quota/shared.js';
import type { CodexScan } from './discovery.js';

/** Rollouts looked at, newest first. An older one's rate limits would be long stale. */
const NEWEST_ROLLOUTS = 3;
/** Read from the end of a rollout: Codex writes a token_count after every response. */
const TAIL_BYTES = 1024 * 1024;
const PLAN_BUCKET = 'codex';

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

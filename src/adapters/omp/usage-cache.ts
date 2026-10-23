/**
 * Plan quota from oh-my-pi's usage cache: the `cache` table of `<agent dir>/agent.db`, where
 * oh-my-pi keeps the last usage report of every provider account it is signed in to, in rows
 * keyed `usage_cache:report:<provider>:<baseUrl>:<account>`. No network, no credentials.
 *
 * Keys and reports name the account (e-mail, account and org ids). Only the `value` column is
 * selected, and only the provider, fetch time, plan and each limit's id, label, window and
 * amount are read out of it; nothing else is kept, logged or returned.
 *
 * Read only, the files beside the database included: one short query on a read-only connection,
 * closed straight after. `cacheDbUrl` says how it is opened, and the one race it leaves.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QuotaProvider, QuotaSnapshot, QuotaWindow } from '../../core/model.js';
import type { QuotaSource } from '../../core/quota-source.js';
import { codexPlanName, spellOut, windowKind } from '../codex/quota.js';

const STALE_MS = 60 * 60 * 1000;
/** How long a read may wait on oh-my-pi's lock; the query itself blocks the event loop. */
const BUSY_TIMEOUT_MS = 100;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function msToIso(ms: number | null): string | null {
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The model vendor whose plan an oh-my-pi provider id reports on. */
export function ompQuotaProvider(id: string): QuotaProvider {
  if (id === 'xai-oauth') return 'xai';
  if (id === 'openai-codex') return 'openai';
  if (id.startsWith('anthropic')) return 'anthropic';
  return id.replace(/-oauth$/, '');
}

const UNIT_MINUTES: Record<string, number> = {
  m: 1,
  h: 60,
  d: 24 * 60,
  w: 7 * 24 * 60,
  mo: 30 * 24 * 60,
};

/** By the window's length when oh-my-pi knows it, else by its id ("5h", "1w", "monthly"). */
function kindOf(window: Obj | null): QuotaWindow['kind'] {
  const ms = num(window?.durationMs);
  if (ms !== null && ms > 0) return windowKind(ms / 60_000);
  const id = str(window?.id)?.toLowerCase() ?? '';
  if (id === 'monthly') return 'monthly';
  if (id === 'weekly') return 'weekly';
  const m = /^(\d+)(mo|m|h|d|w)$/.exec(id);
  return m ? windowKind(Number(m[1]) * (UNIT_MINUTES[m[2] ?? ''] ?? 0)) : 'other';
}

/**
 * 0..100 from whichever amount the provider filled in, in oh-my-pi's own order: the used
 * fraction, used / limit, a used percentage, what remains. Null when none is usable (e.g.
 * Copilot's premium requests reported as 0 of 0).
 */
function usedPercent(amount: Obj): number | null {
  const fraction = num(amount.usedFraction);
  const used = num(amount.used);
  const limit = num(amount.limit);
  const remaining = num(amount.remainingFraction);
  const percent =
    fraction !== null
      ? fraction * 100
      : used !== null && limit !== null && limit > 0
        ? (used * 100) / limit
        : used !== null && amount.unit === 'percent'
          ? used
          : remaining !== null
            ? (1 - remaining) * 100
            : null;
  return percent === null ? null : Math.min(100, Math.max(0, percent));
}

/**
 * A limit as a window; null when its status is "unknown" (its numbers are not to be trusted).
 * Its id loses oh-my-pi's `<provider>:` prefix ("xai-oauth:credits:1w" → "credits:1w"), so it
 * matches what other sources of the same provider call that window.
 */
function windowOf(limit: unknown, provider: string): QuotaWindow | null {
  const l = obj(limit);
  const id = str(l?.id);
  const amount = obj(l?.amount);
  const used = amount ? usedPercent(amount) : null;
  if (!l || !id || used === null || l.status === 'unknown') return null;
  const window = obj(l.window);
  const prefix = `${provider}:`;
  return {
    id: id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : id,
    kind: kindOf(window),
    label: str(l.label),
    model: null,
    usedPercent: used,
    resetsAt: msToIso(num(window?.resetsAt)),
  };
}

/** Plan from the report's metadata: ChatGPT's `planType` ("free") or Copilot's `plan`. */
function planOf(provider: QuotaProvider, metadata: Obj | null): string | null {
  const plan = str(metadata?.planType) ?? str(metadata?.plan);
  if (!plan) return null;
  return provider === 'openai' ? codexPlanName(plan) : spellOut(plan);
}

const KIND_ORDER: QuotaWindow['kind'][] = ['session', 'weekly', 'weekly-model', 'monthly', 'other'];

/** One cached report (a `value` column) as a snapshot; null when malformed or without windows. */
function snapshotOf(value: unknown, now: number): QuotaSnapshot | null {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : null;
  } catch {
    return null;
  }
  const report = obj(obj(parsed)?.value);
  const id = str(report?.provider);
  const fetchedAtMs = num(report?.fetchedAt);
  const fetchedAt = msToIso(fetchedAtMs);
  if (!report || !id || fetchedAtMs === null || fetchedAt === null) return null;

  const windows: QuotaWindow[] = [];
  for (const limit of Array.isArray(report.limits) ? report.limits : []) {
    const w = windowOf(limit, id);
    if (w && !windows.some((x) => x.id === w.id)) windows.push(w);
  }
  if (windows.length === 0) return null;
  windows.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

  const provider = ompQuotaProvider(id);
  return {
    provider,
    agent: 'oh-my-pi',
    plan: planOf(provider, obj(report.metadata)),
    fetchedAt,
    stale: now - fetchedAtMs > STALE_MS,
    windows,
    extraUsage: null,
    balance: null,
    source: 'oh-my-pi-cache',
  };
}

/**
 * Snapshots from the `value` column of cached usage reports, one per provider: the newest
 * report with windows wins (Copilot keeps one report per API base URL).
 */
export function quotasFromCacheValues(values: unknown[], now: number): QuotaSnapshot[] {
  const best = new Map<QuotaProvider, QuotaSnapshot>();
  for (const value of values) {
    const q = snapshotOf(value, now);
    const kept = q && best.get(q.provider);
    if (q && (!kept || Date.parse(q.fetchedAt) > Date.parse(kept.fetchedAt))) {
      best.set(q.provider, q);
    }
  }
  return [...best.values()];
}

/** Runs `load` with Node's "SQLite is an experimental feature" warning (Node 22) muted. */
export async function withoutSqliteWarning<T>(load: () => Promise<T>): Promise<T> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const options = rest[0];
    const type = typeof options === 'string' ? options : obj(options)?.type;
    const text = typeof warning === 'string' ? warning : warning.message;
    if (type === 'ExperimentalWarning' && text.startsWith('SQLite')) return;
    Reflect.apply(emit, process, [warning, ...rest]);
  }) as typeof process.emitWarning;
  try {
    return await load();
  } finally {
    process.emitWarning = emit;
  }
}

type Sqlite = typeof import('node:sqlite');
let sqlite: Promise<Sqlite> | null = null;

/** `node:sqlite`, loaded on first use: only when there is a database to read. */
function loadSqlite(): Promise<Sqlite> {
  sqlite ??= withoutSqliteWarning(() => import('node:sqlite'));
  return sqlite;
}

/**
 * How to open agent.db so that no file beside it changes. A plain read-only connection would:
 * SQLite creates a missing `-wal` / `-shm`, gives an empty one the database file's mode
 * (`robust_open`), and writes read marks into `-shm` or rebuilds it.
 *
 * - The WAL is read only when it holds pages and `-wal` and `-shm` already have the database
 *   file's mode, so the mode SQLite would set is the one they have, even if oh-my-pi empties
 *   the WAL between this check and the read. `readonly_shm` makes SQLite only read `-shm`.
 *   Only a WAL deleted in that moment (oh-my-pi's last connection closing) gets past this:
 *   SQLite then creates an empty one in the database's mode, and the read fails once.
 * - Otherwise agent.db is read alone, immutable: pages still in the WAL are not seen until
 *   oh-my-pi checkpoints them. An immutable read takes no lock, so one that overlaps a
 *   checkpoint can see a half-written page: a row that fails to parse is skipped, an SQLite
 *   error is logged once, and the watcher reads again before it lets a provider vanish.
 */
export function cacheDbUrl(path: string): URL {
  const stat = (file: string) => statSync(file, { throwIfNoEntry: false });
  const db = stat(path);
  const wal = stat(`${path}-wal`);
  const sameMode = (st: ReturnType<typeof stat>) =>
    st !== undefined && db !== undefined && (st.mode & 0o777) === (db.mode & 0o777);
  const url = pathToFileURL(path);
  if (wal && wal.size > 0 && sameMode(wal) && sameMode(stat(`${path}-shm`))) {
    url.searchParams.set('mode', 'ro');
    url.searchParams.set('readonly_shm', '1');
  } else {
    url.searchParams.set('immutable', '1');
  }
  return url;
}

/** The `value` of every usage report oh-my-pi itself would still serve (within retention). */
export async function readCacheValues(url: URL, now: number): Promise<unknown[]> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(url, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    return db
      .prepare("SELECT value FROM cache WHERE key GLOB 'usage_cache:report:*' AND expires_at > ?")
      .all(Math.floor(now / 1000))
      .map((row) => row.value);
  } finally {
    db.close();
  }
}

export interface OmpUsageCacheOptions {
  /** oh-my-pi's agent dir, usually `~/.omp/agent`: the one that holds agent.db. */
  agentDir: string;
}

/**
 * The `oh-my-pi-cache` quota source. Empty while there is no database; rejects when there is
 * one that cannot be read (locked past the timeout, not a database, no cache table).
 */
export function createOmpUsageCacheSource({ agentDir }: OmpUsageCacheOptions): QuotaSource {
  const path = join(agentDir, 'agent.db');
  return {
    id: 'oh-my-pi-cache',
    read: async () => {
      if (!existsSync(path)) return [];
      // Loaded first, so the files are looked at right before they are opened.
      await loadSqlite();
      const now = Date.now();
      return quotasFromCacheValues(await readCacheValues(cacheDbUrl(path), now), now);
    },
    watchFiles: () => [path, `${path}-wal`],
  };
}

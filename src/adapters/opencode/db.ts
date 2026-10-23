/**
 * Read-only access to OpenCode's database, `opencode.db`.
 *
 * Every read opens its own connection and closes it again: glassbox holds no lock and no read
 * transaction between reads, and never writes, not even the files SQLite keeps beside the
 * database. An ordinary read-only connection would: it creates a missing `-wal` and `-shm`,
 * writes its read marks into `-shm` (or rebuilds it when no other connection has it open), and
 * `fchmod`s any zero-byte file it opens whose mode is not the database's. See `journalUsable`
 * for how a read avoids all of that.
 *
 * `node:sqlite` is imported on first use, so glassbox loads it only when an OpenCode database
 * exists. Node 22 prints an ExperimentalWarning as it loads; that one warning is dropped.
 */
import { existsSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { MessageRow, PartRow, SessionDocument, SessionRow } from './records.js';

type Sqlite = typeof import('node:sqlite');

/** How long a read waits on a lock before it fails (the event loop waits with it). */
const BUSY_MS = 200;

/** Sessions whose rows stay cached for incremental re-reads; any other is read whole. */
const CACHED_SESSIONS = 64;

const SESSION_COLUMNS =
  'id, parent_id, title, directory, version, agent, model, time_created, time_updated, time_compacting, time_archived';

const SQL = {
  sessions: `SELECT ${SESSION_COLUMNS} FROM session`,
  // UNION, not UNION ALL: a parent_id cycle ends instead of recursing forever.
  tree: `WITH RECURSIVE tree(id) AS (
      SELECT id FROM session WHERE id = ?
      UNION SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.id
    ) SELECT ${SESSION_COLUMNS} FROM session WHERE id IN (SELECT id FROM tree)`,
  message: {
    stat: 'SELECT count(*) AS n, max(time_updated) AS t FROM message WHERE session_id = ?',
    all: 'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ?',
    since:
      'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? AND time_updated >= ?',
  },
  part: {
    stat: 'SELECT count(*) AS n, max(time_updated) AS t FROM part WHERE session_id = ?',
    all: 'SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ?',
    since:
      'SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? AND time_updated >= ?',
  },
  latestMessage:
    'SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1',
};

/** Runs `load` with Node's experimental-SQLite warning dropped; any other warning goes through. */
export async function withoutSqliteWarning<T>(load: () => Promise<T>): Promise<T> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (isSqliteWarning(warning, rest[0])) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await load();
  } finally {
    process.emitWarning = emit;
  }
}

/** Node's "SQLite is an experimental feature" warning, given as (message, type) or (message, { type }). */
export function isSqliteWarning(warning: unknown, typeOrOptions: unknown): boolean {
  const type =
    typeof typeOrOptions === 'string'
      ? typeOrOptions
      : (typeOrOptions as { type?: unknown } | undefined)?.type;
  const isExperimental =
    type === 'ExperimentalWarning' ||
    (warning instanceof Error && warning.name === 'ExperimentalWarning');
  const message = warning instanceof Error ? warning.message : String(warning);
  return isExperimental && message.includes('SQLite');
}

let sqlite: Promise<Sqlite> | null = null;

export function loadSqlite(): Promise<Sqlite> {
  sqlite ??= withoutSqliteWarning(() => import('node:sqlite'));
  return sqlite;
}

/** Test seam: runs between choosing how to open the database and opening it. */
export interface OpenCodeDbIo {
  beforeOpen?: () => void;
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

function walHoldsPages(path: string): boolean {
  try {
    return statSync(`${path}-wal`).size > 0;
  } catch {
    return false;
  }
}

/**
 * Whether the `-wal` journal can be read along with the database (OpenCode keeps most of its
 * data there) without SQLite changing a file: the journal holds pages, and it and `-shm` both
 * exist with the database's mode. Matching modes matter because OpenCode may empty its journal
 * (a checkpoint) between this check and the open, and SQLite `fchmod`s a zero-byte file it
 * opens to the database's mode. `-shm` is opened `readonly_shm`, so it is only ever read. Any
 * other state is read `immutable`: the database file alone, which lacks whatever OpenCode has
 * not checkpointed yet. A journal OpenCode deletes in the instant between this check and the
 * open would be created again, empty, as OpenCode itself does on its next start.
 */
export function journalUsable(path: string): boolean {
  try {
    const mode = modeOf(path);
    return (
      statSync(`${path}-wal`).size > 0 &&
      modeOf(`${path}-wal`) === mode &&
      modeOf(`${path}-shm`) === mode
    );
  } catch {
    return false;
  }
}

function openReadOnly(
  Database: Sqlite['DatabaseSync'],
  path: string,
  journal: boolean,
  io: OpenCodeDbIo,
): DatabaseSync {
  // SQLite would fchmod an empty database file too; it has no tables to read anyway.
  if (!existsSync(path) || statSync(path).size === 0) throw new Error('no database in the file');
  const url = pathToFileURL(path).href;
  io.beforeOpen?.();
  if (!journal) return new Database(`${url}?immutable=1`, { readOnly: true });
  const db = new Database(`${url}?mode=ro&readonly_shm=1`, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
  return db;
}

interface TableCache<Row> {
  count: number;
  maxUpdated: number | null;
  rows: Map<string, Row>;
}

interface SessionCache {
  messages: TableCache<MessageRow>;
  parts: TableCache<PartRow>;
}

type Stat = { n: number; t: number | null };

/**
 * Brings one session's rows of `table` up to date and returns a token that changes whenever
 * they do. Only rows updated since the last read are fetched. A row count that then disagrees
 * means rows were deleted (a revert deletes messages), and the session is read whole.
 */
function sync<Row extends { id: string }>(
  db: DatabaseSync,
  sql: { stat: string; all: string; since: string },
  sessionId: string,
  cache: TableCache<Row>,
): string {
  const stat = db.prepare(sql.stat).get(sessionId) as unknown as Stat;
  if (stat.n !== cache.count || stat.t !== cache.maxUpdated || stat.n !== cache.rows.size) {
    let rows: Map<string, Row> | null = null;
    if (cache.maxUpdated !== null && stat.t !== null) {
      rows = new Map(cache.rows);
      // `>=`: a row written again within the same millisecond is fetched again.
      for (const row of db.prepare(sql.since).all(sessionId, cache.maxUpdated) as unknown as Row[])
        rows.set(row.id, row);
      if (rows.size !== stat.n) rows = null;
    }
    rows ??= new Map(
      (db.prepare(sql.all).all(sessionId) as unknown as Row[]).map((row) => [row.id, row]),
    );
    cache.rows = rows;
    cache.count = stat.n;
    cache.maxUpdated = stat.t;
  }
  return `${stat.n}@${stat.t}`;
}

const byCreated = (a: MessageRow, b: MessageRow) =>
  a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Part ids ascend in creation order.
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export interface SessionActivity {
  sessions: Pick<SessionRow, 'id' | 'parent_id' | 'time_updated'>[];
  /** Newest message of each session updated since the cutoff. */
  latest: Map<string, MessageRow>;
}

export class OpenCodeDb {
  private failing = false;
  /** The journal holds pages that a read had to skip (see `journalUsable`); logged once. */
  private skippedJournal = false;
  private readonly cache = new Map<string, SessionCache>();
  private readonly documents = new Map<string, { version: string; value: SessionDocument }>();

  constructor(
    readonly path: string,
    private readonly log: (msg: string) => void = () => {},
    private readonly io: OpenCodeDbIo = {},
  ) {}

  /** Every session row; null when the database cannot be read right now. */
  sessions(): Promise<SessionRow[] | null> {
    return this.use((db) => db.prepare(SQL.sessions).all() as unknown as SessionRow[]);
  }

  /**
   * `rootId` and every session below it. The version changes whenever any of their rows does;
   * an unchanged tree comes back as the same object. Null when the database cannot be read.
   */
  tree(rootId: string): Promise<{ version: string; value: SessionDocument } | null> {
    return this.use((db) => {
      // One read transaction: every query sees the same state of the database.
      db.exec('BEGIN');
      try {
        const sessions = db.prepare(SQL.tree).all(rootId) as unknown as SessionRow[];
        sessions.sort((a, b) =>
          a.id === rootId ? -1 : b.id === rootId ? 1 : a.time_created - b.time_created,
        );
        const tokens = sessions.map((s) => {
          const entry = this.cached(s.id);
          const messages = sync(db, SQL.message, s.id, entry.messages);
          const parts = sync(db, SQL.part, s.id, entry.parts);
          return `${s.id}:${s.time_updated}:${messages}:${parts}`;
        });
        const version = tokens.join('|');
        const known = this.documents.get(rootId);
        if (known?.version === version) return known;
        const entries = sessions.map((s) => this.cached(s.id));
        const value: SessionDocument = {
          sessions,
          messages: entries.flatMap((e) => [...e.messages.rows.values()]).sort(byCreated),
          parts: entries.flatMap((e) => [...e.parts.rows.values()]).sort(byId),
        };
        const doc = { version, value };
        this.documents.delete(rootId);
        this.documents.set(rootId, doc);
        for (const key of this.documents.keys()) {
          if (this.documents.size <= CACHED_SESSIONS) break;
          this.documents.delete(key);
        }
        return doc;
      } finally {
        db.exec('COMMIT');
      }
    });
  }

  /** Sessions with their parents, and the newest message of those updated since `sinceMs`. */
  activity(sinceMs: number): Promise<SessionActivity | null> {
    return this.use((db) => {
      db.exec('BEGIN');
      try {
        const sessions = db
          .prepare('SELECT id, parent_id, time_updated FROM session')
          .all() as unknown as SessionActivity['sessions'];
        const latest = new Map<string, MessageRow>();
        const query = db.prepare(SQL.latestMessage);
        for (const s of sessions) {
          if (s.time_updated < sinceMs) continue;
          const row = query.get(s.id) as unknown as MessageRow | undefined;
          if (row) latest.set(s.id, row);
        }
        return { sessions, latest };
      } finally {
        db.exec('COMMIT');
      }
    });
  }

  /** The cache entry of a session, most recently used last; the oldest beyond the cap go. */
  private cached(sessionId: string): SessionCache {
    const empty = () => ({ count: -1, maxUpdated: null, rows: new Map() });
    const entry = this.cache.get(sessionId) ?? { messages: empty(), parts: empty() };
    this.cache.delete(sessionId);
    this.cache.set(sessionId, entry);
    for (const key of this.cache.keys()) {
      if (this.cache.size <= CACHED_SESSIONS) break;
      this.cache.delete(key);
    }
    return entry;
  }

  /** `read` on a fresh read-only connection; null (logged once per failing streak) on failure. */
  private async use<T>(read: (db: DatabaseSync) => T): Promise<T | null> {
    try {
      const { DatabaseSync } = await loadSqlite();
      const journal = journalUsable(this.path);
      if (!journal && !this.skippedJournal && walHoldsPages(this.path)) {
        this.skippedJournal = true;
        this.log(
          `reading only the checkpointed part of ${this.path}: its -wal or -shm has another file mode than the database`,
        );
      }
      const db = openReadOnly(DatabaseSync, this.path, journal, this.io);
      try {
        const out = read(db);
        this.failing = false;
        return out;
      } finally {
        db.close();
      }
    } catch (err) {
      if (!this.failing) {
        const why = err instanceof Error ? err.message : String(err);
        this.log(`cannot read the OpenCode database ${this.path}: ${why}`);
      }
      this.failing = true;
      return null;
    }
  }
}

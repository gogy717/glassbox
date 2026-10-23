/**
 * Read-only access to OpenCode's database, `opencode.db`.
 *
 * Every read opens its own connection and closes it again: glassbox holds no lock and no read
 * transaction between reads, and never writes, not even the files SQLite keeps beside the
 * database (`openReadOnly` in `../sqlite.ts` says how).
 */
import type { DatabaseSync } from 'node:sqlite';
import { openReadOnly, type ReadOnlyOptions } from '../sqlite.js';
import type { MessageRow, PartRow, SessionDocument, SessionRow } from './records.js';

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
  messageWritten: 'SELECT max(time_updated) AS t FROM part WHERE message_id = ?',
};

/** Test seam: runs between choosing how to open the database and opening it. */
export type OpenCodeDbIo = Pick<ReadOnlyOptions, 'beforeOpen'>;

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
  /**
   * Newest message of each session whose row was updated since the cutoff, with when that
   * message was last written: its row or any of its parts, which stream without touching the
   * session row.
   */
  latest: Map<string, { row: MessageRow; writtenMs: number }>;
}

export class OpenCodeDb {
  private failing = false;
  /** The journal holds pages that a read had to skip (see `journalUsable`, `../sqlite.ts`); logged once. */
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
        const entries = sessions.map((s) => this.cached(s.id));
        // The tree being read stays cached whatever its size; older sessions make room.
        this.trimCache(new Set(sessions.map((s) => s.id)));
        const tokens = sessions.map((s, i) => {
          const entry = entries[i] as SessionCache;
          const messages = sync(db, SQL.message, s.id, entry.messages);
          const parts = sync(db, SQL.part, s.id, entry.parts);
          return `${s.id}:${s.time_updated}:${messages}:${parts}`;
        });
        const version = tokens.join('|');
        const known = this.documents.get(rootId);
        if (known?.version === version) return known;
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
        const latest: SessionActivity['latest'] = new Map();
        const newest = db.prepare(SQL.latestMessage);
        const written = db.prepare(SQL.messageWritten);
        for (const s of sessions) {
          if (s.time_updated < sinceMs) continue;
          const row = newest.get(s.id) as unknown as MessageRow | undefined;
          if (!row) continue;
          const parts = (written.get(row.id) as unknown as { t: number | null }).t;
          latest.set(s.id, { row, writtenMs: Math.max(row.time_updated, parts ?? 0) });
        }
        return { sessions, latest };
      } finally {
        db.exec('COMMIT');
      }
    });
  }

  /** The cache entry of a session, moved to the most recently used end. */
  private cached(sessionId: string): SessionCache {
    const empty = () => ({ count: -1, maxUpdated: null, rows: new Map() });
    const entry = this.cache.get(sessionId) ?? { messages: empty(), parts: empty() };
    this.cache.delete(sessionId);
    this.cache.set(sessionId, entry);
    return entry;
  }

  /** Drops the least recently used sessions beyond the cap, never one in `keep`. */
  private trimCache(keep: Set<string>): void {
    for (const key of this.cache.keys()) {
      if (this.cache.size <= CACHED_SESSIONS) break;
      if (!keep.has(key)) this.cache.delete(key);
    }
  }

  /** `read` on a fresh read-only connection; null (logged once per failing streak) on failure. */
  private async use<T>(read: (db: DatabaseSync) => T): Promise<T | null> {
    try {
      const db = await openReadOnly(this.path, {
        busyMs: BUSY_MS,
        beforeOpen: this.io.beforeOpen,
        skippedJournal: (why) => {
          if (this.skippedJournal) return;
          this.skippedJournal = true;
          this.log(`reading only the checkpointed part of ${this.path}: ${why}`);
        },
      });
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

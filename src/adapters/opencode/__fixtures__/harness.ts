/**
 * Feeds a parser the way the server does (whole documents, then live changes), and writes
 * synthetic rows into a real SQLite file shaped like OpenCode's for the database tests.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import type { SessionSource, SourceFile } from '../../../core/adapter.js';
import type { LiveState, SessionSnapshot } from '../../../core/model.js';
import { OpenCodeSessionParser } from '../parser.js';
import type { SessionDocument } from '../records.js';
import { at, CWD, ROOT_ID } from './builders.js';

export const DB_PATH = '/home/user/.local/share/opencode/opencode.db';

export const sessionFile: SourceFile = {
  path: DB_PATH,
  format: 'json',
  role: 'session',
  agentId: null,
  workflowRunId: null,
};

export function makeSource(live: LiveState = 'closed'): SessionSource {
  return {
    agent: 'opencode',
    nativeId: ROOT_ID,
    location: DB_PATH,
    summary: {
      id: `opencode:${ROOT_ID}`,
      agent: 'opencode',
      nativeId: ROOT_ID,
      title: null,
      cwd: CWD,
      project: 'garden',
      startedAt: at(0),
      updatedAt: at(0),
      live,
      version: '1.19.4',
      model: null,
      usage: null,
      counts: null,
    },
  };
}

export function feed(doc: SessionDocument, live: LiveState = 'closed'): OpenCodeSessionParser {
  const parser = new OpenCodeSessionParser(makeSource(live));
  parser.ingestJson(sessionFile, doc);
  return parser;
}

export type ReplayStep = { doc: unknown } | { live: LiveState };

const KINDS = ['agents', 'turns', 'requests', 'toolCalls', 'workflows'] as const;

/**
 * Feeds `steps` in order, applies every `patch()` to a client-side store the way the UI does,
 * and after each step compares that store with a fresh `snapshot()`. Returns every difference.
 */
export function replayChecked(
  steps: ReplayStep[],
  live: LiveState = 'busy',
): { parser: OpenCodeSessionParser; problems: string[] } {
  const parser = new OpenCodeSessionParser(makeSource(live));
  const first = parser.snapshot();
  const store = Object.fromEntries(
    KINDS.map((k) => [k, new Map<string, unknown>(first[k].map((e) => [e.id, e]))]),
  ) as Record<(typeof KINDS)[number], Map<string, unknown>>;
  let session: unknown = first.session;
  let diagnostics: unknown = first.diagnostics;
  const problems: string[] = [];
  steps.forEach((step, i) => {
    const ch =
      'live' in step ? parser.setLive(step.live) : parser.ingestJson(sessionFile, step.doc);
    const patch = parser.patch(ch);
    session = patch.session;
    if (patch.diagnostics) diagnostics = patch.diagnostics;
    for (const k of KINDS) {
      for (const e of patch[k]) store[k].set(e.id, e);
      for (const id of patch.removed?.[k] ?? []) store[k].delete(id);
    }
    const fresh: SessionSnapshot = parser.snapshot();
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(session, fresh.session)) problems.push(`step ${i}: session stale`);
    if (!same(diagnostics, fresh.diagnostics)) problems.push(`step ${i}: diagnostics stale`);
    for (const k of KINDS) {
      const ids = new Set(fresh[k].map((e) => e.id));
      for (const e of fresh[k])
        if (!same(store[k].get(e.id), e)) problems.push(`step ${i}: ${k} ${e.id} stale`);
      for (const id of store[k].keys())
        if (!ids.has(id)) problems.push(`step ${i}: ${k} ${id} should be removed`);
    }
  });
  return { parser, problems };
}

/** The tables glassbox reads, with OpenCode 1.19's columns and indexes. */
const SCHEMA = `
  CREATE TABLE session (
    id text PRIMARY KEY, project_id text NOT NULL DEFAULT 'global', workspace_id text,
    parent_id text, slug text NOT NULL DEFAULT 'slug', directory text NOT NULL, path text,
    title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer,
    summary_deletions integer, summary_files integer, summary_diffs text, metadata text,
    cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
    tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
    tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
    revert text, permission text, agent text, model text, time_created integer NOT NULL,
    time_updated integer NOT NULL, time_compacting integer, time_archived integer
  );
  CREATE INDEX session_parent_idx ON session (parent_id);
  CREATE TABLE message (
    id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
    time_updated integer NOT NULL, data text NOT NULL
  );
  CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
  CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  );
  CREATE INDEX part_message_id_id_idx ON part (message_id, id);
  CREATE INDEX part_session_idx ON part (session_id);
`;

/**
 * Creates `path` as OpenCode would (WAL journal, no automatic checkpoints, so new rows stay in
 * the journal) and writes `doc` into it. The connection is returned open, as OpenCode keeps it
 * while running; closing it leaves the files as an exited OpenCode does.
 */
export function createDb(path: string, doc: SessionDocument): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(WAL_SETUP);
  db.exec(SCHEMA);
  insertRows(db, doc);
  return db;
}

const WAL_SETUP = 'PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;';

/** Inserts or replaces rows, as OpenCode's upserts do. */
export function insertRows(db: DatabaseSync, doc: Partial<SessionDocument>): void {
  for (const { sql, rows } of rowInserts(doc)) {
    const statement = db.prepare(sql);
    for (const values of rows) statement.run(...(values as (string | number | null)[]));
  }
}

function rowInserts(doc: Partial<SessionDocument>): { sql: string; rows: unknown[][] }[] {
  return [
    {
      sql: `INSERT OR REPLACE INTO session (id, parent_id, title, directory, version, agent, model, time_created, time_updated, time_compacting, time_archived)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: (doc.sessions ?? []).map((s) => [
        s.id,
        s.parent_id,
        s.title,
        s.directory,
        s.version,
        s.agent,
        s.model,
        s.time_created,
        s.time_updated,
        s.time_compacting,
        s.time_archived,
      ]),
    },
    {
      sql: 'INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?, ?)',
      rows: (doc.messages ?? []).map((m) => [
        m.id,
        m.session_id,
        m.time_created,
        m.time_updated,
        m.data,
      ]),
    },
    {
      sql: 'INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?, ?, ?)',
      rows: (doc.parts ?? []).map((p) => [
        p.id,
        p.message_id,
        p.session_id,
        p.time_created,
        p.time_updated,
        p.data,
      ]),
    },
  ];
}

const WRITER = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { sql, rows } = JSON.parse(line);
  try {
    if (rows) { const st = db.prepare(sql); for (const r of rows) st.run(...r); } else db.exec(sql);
    process.stdout.write('ok\\n');
  } catch (err) {
    process.stdout.write('error ' + err.message + '\\n');
  }
});
`;

/**
 * A database writer in its own process, as OpenCode is: SQLite shares one shared-memory index
 * per file within a process, so only a separate writer shows what a reader does to the files.
 */
export class WriterProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly replies: ((line: string) => void)[] = [];

  private constructor(path: string) {
    this.child = spawn(process.execPath, ['-e', WRITER, path]);
    createInterface({ input: this.child.stdout }).on('line', (line) =>
      this.replies.shift()?.(line),
    );
  }

  /** Creates `path` like `createDb`, from another process. */
  static async create(path: string, doc: SessionDocument): Promise<WriterProcess> {
    const writer = new WriterProcess(path);
    await writer.exec(WAL_SETUP);
    await writer.exec(SCHEMA);
    await writer.insert(doc);
    return writer;
  }

  exec(sql: string): Promise<void> {
    return this.send({ sql });
  }

  async insert(doc: Partial<SessionDocument>): Promise<void> {
    for (const statement of rowInserts(doc)) await this.send(statement);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.stdin.end();
    });
  }

  private send(msg: { sql: string; rows?: unknown[][] }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.replies.push((line) => (line === 'ok' ? resolve() : reject(new Error(line))));
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    });
  }
}

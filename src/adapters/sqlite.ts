/**
 * Read-only access to another app's SQLite database (OpenCode's `opencode.db`, oh-my-pi's
 * `agent.db`) that changes no file: not the database, and not the `-wal` and `-shm` files SQLite
 * keeps beside it. An ordinary read-only connection would: it creates a missing `-wal` and
 * `-shm`, writes its read marks into `-shm` (or rebuilds it when no other connection has it
 * open), and `fchmod`s any zero-byte file it opens whose mode is not the database's. See
 * `journalProblem` for how a read avoids all of that, and the one race it leaves.
 *
 * `node:sqlite` is imported on first use, so glassbox loads it only when such a database exists.
 * Node 22 prints an ExperimentalWarning as it loads; that one warning is dropped.
 */
import { existsSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

type Sqlite = typeof import('node:sqlite');

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

const octal = (mode: number) => mode.toString(8);

/** Why `journalProblem` gives an empty or missing journal; not worth a log line. */
const NO_PAGES = 'its -wal holds no pages';

/**
 * Whether the `-wal` journal can be read along with the database (the owning app keeps its
 * newest data there) without SQLite changing a file: the journal holds pages, and it and `-shm`
 * both exist with the database's mode. Matching modes matter because the app may empty its
 * journal (a checkpoint) between this check and the open, and SQLite `fchmod`s a zero-byte file
 * it opens to the database's mode. `-shm` is opened `readonly_shm`, so it is only ever read.
 * Any other state is read `immutable`: the database file alone, which lacks whatever the app has
 * not checkpointed yet. A journal the app deletes in the instant between this check and the open
 * (its last connection closing) would be created again, empty and in the database's mode, as the
 * app itself does on its next start; that read then fails once. SQLite has no way to forbid it.
 */
export function journalUsable(path: string): boolean {
  return journalProblem(path) === null;
}

/** Why the `-wal` cannot be read along with the database (see `journalUsable`); null when it can. */
export function journalProblem(path: string): string | null {
  try {
    const mode = statSync(path).mode & 0o777;
    const wal = statSync(`${path}-wal`, { throwIfNoEntry: false });
    if (!wal || wal.size === 0) return NO_PAGES;
    if ((wal.mode & 0o777) !== mode)
      return `its -wal has mode ${octal(wal.mode & 0o777)}, the database ${octal(mode)}`;
    const shm = statSync(`${path}-shm`, { throwIfNoEntry: false });
    if (!shm) return 'its -shm is missing';
    if ((shm.mode & 0o777) !== mode)
      return `its -shm has mode ${octal(shm.mode & 0o777)}, the database ${octal(mode)}`;
    return null;
  } catch (err) {
    return `its files cannot be inspected: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export interface ReadOnlyOptions {
  /** How long a read of the journal waits on the owning app's lock (the event loop waits too). */
  busyMs: number;
  /** Hears why a journal that holds pages is left out of the read. */
  skippedJournal?: (why: string) => void;
  /** Test seam: runs between choosing how to open the database and opening it. */
  beforeOpen?: () => void | Promise<void>;
}

/**
 * A fresh read-only connection to `path`, opened as `journalUsable` says: with the journal
 * (`mode=ro&readonly_shm=1`), or the database file alone (`immutable=1`). The caller closes it.
 * Rejects when there is no database, or it cannot be opened.
 */
export async function openReadOnly(path: string, opts: ReadOnlyOptions): Promise<DatabaseSync> {
  // Loaded first, so the files are looked at right before they are opened.
  const { DatabaseSync } = await loadSqlite();
  // SQLite would fchmod an empty database file too; it has no tables to read anyway.
  if (!existsSync(path) || statSync(path).size === 0) throw new Error('no database in the file');
  const problem = journalProblem(path);
  if (problem !== null && problem !== NO_PAGES) opts.skippedJournal?.(problem);
  const url = pathToFileURL(path).href;
  await opts.beforeOpen?.();
  if (problem !== null) return new DatabaseSync(`${url}?immutable=1`, { readOnly: true });
  const db = new DatabaseSync(`${url}?mode=ro&readonly_shm=1`, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${opts.busyMs}`);
  return db;
}

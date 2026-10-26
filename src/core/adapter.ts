/**
 * The seam between agent-specific storage and the agent-neutral model.
 *
 * An adapter has two halves:
 * - discovery (touches the filesystem): find sessions, list and classify their files, read
 *   live status;
 * - a `SessionParser` (pure, no I/O): turns raw records into model entities. The server
 *   reads the files and feeds the parser, so parsers are unit-testable with plain strings.
 *
 * CONTRACT: every adapter, the server and the web UI depend on this file; change it on its
 * own, with all of them updated together.
 */
import type {
  AgentKind,
  LiveState,
  QuotaSnapshot,
  RemovedIds,
  RequestDetail,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
} from './model.js';

/** A session found on disk. `summary` comes from a lightweight scan, not a full parse. */
export interface SessionSource {
  agent: AgentKind;
  nativeId: string;
  /** Adapter-private locator, e.g. the main transcript path. */
  location: string;
  summary: SessionSummary;
}

export type FileFormat = 'jsonl' | 'json';

export interface SourceFile {
  /** Absolute path. */
  path: string;
  format: FileFormat;
  /** Adapter-defined role, e.g. "main", "subagent", "workflow-journal". */
  role: string;
  agentId: string | null;
  workflowRunId: string | null;
  /**
   * The bytes on disk are not directly `format` text (e.g. zstd-compressed jsonl). The server
   * reads such a file once, whole, through `AgentAdapter.readFile` and never tails it: encoded
   * files are write-once archives.
   */
  encoded?: true;
}

/**
 * Ids of entities touched by one ingest call. A parser may work a change set out lazily, when
 * it is first read: every change set not read yet, whether handed out before or after it, is
 * settled at that moment. The one being read carries their changes, and the others read as
 * empty. `snapshot()` settles unread change sets first, so a client following patches loses
 * nothing to another client's snapshot. Consumers that read and merge every change set in
 * order, or read none (a full load followed by `snapshot`), see the same result either way.
 */
export interface ChangeSet {
  session: boolean;
  agents: string[];
  turns: string[];
  requests: string[];
  toolCalls: string[];
  workflows: string[];
  diagnostics: boolean;
  /**
   * Ids deleted by this ingest. Change sets are merged in order and the later operation on an
   * id wins (see `mergeChanges`); within one change set an id is never both changed and removed.
   */
  removed?: RemovedIds;
}

export interface SessionParser {
  /** Feed complete lines appended to a jsonl file, in file order. Never throws on bad input. */
  ingestLines(file: SourceFile, lines: string[]): ChangeSet;
  /** Feed the full current contents of a json file (re-sent whenever it changes). */
  ingestJson(file: SourceFile, value: unknown): ChangeSet;
  /** Update the owning process's live state (affects in-flight and running statuses). */
  setLive(live: LiveState): ChangeSet;
  snapshot(): SessionSnapshot;
  /** Materialise the entities named in `changes`. */
  patch(changes: ChangeSet): SessionPatch;
  requestDetail(requestId: string): RequestDetail | null;
  /** Full tool result, or undefined when unknown. */
  toolResult(toolCallId: string): unknown;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** All sessions on this machine. Must stay cheap: read file heads/tails, not whole files. */
  discover(): Promise<SessionSource[]>;
  /** Every file that belongs to the session, classified. */
  listFiles(source: SessionSource): Promise<SourceFile[]>;
  /** Directories to watch for files that appear later (new sub-agents, workflow runs). */
  watchDirs(source: SessionSource): string[];
  /**
   * Classify a path seen by a watcher. Null when it does not belong to the session: that answer
   * is final, and the server does not ask about the path again. 'later' when that cannot be
   * told yet (e.g. its header is not fully written): the server does not remember the answer
   * and asks again on the path's next report.
   */
  classify(source: SessionSource, path: string): SourceFile | null | 'later';
  /** Live state of running sessions, keyed by native session id. Missing ⇒ 'closed'. */
  liveStatus(): Promise<Map<string, LiveState>>;
  /**
   * How often a session's cumulative usage moves: after every model call (the default, as
   * Claude Code writes usage with each response), or once per turn, when the agent reports a
   * turn's tokens only as it ends (Grok). The token rate spreads a per-turn report over the
   * turn's minutes instead of counting it in the minute it lands.
   */
  readonly usageReporting?: 'request' | 'turn';
  createParser(source: SessionSource): SessionParser;
  /**
   * The plan's current quota: what the agent caches, and what glassbox fetches with its sign-in
   * (unless `--no-fetch-quota`). Null when there is none. Optional: adapters without quota data
   * omit it.
   */
  quota?(): Promise<QuotaSnapshot | null>;
  /** Files whose changes may change `quota()`, for the server to watch. */
  quotaFiles?(): string[];
  /**
   * Decoded text of a file listed with `encoded: true`, in its `format`. Rejects when it cannot
   * be decoded. Required whenever the adapter lists any encoded file.
   */
  readFile?(file: SourceFile): Promise<string>;
  /**
   * Current contents of a `json` source whose data is not the file at `path`, e.g. one session's
   * rows in the agent's database. When present, the server reads every `json` source of the
   * adapter through it instead of from disk: on a full parse, and whenever a path that
   * `classify` maps to the source changes (several paths, e.g. a database and its journal, may
   * map to one source). `version` changes whenever `value` does; the parser is fed `value` only
   * when `version` differs from the one it was last fed. Resolves undefined when there is
   * nothing to read right now, and the parser keeps what it has; rejects on a failure, which the
   * server logs once until a read succeeds again. Optional: adapters whose sessions are files
   * omit it.
   */
  readJson?(
    source: SessionSource,
    file: SourceFile,
  ): Promise<{ version: string; value: unknown } | undefined>;
}

import type {
  AgentAdapter,
  ChangeSet,
  SessionParser,
  SessionSource,
  SourceFile,
} from '../core/adapter.js';
import { isEmptyChanges, mergeChanges } from '../core/changes.js';
import type { LiveState, SessionPatch, SessionSnapshot, SessionSummary } from '../core/model.js';
import { Coalescer } from './coalescer.js';
import { JsonlTailer, readJsonFile } from './tail/tailer.js';
import { type DirWatcher, watchDirs } from './tail/watch.js';

/** Files are fed to a fresh parser in this order, so referenced entities exist first. */
const ROLE_ORDER = [
  // Claude Code
  'main',
  // Codex: the session's own rollout before its sub-agents'
  'rollout',
  // Grok: session metadata, then the logs (its parser is order-independent; this is the
  // order the files fill in during a live turn)
  'summary',
  'tool-definitions',
  'events',
  'updates',
  'chat-history',
  'usage',
  // Both
  'subagent-meta',
  'subagent',
  // Claude Code workflows
  'workflow-state',
  'workflow-journal',
  'workflow-agent-meta',
  'workflow-agent',
];

/** A file keeps being replaced while we read it: give up after this many full re-parses. */
const MAX_PARSE_ATTEMPTS = 3;

export interface OpenSessionOptions {
  /** Minimum gap between two patches (protocol: ≤ 10/s). */
  patchMs: number;
  pollMs: number;
  /** Upper bound on bytes read (and parsed) before yielding to the event loop. */
  chunkBytes: number;
  live: LiveState;
  onSummary: (summary: SessionSummary) => void;
  onPatch: (patch: SessionPatch) => void;
  onReset: (snapshot: SessionSnapshot) => void;
  log: (msg: string) => void;
}

interface Tracked {
  file: SourceFile;
  tailer: JsonlTailer | null;
  /** Last ingested json document, serialised, to skip re-ingesting unchanged files. */
  lastJson: string | null;
  /** Encoded files only: read once, whole, during a full parse. */
  archive: 'unread' | 'read' | 'failed' | null;
}

/** Lines of a decoded archive fed to the parser between two yields to the event loop. */
const ARCHIVE_CHUNK_LINES = 20_000;

interface LoadStats {
  files: number;
  lines: number;
}

type ReadResult = { reset: true } | { reset: false; changes: ChangeSet[]; lines: number };

/**
 * One parsed session kept up to date from its files.
 *
 * All file reads and parser ingestion run on one promise chain, so a file's lines reach the
 * parser in order and a rebuild never interleaves with incremental reads.
 */
export class OpenSession {
  parser!: SessionParser;
  private files = new Map<string, Tracked>();
  private watcher: DirWatcher | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly dirty = new Set<string>();
  /**
   * Paths `classify` rejected. A rejection is final, so a sibling session's transcript in the
   * same project dir is looked at once, not on every write.
   */
  private readonly foreign = new Set<string>();
  private drainQueued = false;
  private pending: ChangeSet | null = null;
  private readonly flusher: Coalescer;
  private closed = false;
  private live: LiveState;

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly source: SessionSource,
    private readonly opts: OpenSessionOptions,
  ) {
    this.live = opts.live;
    this.flusher = new Coalescer(opts.patchMs, () => this.flush());
  }

  get id(): string {
    return this.source.summary.id;
  }

  /** Full initial parse. Resolves once the parser holds everything currently on disk. */
  load(): Promise<void> {
    // Watch first: anything written after this point is reported, so nothing written between
    // listing the files and finishing the read can be missed.
    this.watcher = watchDirs(this.adapter.watchDirs(this.source), (p) => this.onPath(p), {
      pollMs: this.opts.pollMs,
    });
    return this.enqueue(async () => {
      const started = performance.now();
      const { parser, files, stats } = await this.parseFromScratch();
      this.parser = parser;
      this.files = files;
      this.opts.onSummary(parser.snapshot().session);
      const ms = Math.round(performance.now() - started);
      this.opts.log(`opened ${this.id}: ${stats.files} files, ${stats.lines} lines in ${ms} ms`);
    });
  }

  setLive(live: LiveState): void {
    if (this.closed || live === this.live) return;
    this.live = live;
    if (!this.parser) return;
    try {
      this.queueChanges(this.parser.setLive(live));
    } catch (err) {
      // A parser bug must cost this session's live flag, not the server.
      this.opts.log(`session ${this.id}: setLive failed: ${errorText(err)}`);
    }
  }

  /** Re-ask the adapter which dirs to watch; new workflow run dirs show up this way. */
  refreshWatchDirs(): void {
    if (this.closed || !this.watcher) return;
    this.watcher.setDirs(this.adapter.watchDirs(this.source));
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    this.flusher.cancel();
    this.pending = null;
    this.dirty.clear();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task);
    this.chain = run.catch((err) => this.opts.log(`session ${this.id}: ${errorText(err)}`));
    return run;
  }

  private onPath(path: string): void {
    if (this.closed) return;
    this.dirty.add(path);
    if (this.drainQueued) return;
    this.drainQueued = true;
    void this.enqueue(async () => {
      this.drainQueued = false;
      await this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.dirty.size > 0) {
      const path = this.dirty.values().next().value as string;
      this.dirty.delete(path);
      const tracked = this.track(path);
      if (!tracked) continue;
      const result = await this.read(this.parser, tracked, false);
      if (this.closed) return;
      if (result.reset) {
        await this.rebuild();
        continue;
      }
      if (result.changes.length > 0) this.queueChanges(mergeChanges(...result.changes));
    }
  }

  /** The tracked entry for `path`, classifying paths seen for the first time. */
  private track(path: string): Tracked | null {
    const known = this.files.get(path);
    if (known) return known;
    if (this.foreign.has(path)) return null;
    const file = this.adapter.classify(this.source, path);
    // Undecided (e.g. a header still being written): the next write reports the path again.
    if (file === 'later') return null;
    if (!file) {
      this.foreign.add(path);
      // Possibly a new directory (e.g. a workflow run) that holds files to watch.
      this.refreshWatchDirs();
      return null;
    }
    const tracked = newTracked(file);
    this.files.set(path, tracked);
    return tracked;
  }

  /** A truncated or replaced file: entities parsed from the old contents must go. */
  private async rebuild(): Promise<void> {
    const started = performance.now();
    const { parser, files } = await this.parseFromScratch();
    if (this.closed) return;
    this.parser = parser;
    this.files = files;
    // Changes collected against the old parser are covered by the new snapshot.
    this.pending = null;
    this.flusher.cancel();
    const snapshot = parser.snapshot();
    this.opts.onSummary(snapshot.session);
    this.opts.onReset(snapshot);
    const ms = Math.round(performance.now() - started);
    this.opts.log(`rebuilt ${this.id} after a file was truncated or replaced (${ms} ms)`);
  }

  private async parseFromScratch(): Promise<{
    parser: SessionParser;
    files: Map<string, Tracked>;
    stats: LoadStats;
  }> {
    for (let attempt = 1; ; attempt++) {
      const parser = this.adapter.createParser(this.source);
      const listed = await this.adapter.listFiles(this.source);
      const files = new Map<string, Tracked>();
      for (const file of [...listed].sort(byRoleThenPath)) files.set(file.path, newTracked(file));
      const stats: LoadStats = { files: files.size, lines: 0 };
      let replaced = false;
      for (const tracked of files.values()) {
        const result = await this.read(parser, tracked, true);
        if (this.closed) break;
        // A fresh tailer only resets when the file was replaced while we were reading it.
        if (result.reset) {
          replaced = true;
          break;
        }
        stats.lines += result.lines;
      }
      if (replaced && attempt < MAX_PARSE_ATTEMPTS) continue;
      try {
        parser.setLive(this.live);
      } catch (err) {
        this.opts.log(`session ${this.id}: setLive failed: ${errorText(err)}`);
      }
      return { parser, files, stats };
    }
  }

  /** `fullParse`: reading into a fresh parser (open or rebuild), not following a change. */
  private async read(
    parser: SessionParser,
    tracked: Tracked,
    fullParse: boolean,
  ): Promise<ReadResult> {
    const { file } = tracked;
    if (file.encoded) {
      if (fullParse) return this.readArchive(parser, tracked);
      // Archives are write-once, so a report about one we have read is noise. A new one (or
      // one that failed) may be replacing a live file (Codex compresses finished rollouts in
      // place): start over from listFiles, which knows which copy to read.
      return tracked.archive === 'read' ? { reset: false, changes: [], lines: 0 } : { reset: true };
    }
    if (file.format === 'json') {
      const json = await readJsonFile(file.path);
      // Compared as text: re-serializing the value would throw on a deeply nested file.
      if (json === undefined || json.text === tracked.lastJson)
        return { reset: false, changes: [], lines: 0 };
      tracked.lastJson = json.text;
      return { reset: false, changes: [parser.ingestJson(file, json.value)], lines: 0 };
    }
    const tailer = tracked.tailer as JsonlTailer;
    const changes: ChangeSet[] = [];
    let lines = 0;
    for (;;) {
      const r = await tailer.read(this.opts.chunkBytes);
      // Gone counts as a reset: its contents may live on under another name, e.g. archived.
      if (r.reset || r.gone) return { reset: true };
      if (r.lines.length > 0) {
        changes.push(parser.ingestLines(file, r.lines));
        lines += r.lines.length;
      }
      if (!r.more) break;
      // Let HTTP requests for other sessions through between chunks of a large file.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { reset: false, changes, lines };
  }

  private async readArchive(parser: SessionParser, tracked: Tracked): Promise<ReadResult> {
    const { file } = tracked;
    const skip = (why: string): ReadResult => {
      tracked.archive = 'failed';
      this.opts.log(`session ${this.id}: skipped ${file.path}: ${why}`);
      return { reset: false, changes: [], lines: 0 };
    };
    if (!this.adapter.readFile) return skip('encoded, but the adapter has no readFile');
    let text: string;
    try {
      text = await this.adapter.readFile(file);
    } catch (err) {
      return skip(errorText(err));
    }
    tracked.archive = 'read';
    if (file.format === 'json') {
      try {
        return { reset: false, changes: [parser.ingestJson(file, JSON.parse(text))], lines: 0 };
      } catch (err) {
        return skip(`not JSON: ${errorText(err)}`);
      }
    }
    // Same lines a tailer would produce; the last one counts even without a newline.
    const all = text
      .split('\n')
      .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
      .filter((l) => l.trim() !== '');
    const changes: ChangeSet[] = [];
    for (let i = 0; i < all.length; i += ARCHIVE_CHUNK_LINES) {
      if (i > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      changes.push(parser.ingestLines(file, all.slice(i, i + ARCHIVE_CHUNK_LINES)));
    }
    return { reset: false, changes, lines: all.length };
  }

  private queueChanges(changes: ChangeSet): void {
    if (this.closed || isEmptyChanges(changes)) return;
    this.pending = this.pending ? mergeChanges(this.pending, changes) : changes;
    this.flusher.request();
  }

  private flush(): void {
    const changes = this.pending;
    this.pending = null;
    if (this.closed || !changes) return;
    try {
      const patch = this.parser.patch(changes);
      this.opts.onSummary(patch.session);
      this.opts.onPatch(patch);
    } catch (err) {
      this.opts.log(`session ${this.id}: patch failed: ${errorText(err)}`);
    }
  }
}

function newTracked(file: SourceFile): Tracked {
  return {
    file,
    tailer: file.format === 'jsonl' && !file.encoded ? new JsonlTailer(file.path) : null,
    lastJson: null,
    archive: file.encoded ? 'unread' : null,
  };
}

function byRoleThenPath(a: SourceFile, b: SourceFile): number {
  const rank = (f: SourceFile) => {
    const i = ROLE_ORDER.indexOf(f.role);
    return i === -1 ? ROLE_ORDER.length : i;
  };
  return rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

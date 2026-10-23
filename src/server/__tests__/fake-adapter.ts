/**
 * A toy agent for server tests. Files follow the Claude Code layout (so watch/classify paths
 * look realistic) but records use a tiny format:
 *
 *   {"t":"title","title":"…"}
 *   {"t":"req","id":"r1","at":"<iso>","out":10}          one completed request
 *                                                        ("params": its detail's params)
 *   {"t":"tool","id":"tu1","req":"r1","name":"Bash"}     a running tool call ("input": its input)
 *   {"t":"result","tool":"tu1","result":"ok"}            completes it (any JSON result)
 *   {"t":"started","agentId":"a1","label":"…"}           workflow journal line
 *   {"t":"drop","id":"r1"}                               removes a request (and its tool calls)
 *
 * `<root>/live.json` maps native session ids to live states.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type {
  AgentAdapter,
  ChangeSet,
  SessionParser,
  SessionSource,
  SourceFile,
} from '../../core/adapter.js';
import { emptyChanges, mergeChanges } from '../../core/changes.js';
import type {
  AgentNode,
  AgentNodeKind,
  LiveState,
  ModelRequest,
  RequestDetail,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
  ToolCall,
  WorkflowRun,
} from '../../core/model.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import { emptyUsage, sumUsage } from '../../core/usage.js';

export const FAKE_AGENT = 'fake';

// ── Layout helpers for tests ──────────────────────────────────────────────────────────────

export function fakePaths(root: string, project: string, nativeId: string, kind = FAKE_AGENT) {
  const projectDir = join(root, 'projects', project);
  const sessionDir = join(projectDir, nativeId);
  const wfDir = (run: string) => join(sessionDir, 'subagents', 'workflows', run);
  return {
    id: `${kind}:${nativeId}`,
    projectDir,
    sessionDir,
    main: join(projectDir, `${nativeId}.jsonl`),
    subagent: (agentId: string) => join(sessionDir, 'subagents', `agent-${agentId}.jsonl`),
    subagentMeta: (agentId: string) => join(sessionDir, 'subagents', `agent-${agentId}.meta.json`),
    workflowsDir: join(sessionDir, 'subagents', 'workflows'),
    wfDir,
    journal: (run: string) => join(wfDir(run), 'journal.jsonl'),
    wfAgent: (run: string, agentId: string) => join(wfDir(run), `agent-${agentId}.jsonl`),
    wfAgentMeta: (run: string, agentId: string) => join(wfDir(run), `agent-${agentId}.meta.json`),
    wfState: (run: string) => join(sessionDir, 'workflows', `${run}.json`),
  };
}

export const rec = {
  title: (title: string) => JSON.stringify({ t: 'title', title }),
  req: (id: string, at: string, out = 10, params?: unknown) =>
    JSON.stringify({ t: 'req', id, at, out, params }),
  tool: (id: string, req: string, name = 'Bash', input?: unknown) =>
    JSON.stringify({ t: 'tool', id, req, name, input }),
  result: (tool: string, result: unknown) => JSON.stringify({ t: 'result', tool, result }),
  started: (agentId: string, label: string) => JSON.stringify({ t: 'started', agentId, label }),
  drop: (id: string, opts: { removalOnly?: boolean } = {}) =>
    JSON.stringify({ t: 'drop', id, removalOnly: opts.removalOnly ?? false }),
};

export const lines = (...l: string[]) => `${l.join('\n')}\n`;

/** A fake archive (think `.zst`): unreadable as text, decodable only through `readFile`. */
export const encodeFake = (text: string) => `FAKEZ:${Buffer.from(text).toString('base64')}`;
const ARCHIVE = '.zst';

// ── Adapter ───────────────────────────────────────────────────────────────────────────────

export interface FakeAdapter extends AgentAdapter {
  /** Every parser created, in creation order. */
  readonly parsers: FakeParser[];
  parsersFor(nativeId: string): FakeParser[];
  discoverCalls: number;
  /** Calls to `quota()` (only with `{ quota: true }`). */
  quotaReads: number;
  /** Leave `nativeId` out of the next `calls` discoveries (a transient readdir failure). */
  hideFor(nativeId: string, calls: number): void;
  /** While set, `listFiles` waits for it: holds a session open in flight. */
  listFilesGate: Promise<void> | null;
  /** Paths whose `readFile` rejects, as a corrupt archive would. */
  failReads: Set<string>;
}

export function createFakeAdapter(
  root: string,
  opts: { quota?: boolean; kind?: string; readFile?: boolean } = {},
): FakeAdapter {
  const kind = opts.kind ?? FAKE_AGENT;
  const parsers: FakeParser[] = [];
  const hidden = new Map<string, number>();
  const sessionDirOf = (s: SessionSource) => s.location.replace(/\.jsonl$/, '');

  const adapter: FakeAdapter = {
    kind,
    parsers,
    discoverCalls: 0,
    quotaReads: 0,
    listFilesGate: null,
    failReads: new Set(),
    hideFor: (nativeId, calls) => {
      hidden.set(nativeId, calls);
    },
    parsersFor: (nativeId) => parsers.filter((p) => p.source.nativeId === nativeId),

    async discover() {
      adapter.discoverCalls++;
      const out: SessionSource[] = [];
      const projects = await readdir(join(root, 'projects')).catch(() => [] as string[]);
      for (const project of projects) {
        const dir = join(root, 'projects', project);
        const names = await readdir(dir).catch(() => [] as string[]);
        // A session is `<id>.jsonl`, or only its archive `<id>.jsonl.zst` once it was archived.
        const ids = new Set(
          names
            .map((n) => /^(.+)\.jsonl(\.zst)?$/.exec(n)?.[1])
            .filter((n): n is string => n !== undefined),
        );
        for (const nativeId of ids) {
          const location = join(dir, `${nativeId}.jsonl`);
          const hide = hidden.get(nativeId) ?? 0;
          if (hide > 0) {
            hidden.set(nativeId, hide - 1);
            continue;
          }
          const text = await readFile(location, 'utf8').catch(async () =>
            decodeFake(await readFile(`${location}${ARCHIVE}`, 'utf8')),
          );
          let title: string | null = null;
          let updatedAt: string | null = null;
          for (const line of text.split('\n')) {
            const r = tryParse(line);
            if (r?.t === 'title') title = r.title;
            if (r?.t === 'req' && (updatedAt === null || r.at > updatedAt)) updatedAt = r.at;
          }
          updatedAt ??= (await stat(location)).mtime.toISOString();
          out.push({
            agent: kind,
            nativeId,
            location,
            summary: {
              id: `${kind}:${nativeId}`,
              agent: kind,
              nativeId,
              title,
              cwd: null,
              project,
              startedAt: null,
              updatedAt,
              live: 'unknown',
              version: null,
              model: null,
              usage: null,
              counts: null,
            },
          });
        }
      }
      return out;
    },

    async listFiles(source) {
      if (adapter.listFilesGate) await adapter.listFilesGate;
      const sessionDir = sessionDirOf(source);
      // Like a real archiving agent's adapter: one copy of the transcript, the live file
      // while it exists, its archive after.
      const candidates = [
        existsSync(source.location) ? source.location : `${source.location}${ARCHIVE}`,
      ].filter((p) => existsSync(p));
      const list = async (dir: string) =>
        (await readdir(dir).catch(() => [] as string[])).map((n) => join(dir, n));
      candidates.push(...(await list(join(sessionDir, 'subagents'))));
      for (const wf of await list(join(sessionDir, 'subagents', 'workflows')))
        candidates.push(...(await list(wf)));
      candidates.push(...(await list(join(sessionDir, 'workflows'))));
      const files = candidates
        .map((p) => adapter.classify(source, p))
        .filter((f): f is SourceFile => f !== null && f !== 'later');
      // Deliberately not in ingest order: the store must sort.
      return files.reverse();
    },

    watchDirs(source) {
      const sessionDir = sessionDirOf(source);
      const workflows = join(sessionDir, 'subagents', 'workflows');
      let wfDirs: string[] = [];
      try {
        wfDirs = readdirSync(workflows, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(workflows, e.name));
      } catch {
        // none yet
      }
      return [
        dirname(source.location),
        join(sessionDir, 'subagents'),
        workflows,
        ...wfDirs,
        join(sessionDir, 'workflows'),
      ];
    },

    classify(source, path) {
      if (path === source.location)
        return { path, format: 'jsonl', role: 'main', agentId: null, workflowRunId: null };
      if (path === `${source.location}${ARCHIVE}`)
        return {
          path,
          format: 'jsonl',
          role: 'main',
          agentId: null,
          workflowRunId: null,
          encoded: true,
        };
      const rel = relative(sessionDirOf(source), path).split(sep).join('/');
      let m = /^subagents\/agent-([^/.]+)\.jsonl\.zst$/.exec(rel);
      if (m)
        return {
          path,
          format: 'jsonl',
          role: 'subagent',
          agentId: m[1] ?? null,
          workflowRunId: null,
          encoded: true,
        };
      m = /^subagents\/agent-([^/.]+)\.jsonl$/.exec(rel);
      if (m)
        return {
          path,
          format: 'jsonl',
          role: 'subagent',
          agentId: m[1] ?? null,
          workflowRunId: null,
        };
      m = /^subagents\/agent-([^/.]+)\.meta\.json$/.exec(rel);
      if (m)
        return {
          path,
          format: 'json',
          role: 'subagent-meta',
          agentId: m[1] ?? null,
          workflowRunId: null,
        };
      m = /^subagents\/workflows\/(wf_[^/]+)\/journal\.jsonl$/.exec(rel);
      if (m)
        return {
          path,
          format: 'jsonl',
          role: 'workflow-journal',
          agentId: null,
          workflowRunId: m[1] ?? null,
        };
      m = /^subagents\/workflows\/(wf_[^/]+)\/agent-([^/.]+)\.jsonl$/.exec(rel);
      if (m)
        return {
          path,
          format: 'jsonl',
          role: 'workflow-agent',
          agentId: m[2] ?? null,
          workflowRunId: m[1] ?? null,
        };
      m = /^subagents\/workflows\/(wf_[^/]+)\/agent-([^/.]+)\.meta\.json$/.exec(rel);
      if (m)
        return {
          path,
          format: 'json',
          role: 'workflow-agent-meta',
          agentId: m[2] ?? null,
          workflowRunId: m[1] ?? null,
        };
      m = /^workflows\/(wf_[^/]+)\.json$/.exec(rel);
      if (m)
        return {
          path,
          format: 'json',
          role: 'workflow-state',
          agentId: null,
          workflowRunId: m[1] ?? null,
        };
      return null;
    },

    async liveStatus() {
      const raw = await readFile(join(root, 'live.json'), 'utf8').catch(() => '{}');
      const map = new Map<string, LiveState>();
      for (const [id, state] of Object.entries(tryParse(raw) ?? {}))
        map.set(id, state as LiveState);
      return map;
    },

    createParser(source) {
      const p = new FakeParser(source);
      parsers.push(p);
      return p;
    },
  };
  if (opts.readFile !== false) {
    adapter.readFile = async (file) => {
      if (adapter.failReads.has(file.path)) throw new Error(`corrupt archive ${file.path}`);
      return decodeFake(await readFile(file.path, 'utf8'));
    };
  }
  if (opts.quota) {
    // `<root>/quota.json` holds a QuotaSnapshot as-is; missing or invalid → null.
    const file = join(root, 'quota.json');
    adapter.quotaFiles = () => [file];
    adapter.quota = async () => {
      adapter.quotaReads++;
      const raw = await readFile(file, 'utf8').catch(() => null);
      return raw === null ? null : (tryParse(raw) ?? null);
    };
  }
  return adapter;
}

// ── An agent whose sessions live in a database ────────────────────────────────────────────

export const FAKE_DB_AGENT = 'fakedb';

/**
 * Sessions live in one "database" file, as OpenCode's do, and reach the server only through
 * `readJson`:
 *
 *   <root>/fake.db       {"<nativeId>": {"version": "v1", "records": [<toy record>, …]}}
 *   <root>/fake.db-wal   its journal: a write here stands for a write to the database
 */
export interface FakeDbAdapter extends AgentAdapter {
  readonly parsers: FakeParser[];
  readonly dbPath: string;
  /** Calls to `readJson` so far. */
  reads: number;
  /** While set, `readJson` rejects with it. */
  failWith: Error | null;
}

export function createFakeDbAdapter(root: string): FakeDbAdapter {
  const dbPath = join(root, 'fake.db');
  const load = async (): Promise<Record<string, { version: string; records: Rec[] }>> =>
    tryParse(await readFile(dbPath, 'utf8').catch(() => '{}')) ?? {};
  const sessionFile = (): SourceFile => ({
    path: dbPath,
    format: 'json',
    role: 'db-session',
    agentId: null,
    workflowRunId: null,
  });
  const adapter: FakeDbAdapter = {
    kind: FAKE_DB_AGENT,
    parsers: [],
    dbPath,
    reads: 0,
    failWith: null,
    async discover() {
      return Object.keys(await load()).map((nativeId) => ({
        agent: FAKE_DB_AGENT,
        nativeId,
        location: dbPath,
        summary: {
          id: `${FAKE_DB_AGENT}:${nativeId}`,
          agent: FAKE_DB_AGENT,
          nativeId,
          title: null,
          cwd: null,
          project: 'db',
          startedAt: null,
          updatedAt: new Date(0).toISOString(),
          live: 'unknown',
          version: null,
          model: null,
          usage: null,
          counts: null,
        },
      }));
    },
    listFiles: async () => [sessionFile()],
    watchDirs: () => [root],
    classify: (_source, path) =>
      path === dbPath || path === `${dbPath}-wal` ? sessionFile() : null,
    liveStatus: async () => new Map(),
    createParser(source) {
      const p = new FakeParser(source);
      adapter.parsers.push(p);
      return p;
    },
    async readJson(source) {
      adapter.reads++;
      if (adapter.failWith) throw adapter.failWith;
      const row = (await load())[source.nativeId];
      return row && { version: row.version, value: row.records };
    },
  };
  return adapter;
}

// ── Parser ────────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: toy records are untyped JSON
type Rec = any;

function decodeFake(raw: string): string {
  if (!raw.startsWith('FAKEZ:')) throw new Error('not a fake archive');
  return Buffer.from(raw.slice('FAKEZ:'.length), 'base64').toString('utf8');
}

function tryParse(line: string): Rec | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export class FakeParser implements SessionParser {
  /** Roles in the order files were fed, one entry per ingest call. */
  readonly ingested: string[] = [];
  /** Paths, one entry per ingest call. */
  readonly ingestedPaths: string[] = [];
  live: LiveState = 'unknown';
  private title: string | null;
  private updatedAt: string;
  private parseErrors = 0;
  private readonly agents = new Map<string, Omit<AgentNode, 'usage' | 'counts'>>();
  private readonly requests = new Map<string, ModelRequest>();
  private readonly toolCalls = new Map<string, ToolCall>();
  private readonly workflows = new Map<string, WorkflowRun>();
  private readonly results = new Map<string, unknown>();
  private readonly params = new Map<string, unknown>();

  constructor(readonly source: SessionSource) {
    this.title = source.summary.title;
    this.updatedAt = source.summary.updatedAt;
    this.ensureAgent(MAIN_AGENT_ID, 'main', null);
  }

  ingestLines(file: SourceFile, lines: string[]): ChangeSet {
    this.ingested.push(file.role);
    this.ingestedPaths.push(file.path);
    const changes: ChangeSet[] = [];
    for (const line of lines) {
      const r = tryParse(line);
      if (!r) {
        this.parseErrors++;
        changes.push({ ...emptyChanges(), diagnostics: true });
        continue;
      }
      changes.push(this.ingestRecord(file, r));
    }
    return mergeChanges(...changes);
  }

  ingestJson(file: SourceFile, value: unknown): ChangeSet {
    this.ingested.push(file.role);
    this.ingestedPaths.push(file.path);
    const v = value as Rec;
    const c = emptyChanges();
    if (file.role === 'subagent-meta' || file.role === 'workflow-agent-meta') {
      const kind = file.role === 'subagent-meta' ? 'subagent' : 'workflow-agent';
      const a = this.ensureAgent(file.agentId ?? '', kind, file.workflowRunId, c);
      a.label = String(v.label ?? a.label);
      c.agents.push(a.id);
    } else if (file.role === 'workflow-state' && file.workflowRunId) {
      const w = this.ensureWorkflow(file.workflowRunId, c);
      w.status = 'complete';
      c.workflows.push(w.id);
    } else if (file.role === 'db-session' && Array.isArray(v)) {
      // A whole session, re-sent on every change: toy title and req records are idempotent.
      const main: SourceFile = { ...file, role: 'main' };
      return mergeChanges(c, ...v.map((r) => this.ingestRecord(main, r)));
    }
    return mergeChanges(c);
  }

  setLive(live: LiveState): ChangeSet {
    if (live === this.live) return emptyChanges();
    this.live = live;
    return { ...emptyChanges(), session: true };
  }

  snapshot(): SessionSnapshot {
    return {
      session: this.summary(),
      agents: [...this.agents.keys()].map((id) => this.agentNode(id)),
      turns: [],
      requests: [...this.requests.values()],
      toolCalls: [...this.toolCalls.values()],
      workflows: [...this.workflows.values()],
      diagnostics: this.diagnostics(),
    };
  }

  patch(c: ChangeSet): SessionPatch {
    const pick = <T>(ids: string[], get: (id: string) => T | undefined) =>
      ids.map(get).filter((x): x is T => x !== undefined);
    return {
      session: this.summary(),
      agents: pick(c.agents, (id) => (this.agents.has(id) ? this.agentNode(id) : undefined)),
      turns: [],
      requests: pick(c.requests, (id) => this.requests.get(id)),
      toolCalls: pick(c.toolCalls, (id) => this.toolCalls.get(id)),
      workflows: pick(c.workflows, (id) => this.workflows.get(id)),
      diagnostics: c.diagnostics ? this.diagnostics() : null,
      ...(c.removed ? { removed: c.removed } : {}),
    };
  }

  requestDetail(requestId: string): RequestDetail | null {
    if (!this.requests.has(requestId)) return null;
    return {
      requestId,
      completeness: 'unavailable',
      notes: ['fake adapter'],
      params: this.params.get(requestId) ?? null,
      system: null,
      tools: null,
      messages: null,
    };
  }

  toolResult(toolCallId: string): unknown {
    return this.results.get(toolCallId);
  }

  private ingestRecord(file: SourceFile, r: Rec): ChangeSet {
    const c = emptyChanges();
    const agentId = file.role === 'main' ? MAIN_AGENT_ID : (file.agentId ?? MAIN_AGENT_ID);
    if (file.role !== 'workflow-journal') {
      const kind = file.role === 'workflow-agent' ? 'workflow-agent' : 'subagent';
      this.ensureAgent(agentId, agentId === MAIN_AGENT_ID ? 'main' : kind, file.workflowRunId, c);
    }
    switch (r.t) {
      case 'title':
        this.title = r.title;
        c.session = true;
        break;
      case 'req':
        this.requests.set(r.id, {
          id: r.id,
          agentId,
          turnId: null,
          index: 1,
          model: 'fake-model',
          effort: null,
          startedAt: r.at,
          firstBlockAt: r.at,
          endedAt: r.at,
          status: 'complete',
          stopReason: 'end_turn',
          usage: { ...emptyUsage(), input: 1, output: r.out },
          blocks: [],
          toolCallIds: [],
          hasDetail: false,
          error: null,
        });
        if (r.params !== undefined) this.params.set(r.id, r.params);
        if (r.at > this.updatedAt) this.updatedAt = r.at;
        c.session = true;
        c.requests.push(r.id);
        c.agents.push(agentId);
        break;
      case 'tool': {
        const req = this.requests.get(r.req);
        if (!req) break;
        req.toolCallIds.push(r.id);
        this.toolCalls.set(r.id, {
          id: r.id,
          agentId,
          requestId: r.req,
          name: r.name,
          input: r.input ?? {},
          status: 'running',
          startedAt: req.endedAt,
          endedAt: null,
          durationMs: null,
          resultPreview: null,
          hasFullResult: false,
          spawned: null,
        });
        c.session = true;
        c.requests.push(r.req);
        c.toolCalls.push(r.id);
        break;
      }
      case 'result': {
        const tool = this.toolCalls.get(r.tool);
        if (!tool) break;
        tool.status = 'complete';
        tool.resultPreview = String(r.result).slice(0, 500);
        tool.hasFullResult = true;
        this.results.set(r.tool, r.result);
        c.toolCalls.push(r.tool);
        break;
      }
      case 'drop': {
        const req = this.requests.get(r.id);
        if (!req) break;
        this.requests.delete(r.id);
        for (const t of req.toolCallIds) this.toolCalls.delete(t);
        // removalOnly: a change set that carries nothing but the removal (allowed by the contract).
        if (!r.removalOnly) {
          c.session = true;
          c.agents.push(req.agentId);
        }
        c.removed = {
          requests: [r.id],
          ...(req.toolCallIds.length ? { toolCalls: [...req.toolCallIds] } : {}),
        };
        break;
      }
      case 'started': {
        const a = this.ensureAgent(r.agentId, 'workflow-agent', file.workflowRunId, c);
        a.label = r.label;
        c.agents.push(a.id);
        break;
      }
    }
    return c;
  }

  private ensureAgent(
    id: string,
    kind: AgentNodeKind,
    workflowRunId: string | null,
    c?: ChangeSet,
  ): Omit<AgentNode, 'usage' | 'counts'> {
    let a = this.agents.get(id);
    if (!a) {
      a = {
        id,
        kind,
        parentId: kind === 'main' ? null : MAIN_AGENT_ID,
        spawnedByToolCallId: null,
        agentType: null,
        label: kind === 'main' ? 'Main' : id,
        workflowRunId: kind === 'workflow-agent' ? workflowRunId : null,
        phase: null,
        model: null,
        status: 'running',
        startedAt: null,
        endedAt: null,
      };
      this.agents.set(id, a);
      c?.agents.push(id);
      if (a.workflowRunId) {
        const w = this.ensureWorkflow(a.workflowRunId, c);
        w.agentIds.push(id);
        c?.workflows.push(w.id);
      }
    }
    return a;
  }

  private ensureWorkflow(id: string, c?: ChangeSet): WorkflowRun {
    let w = this.workflows.get(id);
    if (!w) {
      w = {
        id,
        name: null,
        taskId: null,
        toolCallId: null,
        parentAgentId: MAIN_AGENT_ID,
        status: 'running',
        phases: [],
        agentIds: [],
        startedAt: null,
        endedAt: null,
      };
      this.workflows.set(id, w);
      c?.workflows.push(id);
    }
    return w;
  }

  private agentNode(id: string): AgentNode {
    const base = this.agents.get(id) as Omit<AgentNode, 'usage' | 'counts'>;
    const reqs = [...this.requests.values()].filter((r) => r.agentId === id);
    return {
      ...base,
      usage: sumUsage(reqs.map((r) => r.usage)),
      counts: {
        turns: 0,
        requests: reqs.length,
        toolCalls: [...this.toolCalls.values()].filter((t) => t.agentId === id).length,
      },
    };
  }

  private summary(): SessionSummary {
    return {
      ...this.source.summary,
      title: this.title,
      live: this.live,
      updatedAt: this.updatedAt,
      usage: sumUsage([...this.requests.values()].map((r) => r.usage)),
      counts: {
        turns: 0,
        requests: this.requests.size,
        toolCalls: this.toolCalls.size,
        agents: this.agents.size,
      },
    };
  }

  private diagnostics() {
    return { unknownRecordTypes: {}, parseErrors: this.parseErrors, unavailable: [] };
  }
}

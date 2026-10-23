/**
 * Pure oh-my-pi session parser. The server reads the session files and feeds lines here.
 *
 * Entries form a tree through `id` / `parentId`. Only the active branch is shown: the path from
 * the root to the leaf omp would resume at, plus the side calls (`model_usage`) hanging off it.
 * Entries on other branches (an edit-and-resend, a `/tree` jump) are left out, and diagnostics
 * list `other-branches` when there are any. A tree that is damaged (a parent that is missing, a
 * loop, a repeated id) is `broken-tree` instead: what it hides is not a branch anyone chose.
 *
 * Each assistant message is one `ModelRequest` with its own usage; each `model_usage` entry is
 * one more, with no blocks. A turn starts at every user message, and at injected input (a
 * background result, a skill prompt) that arrives while the agent is idle. omp writes a message
 * when it ends, never while it streams, so a request in flight is not visible (`in-flight`).
 *
 * Sub-agents (`task`) are sessions of their own in `<session>/<AgentId>.jsonl`, nested by
 * spawner. Their files arrive with role `subagent` and become sub-agents of the `task` call that
 * names them. Their ids are scoped by agent: entry ids are only unique within one file.
 *
 * A new entry can move the leaf and replace the branch, so the views are rebuilt from the
 * entries and change sets are the difference with what clients were last given.
 */
import { basename } from 'node:path';
import { activityField, latestTurn } from '../../core/activity.js';
import type { ChangeSet, SessionParser, SessionSource, SourceFile } from '../../core/adapter.js';
import { emptyChanges } from '../../core/changes.js';
import type {
  AgentNode,
  Diagnostics,
  LiveState,
  ModelRequest,
  RequestDetail,
  RequestStatus,
  ResponseBlock,
  RunStatus,
  SessionPatch,
  SessionSnapshot,
  SessionSummary,
  ToolCall,
  ToolStatus,
  Turn,
  TurnOrigin,
} from '../../core/model.js';
import { MAIN_AGENT_ID } from '../../core/model.js';
import { sumUsage } from '../../core/usage.js';
import {
  type AssistantBody,
  type EntryBody,
  type EntryNode,
  type InjectedBody,
  jsonOf,
  type ModelUsageBody,
  parseOmpLine,
  type SessionInitBody,
  type SpawnedAgent,
  type ToolResultBody,
  type UserBody,
} from './records.js';

const PREVIEW_CHARS = 500;

export interface OmpParserOptions {
  /** False where omp's session lease cannot be seen: live state is then always 'closed'. */
  liveSignal?: boolean;
  /**
   * Text of `artifact://<id>`, the whole output omp saved for a result it cut short; null when
   * it cannot be read. `agent` is the sub-agent's path below the session dir (`Scout/Helper`),
   * null for the session's own calls. Called by `toolResult()` only, on demand, never while
   * ingesting.
   */
  readArtifact?: (id: string, agent: string | null) => string | null;
}

interface Entry {
  node: EntryNode;
  body: EntryBody;
}

/** One session file: the main session's, or a sub-agent's. */
interface AgentFile {
  id: string;
  /** The file's path below the session dir, without `.jsonl`; null for the session's own. */
  key: string | null;
  entries: Map<string, Entry>;
  /** File order; a repeated id leaves its earlier copy here, unused. */
  order: Entry[];
  startedAt: string | null;
}

interface TurnBuild {
  id: string;
  origin: TurnOrigin;
  prompt: string;
  startedAt: string | null;
  requests: RequestBuild[];
  /** The last assistant message: whether it asked for tools decides if the turn goes on. */
  lastAnswer: RequestBuild | null;
}

interface RequestBuild {
  id: string;
  turn: TurnBuild | null;
  index: number;
  model: string | null;
  provider: string | null;
  api: string | null;
  effort: string | null;
  /** What a side call (`model_usage`) was for; null on an assistant message. */
  purpose: string | null;
  startedAt: string | null;
  firstBlockAt: string | null;
  endedAt: string | null;
  stopReason: string | null;
  usage: AssistantBody['usage'];
  blocks: ResponseBlock[];
  tools: ToolBuild[];
  error: AssistantBody['error'];
  compactedBefore: boolean;
}

interface ToolBuild {
  id: string;
  request: RequestBuild;
  name: string;
  input: unknown;
  startedAt: string | null;
  result: ToolResultBody | null;
  spawned: string[];
}

/** What walking one agent's active branch produced. */
interface AgentWalk {
  id: string;
  file: AgentFile;
  turns: TurnBuild[];
  requests: RequestBuild[];
  tools: ToolBuild[];
  /** The latest `model_change`, as `provider/modelId`. */
  model: string | null;
  init: SessionInitBody | null;
  /** Messages off the branch, or the tree damaged (see `activeBranch`). */
  hidden: boolean;
  broken: boolean;
  parentId: string;
  spawnedBy: ToolBuild | null;
  outcome: SpawnedAgent['outcome'];
}

interface Built {
  snap: SessionSnapshot;
  results: Map<string, { result: ToolResultBody; agent: string | null }>;
  details: Map<string, RequestDetail>;
}

const VIEW_KINDS = ['agents', 'turns', 'requests', 'toolCalls'] as const;
type ViewKind = (typeof VIEW_KINDS)[number];

/** Entity ids of a sub-agent carry its id: entry ids are unique within one file only. */
function scoped(agentId: string, id: string): string {
  return agentId === MAIN_AGENT_ID ? id : `${agentId}/${id}`;
}

function preview(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return trimmed.length > PREVIEW_CHARS ? trimmed.slice(0, PREVIEW_CHARS) : trimmed;
}

function plus(iso: string | null, ms: number | null): string | null {
  if (iso === null || ms === null) return null;
  return new Date(Date.parse(iso) + Math.round(ms)).toISOString();
}

function latest(values: (string | null)[]): string | null {
  let out: string | null = null;
  for (const v of values) if (v && (out === null || v > out)) out = v;
  return out;
}

function qualified(provider: string | null, model: string | null): string | null {
  if (!model) return null;
  return provider ? `${provider}/${model}` : model;
}

/**
 * The leaf omp resumes at: the last entry, unless it was written off the branch and names the
 * leaf that stayed active. A named leaf that is gone falls back to the newest entry that is its
 * own leaf (as omp's `resolveSessionLeafId` does). Null: no entries, or a cleared leaf.
 */
function leafOf(order: Entry[], byId: Map<string, Entry>): string | null {
  const last = order.at(-1);
  if (!last) return null;
  const leaf = last.node.activeLeafId !== undefined ? last.node.activeLeafId : last.node.id;
  if (leaf === null || leaf === last.node.id || byId.has(leaf)) return leaf;
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = order[i] as Entry;
    if (entry.node.activeLeafId === undefined || entry.node.activeLeafId === entry.node.id)
      return entry.node.id;
  }
  return null;
}

/**
 * The active branch in file order; whether any message is left out; and whether the tree is
 * damaged: the walk to the root met a parent that is not in the file, or went round a loop, or
 * an id was written twice (omp never reuses one).
 */
function activeBranch(file: AgentFile): { entries: Entry[]; hidden: boolean; broken: boolean } {
  const order = file.order.filter((e) => file.entries.get(e.node.id) === e);
  let broken = order.length < file.order.length;
  const path = new Set<string>();
  let id = leafOf(order, file.entries);
  while (id !== null) {
    const entry = file.entries.get(id);
    if (!entry || path.has(id)) {
      broken = true;
      break;
    }
    path.add(id);
    id = entry.node.parentId;
  }
  // A side call hangs off the entry that was the leaf when it started.
  const shown = (e: Entry) =>
    path.has(e.node.id) ||
    (e.body.kind === 'model-usage' && e.node.parentId !== null && path.has(e.node.parentId));
  const entries = order.filter(shown);
  const hidden = order.some(
    (e) => !shown(e) && (e.body.kind === 'user' || e.body.kind === 'assistant'),
  );
  return { entries, hidden, broken };
}

function userOrigin(agentId: string, body: UserBody): TurnOrigin {
  const byPerson = body.attribution !== 'agent' && !body.synthetic;
  if (agentId === MAIN_AGENT_ID) return byPerson ? 'human' : 'other';
  return body.attribution === 'user' && !body.synthetic ? 'human' : 'agent-prompt';
}

function injectedOrigin(body: InjectedBody): TurnOrigin {
  if (body.customType === 'async-result') return 'task-notification';
  return body.attribution === 'user' ? 'human' : 'other';
}

/** A turn goes on while its last answer asked for tools (or it has none yet). */
function turnOpen(turn: TurnBuild | null): boolean {
  return turn !== null && (turn.lastAnswer === null || turn.lastAnswer.stopReason === 'toolUse');
}

/** Names a `task` call gives the agents it spawns (`name`, `tasks[].name`). */
function taskNames(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const args = input as Record<string, unknown>;
  const names: string[] = [];
  if (typeof args.name === 'string') names.push(args.name);
  if (Array.isArray(args.tasks))
    for (const item of args.tasks)
      if (typeof item === 'object' && item !== null) {
        const name = (item as Record<string, unknown>).name;
        if (typeof name === 'string') names.push(name);
      }
  return names;
}

export class OmpSessionParser implements SessionParser {
  private live: LiveState;
  private title: string | null;
  /** When the current title was set; a slot rewritten in place is newer than its audit entries. */
  private titleAt: string | null = null;
  private cwd: string | null;
  private project: string;
  private version: string | null;
  private startedAt: string | null;
  private updatedAt: string;
  private readonly liveSignal: boolean;
  private readonly readArtifact: OmpParserOptions['readArtifact'] | null;
  private readonly files = new Map<string, AgentFile>();
  private readonly diag = { unknownRecordTypes: {} as Record<string, number>, parseErrors: 0 };
  /** What clients were last given, as JSON per entity. */
  private emittedViews: Record<ViewKind, Map<string, string>> = {
    agents: new Map(),
    turns: new Map(),
    requests: new Map(),
    toolCalls: new Map(),
  };
  private emittedSession = '';
  private emittedDiagnostics = '';
  /** Views of the current state; null once the state has moved on. */
  private cache: Built | null = null;
  /** The state moved since the last diff or snapshot (a new parser has never been given out). */
  private dirty = true;
  /** Change sets handed out and not read yet. */
  private unread: { result: ChangeSet | null }[] = [];

  constructor(
    private readonly source: SessionSource,
    options: OmpParserOptions = {},
  ) {
    this.live = source.summary.live;
    this.title = source.summary.title;
    this.cwd = source.summary.cwd;
    this.project = source.summary.project;
    this.version = source.summary.version;
    this.startedAt = source.summary.startedAt;
    this.updatedAt = source.summary.updatedAt;
    this.liveSignal = options.liveSignal ?? true;
    this.readArtifact = options.readArtifact ?? null;
    this.fileFor(MAIN_AGENT_ID, null);
  }

  ingestLines(file: SourceFile, lines: string[]): ChangeSet {
    const agent = this.agentOf(file);
    if (agent === null) return emptyChanges();
    const agentId = agent.id;
    const state = this.fileFor(agentId, agent.key);
    for (const line of lines) {
      const rec = parseOmpLine(line);
      if (rec.kind === 'invalid') {
        if (line.trim() !== '') this.diag.parseErrors += 1;
        continue;
      }
      if (rec.kind === 'unknown') {
        this.noteUnknown(rec.type);
        continue;
      }
      if (rec.kind === 'title-slot') {
        if (agentId === MAIN_AGENT_ID) this.setTitle(rec.title, rec.updatedAt);
        continue;
      }
      if (rec.kind === 'header') {
        state.startedAt = rec.startedAt ?? state.startedAt;
        if (agentId === MAIN_AGENT_ID) this.onHeader(rec.cwd, rec.startedAt, rec.title);
        continue;
      }
      const { node, body } = rec;
      if (body.kind === 'unknown') this.noteUnknown(body.type);
      const entry: Entry = { node, body };
      state.entries.set(node.id, entry);
      state.order.push(entry);
      this.touch(node.timestamp);
      if (agentId !== MAIN_AGENT_ID) continue;
      if (node.version) this.version = node.version;
      if (body.kind === 'title-change') this.setTitle(body.title, node.timestamp);
    }
    return this.changed();
  }

  ingestJson(): ChangeSet {
    return emptyChanges();
  }

  setLive(live: LiveState): ChangeSet {
    if (live === this.live) return emptyChanges();
    this.live = live;
    return this.changed();
  }

  snapshot(): SessionSnapshot {
    // Unread change sets must still name what changed before now, for clients following
    // patches rather than this snapshot.
    if (this.unread.length > 0) this.settle(null);
    const snap = this.built().snap;
    // A client that receives this snapshot is in step with it.
    if (this.dirty) this.remember(snap);
    this.dirty = false;
    return snap;
  }

  patch(changes: ChangeSet): SessionPatch {
    // Reading the change set first settles it against the views `built()` returns.
    const removedRequests = new Set(changes.removed?.requests ?? []);
    const snap = this.built().snap;
    const pick = <T extends { id: string }>(
      ids: string[],
      items: T[],
      hidden?: Set<string>,
    ): T[] => {
      const want = new Set(ids);
      return items.filter((item) => want.has(item.id) && !hidden?.has(item.id));
    };
    return {
      session: snap.session,
      agents: pick(changes.agents, snap.agents),
      turns: pick(changes.turns, snap.turns),
      requests: pick(changes.requests, snap.requests, removedRequests),
      toolCalls: pick(changes.toolCalls, snap.toolCalls),
      workflows: [],
      diagnostics: changes.diagnostics ? snap.diagnostics : null,
      ...(changes.removed ? { removed: changes.removed } : {}),
    };
  }

  requestDetail(requestId: string): RequestDetail | null {
    return this.built().details.get(requestId) ?? null;
  }

  /** The result as omp recorded it, or the whole output from its artifact when it was cut. */
  toolResult(toolCallId: string): unknown {
    const found = this.built().results.get(toolCallId);
    if (!found) return undefined;
    const { result, agent } = found;
    if (result.artifactId && this.readArtifact) {
      const full = this.readArtifact(result.artifactId, agent);
      if (full !== null) return full;
    }
    return result.text;
  }

  // --- ingestion -----------------------------------------------------------------------

  /** The agent a file belongs to and its path key; null for a role this parser does not read. */
  private agentOf(file: SourceFile): { id: string; key: string | null } | null {
    if (file.role === 'main') return { id: MAIN_AGENT_ID, key: null };
    if (file.role !== 'subagent') return null;
    const key = file.agentId ?? basename(file.path, '.jsonl');
    // A sub-agent may be called anything, `main` included.
    return { id: key === MAIN_AGENT_ID ? `agent:${key}` : key, key };
  }

  private fileFor(agentId: string, key: string | null): AgentFile {
    const existing = this.files.get(agentId);
    if (existing) return existing;
    const file: AgentFile = { id: agentId, key, entries: new Map(), order: [], startedAt: null };
    this.files.set(agentId, file);
    return file;
  }

  private onHeader(cwd: string | null, startedAt: string | null, title: string | null): void {
    if (cwd) {
      this.cwd = cwd;
      this.project = basename(cwd) || cwd;
    }
    if (startedAt) this.startedAt = startedAt;
    // Old sessions carry their title in the header; anything dated wins over it.
    if (title && !this.title) this.title = title;
  }

  private setTitle(title: string | null, at: string | null): void {
    if (!title) return;
    if (this.titleAt !== null && (at === null || at < this.titleAt)) return;
    this.title = title;
    this.titleAt = at;
  }

  private touch(value: string | null): void {
    if (value && value > this.updatedAt) this.updatedAt = value;
  }

  private noteUnknown(type: string): void {
    this.diag.unknownRecordTypes[type] = (this.diag.unknownRecordTypes[type] ?? 0) + 1;
  }

  // --- change sets ---------------------------------------------------------------------

  /**
   * The change set for a state change, worked out when it is first read, so a full load whose
   * change sets nobody reads costs no diff per batch. One diff covers every change set still
   * unread: the one being read carries it and the rest are empty.
   */
  private changed(): ChangeSet {
    this.dirty = true;
    this.cache = null;
    const slot: { result: ChangeSet | null } = { result: null };
    this.unread.push(slot);
    return lazyChanges(() => {
      if (!slot.result) this.settle(slot);
      return slot.result as ChangeSet;
    });
  }

  /** One diff for every unread change set; `reader` (or else the oldest) carries it. */
  private settle(reader: { result: ChangeSet | null } | null): void {
    const changes = this.dirty ? this.diff() : emptyChanges();
    const owner = reader ?? this.unread[0];
    for (const slot of this.unread) slot.result = slot === owner ? changes : emptyChanges();
    this.unread = [];
  }

  /** The current views compared with what clients were last given. */
  private diff(): ChangeSet {
    const snap = this.built().snap;
    const out = emptyChanges();
    const removed: Partial<Record<ViewKind, string[]>> = {};
    for (const kind of VIEW_KINDS) {
      const before = this.emittedViews[kind];
      const now = new Set<string>();
      for (const entity of snap[kind]) {
        now.add(entity.id);
        if (before.get(entity.id) !== jsonOf(entity)) out[kind].push(entity.id);
      }
      const gone = [...before.keys()].filter((id) => !now.has(id));
      if (gone.length > 0) removed[kind] = gone;
    }
    out.session = jsonOf(snap.session) !== this.emittedSession;
    out.diagnostics = jsonOf(snap.diagnostics) !== this.emittedDiagnostics;
    if (Object.keys(removed).length > 0) out.removed = removed;
    this.remember(snap);
    this.dirty = false;
    return out;
  }

  private remember(snap: SessionSnapshot): void {
    for (const kind of VIEW_KINDS)
      this.emittedViews[kind] = new Map(snap[kind].map((e) => [e.id, jsonOf(e)]));
    this.emittedSession = jsonOf(snap.session);
    this.emittedDiagnostics = jsonOf(snap.diagnostics);
  }

  // --- views ---------------------------------------------------------------------------

  private built(): Built {
    this.cache ??= this.build();
    return this.cache;
  }

  private build(): Built {
    const walks = [...this.files.values()]
      .sort((a, b) => {
        if (a.id === MAIN_AGENT_ID) return -1;
        if (b.id === MAIN_AGENT_ID) return 1;
        // By path, so a sub-agent comes right before its own sub-agents.
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map((file) => this.walk(file));
    this.link(walks);

    const results: Built['results'] = new Map();
    const details = new Map<string, RequestDetail>();
    const turns: Turn[] = [];
    const requests: ModelRequest[] = [];
    const toolCalls: ToolCall[] = [];
    const agents: AgentNode[] = [];
    for (const walk of walks) {
      const turnViews = this.turnViews(walk);
      const requestViews = this.requestViews(walk, details);
      const toolViews = this.toolViews(walk, results);
      turns.push(...turnViews);
      requests.push(...requestViews);
      toolCalls.push(...toolViews);
      agents.push(this.agentView(walk, turnViews, requestViews, toolViews));
    }
    const main = walks[0] as AgentWalk;
    const model =
      main.requests.findLast((r) => r.purpose === null && r.model)?.model ??
      main.model ??
      this.source.summary.model;
    const session: SessionSummary = {
      id: `oh-my-pi:${this.source.nativeId}`,
      agent: 'oh-my-pi',
      nativeId: this.source.nativeId,
      title: this.title,
      cwd: this.cwd,
      project: this.project,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      live: this.live,
      version: this.version,
      model,
      ...activityField({
        live: this.live,
        toolCalls,
        requests,
        lastTurn: latestTurn(turns),
        updatedAt: this.updatedAt,
      }),
      usage: sumUsage(requests.map((r) => r.usage)),
      counts: {
        turns: turns.length,
        requests: requests.length,
        toolCalls: toolCalls.length,
        agents: agents.length,
      },
    };
    const unavailable = ['request-detail', 'in-flight'];
    if (!this.liveSignal) unavailable.push('live-state');
    if (walks.some((w) => w.hidden && !w.broken)) unavailable.push('other-branches');
    if (walks.some((w) => w.broken)) unavailable.push('broken-tree');
    const diagnostics: Diagnostics = {
      unknownRecordTypes: { ...this.diag.unknownRecordTypes },
      parseErrors: this.diag.parseErrors,
      unavailable,
    };
    return {
      snap: { session, agents, turns, requests, toolCalls, workflows: [], diagnostics },
      results,
      details,
    };
  }

  /** Turns, requests and tool calls on one agent's active branch, in order. */
  private walk(file: AgentFile): AgentWalk {
    const { entries, hidden, broken } = activeBranch(file);
    const walk: AgentWalk = {
      id: file.id,
      file,
      turns: [],
      requests: [],
      tools: [],
      model: null,
      init: null,
      hidden,
      broken,
      parentId: MAIN_AGENT_ID,
      spawnedBy: null,
      outcome: null,
    };
    let turn: TurnBuild | null = null;
    let pending: { id: string; body: InjectedBody } | null = null;
    let effort: string | null = null;
    let compacted = false;
    const byCallId = new Map<string, ToolBuild>();
    const starts = new Map<string, string | null>();
    const usedToolIds = new Set<string>();
    const open = (id: string, origin: TurnOrigin, prompt: string, at: string | null) => {
      const next: TurnBuild = {
        id: scoped(file.id, id),
        origin,
        prompt,
        startedAt: at,
        requests: [],
        lastAnswer: null,
      };
      walk.turns.push(next);
      return next;
    };

    for (const { node, body } of entries) {
      switch (body.kind) {
        case 'model-change':
          walk.model = body.model ?? walk.model;
          break;
        case 'thinking-change':
          effort = body.level;
          break;
        case 'compaction':
          compacted = true;
          break;
        case 'session-init':
          walk.init = body;
          break;
        case 'user':
          turn = open(node.id, userOrigin(file.id, body), body.text, body.at);
          pending = null;
          break;
        case 'injected':
          // Mid-turn it is context for the next call; while idle it starts a turn if a call follows.
          if (!turnOpen(turn)) pending = { id: node.id, body };
          break;
        case 'assistant': {
          if (turn === null || (pending && !turnOpen(turn))) {
            if (pending)
              turn = open(
                pending.id,
                injectedOrigin(pending.body),
                pending.body.text,
                pending.body.at,
              );
            else if (file.id === MAIN_AGENT_ID) turn = open(node.id, 'other', '', body.startedAt);
            else turn = open(node.id, 'agent-prompt', walk.init?.task ?? '', body.startedAt);
            pending = null;
          }
          const req = this.answer(file.id, node, body, turn, effort, compacted);
          compacted = false;
          turn.lastAnswer = req;
          walk.requests.push(req);
          const at = req.firstBlockAt ?? req.endedAt ?? req.startedAt ?? this.updatedAt;
          for (const block of body.blocks) {
            if (block.kind === 'thinking') {
              req.blocks.push({ kind: 'thinking', text: block.text, durationMs: null, at });
              continue;
            }
            if (block.kind === 'text') {
              req.blocks.push({ kind: 'text', text: block.text, at });
              continue;
            }
            let id = scoped(file.id, block.id);
            // Weak providers repeat call ids; the later call takes the later result.
            for (let n = 2; usedToolIds.has(id); n++) id = `${scoped(file.id, block.id)}#${n}`;
            usedToolIds.add(id);
            const tool: ToolBuild = {
              id,
              request: req,
              name: block.name,
              input: block.input,
              startedAt: starts.get(block.id) ?? null,
              result: null,
              spawned: [],
            };
            byCallId.set(block.id, tool);
            req.tools.push(tool);
            req.blocks.push({ kind: 'tool-use', toolCallId: id, at });
            walk.tools.push(tool);
          }
          break;
        }
        case 'model-usage':
          walk.requests.push(this.sideCall(file.id, node, body, turn));
          break;
        case 'tool-start': {
          starts.set(body.toolCallId, body.at);
          const tool = byCallId.get(body.toolCallId);
          if (tool && !tool.result) tool.startedAt = body.at;
          break;
        }
        case 'tool-result': {
          const tool = byCallId.get(body.toolCallId);
          if (tool) tool.result = body;
          break;
        }
        default:
          break;
      }
    }
    // Requests outside any turn are numbered among themselves.
    let loose = 0;
    for (const req of walk.requests) if (req.turn === null) req.index = ++loose;
    return walk;
  }

  private answer(
    agentId: string,
    node: EntryNode,
    body: AssistantBody,
    turn: TurnBuild,
    effort: string | null,
    compactedBefore: boolean,
  ): RequestBuild {
    const req: RequestBuild = {
      id: scoped(agentId, node.id),
      turn,
      index: turn.requests.length + 1,
      model: qualified(body.provider, body.model),
      provider: body.provider,
      api: body.api,
      effort,
      purpose: null,
      startedAt: body.startedAt,
      firstBlockAt: plus(body.startedAt, body.ttftMs),
      endedAt: body.endedAt ?? node.timestamp,
      stopReason: body.stopReason,
      usage: body.usage,
      blocks: [],
      tools: [],
      error: body.error,
      compactedBefore,
    };
    turn.requests.push(req);
    return req;
  }

  /** A `model_usage` entry: a call outside the transcript, with usage and nothing else. */
  private sideCall(
    agentId: string,
    node: EntryNode,
    body: ModelUsageBody,
    turn: TurnBuild | null,
  ): RequestBuild {
    const req: RequestBuild = {
      id: scoped(agentId, node.id),
      turn,
      index: turn ? turn.requests.length + 1 : 0,
      model: qualified(body.provider, body.model),
      provider: body.provider,
      api: body.api,
      effort: null,
      purpose: body.purpose ?? 'side call',
      startedAt: null,
      firstBlockAt: null,
      endedAt: node.timestamp,
      stopReason: body.stopReason,
      usage: body.usage,
      blocks: [],
      tools: [],
      error: body.errorMessage
        ? { message: body.errorMessage, status: null, retryAttempt: null }
        : null,
      compactedBefore: false,
    };
    turn?.requests.push(req);
    return req;
  }

  /**
   * Ties each sub-agent to its parent and to the `task` call that spawned it: the call names it
   * (`name`, or the ids in its result). A call that names no one yet (a running sync `task` with
   * generated names) takes the sub-agents that started after it.
   */
  private link(walks: AgentWalk[]): void {
    const byId = new Map(walks.map((w) => [w.id, w]));
    for (const walk of walks) {
      if (walk.id === MAIN_AGENT_ID) continue;
      const path = walk.id === `agent:${MAIN_AGENT_ID}` ? [MAIN_AGENT_ID] : walk.id.split('/');
      const name = path.at(-1) ?? walk.id;
      let parent: AgentWalk | undefined;
      for (let n = path.length - 1; n > 0 && !parent; n--)
        parent = byId.get(path.slice(0, n).join('/'));
      parent ??= byId.get(MAIN_AGENT_ID) as AgentWalk;
      walk.parentId = parent.id;
      const tasks = parent.tools.filter((t) => t.name === 'task');
      let spawner: ToolBuild | undefined;
      for (const task of tasks) {
        const named = task.result?.spawned.find((s) => s.id === name);
        if (!named && !taskNames(task.input).includes(name)) continue;
        spawner = task;
        walk.outcome = named?.outcome ?? null;
        break;
      }
      const started = walk.file.startedAt;
      if (!spawner && started)
        spawner = tasks.findLast((t) => t.result === null && (t.startedAt ?? '') <= started);
      if (!spawner) continue;
      walk.spawnedBy = spawner;
      spawner.spawned.push(walk.id);
    }
  }

  private busy(): boolean {
    return this.live === 'busy' || this.live === 'waiting';
  }

  private turnStatus(walk: AgentWalk, turn: TurnBuild): RunStatus {
    const last = turn.lastAnswer;
    const going = walk.turns.at(-1) === turn && this.busy();
    if (!last || last.stopReason === 'toolUse') return going ? 'running' : 'interrupted';
    if (last.stopReason === 'error') return 'error';
    if (last.stopReason === 'aborted') return 'interrupted';
    return 'complete';
  }

  private turnViews(walk: AgentWalk): Turn[] {
    return walk.turns.map((turn, i) => {
      const status = this.turnStatus(walk, turn);
      const ends = turn.requests.flatMap((r) => [
        r.endedAt,
        ...r.tools.map((t) => t.result?.at ?? null),
      ]);
      return {
        id: turn.id,
        agentId: walk.id,
        index: i + 1,
        origin: turn.origin,
        prompt: turn.prompt.trim(),
        startedAt:
          turn.startedAt ?? turn.requests[0]?.startedAt ?? this.startedAt ?? this.updatedAt,
        endedAt: status === 'running' ? null : (latest(ends) ?? turn.startedAt),
        status,
        requestIds: turn.requests.map((r) => r.id),
      };
    });
  }

  private requestViews(walk: AgentWalk, details: Map<string, RequestDetail>): ModelRequest[] {
    const system = walk.init?.systemPrompt ?? null;
    return walk.requests.map((req) => {
      details.set(req.id, this.detailOf(req, walk.init));
      return {
        id: req.id,
        agentId: walk.id,
        turnId: req.turn?.id ?? null,
        index: req.index,
        model: req.model,
        effort: req.effort,
        startedAt: req.startedAt,
        firstBlockAt: req.firstBlockAt,
        endedAt: req.endedAt,
        status: this.requestStatus(req),
        stopReason: req.stopReason,
        usage: req.usage,
        blocks: req.blocks,
        toolCallIds: req.tools.map((t) => t.id),
        hasDetail: system !== null && req.purpose === null,
        error: req.error,
        ...(req.compactedBefore ? { compactedBefore: true } : {}),
      };
    });
  }

  private requestStatus(req: RequestBuild): RequestStatus {
    if (req.stopReason === 'error') return 'error';
    if (req.stopReason === 'aborted') return 'interrupted';
    return 'complete';
  }

  private detailOf(req: RequestBuild, init: SessionInitBody | null): RequestDetail {
    const params = {
      provider: req.provider,
      api: req.api,
      model: req.model,
      thinkingLevel: req.effort,
      ...(req.purpose ? { purpose: req.purpose } : {}),
    };
    if (init?.systemPrompt && req.purpose === null) {
      return {
        requestId: req.id,
        completeness: 'partial',
        notes: [
          'oh-my-pi records a sub-agent’s system prompt and tool names when it starts, not the messages of each call.',
        ],
        params,
        system: init.systemPrompt,
        tools: init.tools,
        messages: null,
      };
    }
    return {
      requestId: req.id,
      completeness: 'unavailable',
      notes: [
        'oh-my-pi does not store the request body; it keeps only a digest of the system prompt.',
      ],
      params,
      system: null,
      tools: null,
      messages: null,
    };
  }

  private toolViews(walk: AgentWalk, results: Built['results']): ToolCall[] {
    const lastAnswer = walk.requests.findLast((r) => r.purpose === null);
    return walk.tools.map((tool) => {
      const result = tool.result;
      if (result) results.set(tool.id, { result, agent: walk.file.key });
      const startedAt = tool.startedAt ?? tool.request.endedAt;
      const endedAt = result?.at ?? null;
      let status: ToolStatus = 'unknown';
      if (result) status = result.isError ? 'error' : 'complete';
      else if (this.busy() && tool.request === lastAnswer) status = 'running';
      const spawned = tool.spawned[0];
      return {
        id: tool.id,
        agentId: walk.id,
        requestId: tool.request.id,
        name: tool.name,
        input: tool.input,
        status,
        startedAt,
        endedAt,
        durationMs:
          startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null,
        resultPreview: result ? preview(result.text) : null,
        hasFullResult: result !== null,
        spawned: spawned ? { kind: 'agent', agentId: spawned } : null,
      };
    });
  }

  private agentView(
    walk: AgentWalk,
    turns: Turn[],
    requests: ModelRequest[],
    tools: ToolCall[],
  ): AgentNode {
    const main = walk.id === MAIN_AGENT_ID;
    const running =
      turns.some((t) => t.status === 'running') ||
      (!main && turns.length === 0 && this.busy() && walk.init !== null);
    let status: RunStatus;
    if (running) status = 'running';
    else if (walk.outcome) status = walk.outcome;
    else status = turns.at(-1)?.status ?? 'unknown';
    const model = walk.requests.findLast((r) => r.purpose === null && r.model)?.model ?? walk.model;
    return {
      id: walk.id,
      kind: main ? 'main' : 'subagent',
      parentId: main ? null : walk.parentId,
      spawnedByToolCallId: walk.spawnedBy?.id ?? null,
      agentType: main ? null : (walk.init?.agent ?? null),
      label: main ? 'Main' : (walk.id.split('/').at(-1) ?? walk.id),
      workflowRunId: null,
      phase: null,
      model,
      status,
      startedAt: main ? this.startedAt : (walk.file.startedAt ?? turns[0]?.startedAt ?? null),
      endedAt: running ? null : (turns.at(-1)?.endedAt ?? null),
      usage: sumUsage(requests.map((r) => r.usage)),
      counts: { turns: turns.length, requests: requests.length, toolCalls: tools.length },
    };
  }
}

const CHANGE_KEYS = [
  'session',
  'agents',
  'turns',
  'requests',
  'toolCalls',
  'workflows',
  'diagnostics',
  'removed',
] as const;

/** A change set whose fields come from `read`, called when one is first used. */
function lazyChanges(read: () => ChangeSet): ChangeSet {
  const out = {} as ChangeSet;
  for (const key of CHANGE_KEYS)
    Object.defineProperty(out, key, { enumerable: true, get: () => read()[key] });
  return out;
}

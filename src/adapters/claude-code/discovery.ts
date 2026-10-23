/**
 * The filesystem half of the adapter: find sessions, classify their files, read live status.
 * Everything here only reads under the Claude config dir; nothing is ever written.
 */
import { readdirSync } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { SessionSource, SourceFile } from '../../core/adapter.js';
import type { LiveState, SessionSummary } from '../../core/model.js';
import {
  cleanPrompt,
  isProbeCwd,
  PROBE_NAME,
  parseRecord,
  pickTitle,
  promptOrigin,
  turnInput,
} from './records.js';

/** Head and tail windows. They grow only when a single line is longer than the window. */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
/** Once this much of the head is read and parsed, stop looking for a first prompt. */
const HEAD_SOFT_BYTES = 1024 * 1024;
/** Hard limit per window, e.g. a first prompt carrying pasted screenshots. */
const WINDOW_CAP_BYTES = 16 * 1024 * 1024;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export const sessionDir = (source: SessionSource) => source.location.replace(/\.jsonl$/, '');

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

type FileHandle = Awaited<ReturnType<typeof open>>;

async function readLines(fh: FileHandle, start: number, length: number): Promise<string[]> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, start);
  return buf.subarray(0, bytesRead).toString('utf8').split('\n');
}

/** Scans the start of the file, growing the window until the first prompt line is complete. */
async function scanHead(fh: FileHandle, size: number): Promise<Scan> {
  for (let len = HEAD_BYTES; ; len *= 4) {
    const whole = len >= size;
    const lines = await readLines(fh, 0, Math.min(len, size));
    // The last line of a partial window is cut: drop it.
    const s = scan(whole ? lines : lines.slice(0, -1));
    const enough = s.firstTs !== null && s.cwd !== null && (s.firstPrompt ?? s.firstAny) !== null;
    if (
      enough ||
      whole ||
      len >= WINDOW_CAP_BYTES ||
      (len >= HEAD_SOFT_BYTES && s.firstTs !== null)
    )
      return s;
  }
}

/** Scans the end of the file, growing the window until it holds a complete timestamped line. */
async function scanTail(fh: FileHandle, size: number): Promise<Scan> {
  for (let len = TAIL_BYTES; ; len *= 4) {
    const start = Math.max(0, size - len);
    const lines = await readLines(fh, start, size - start);
    // The first line of a partial window is cut: drop it.
    const s = scan(start === 0 ? lines : lines.slice(1));
    if (s.lastTs !== null || start === 0 || len >= WINDOW_CAP_BYTES) return s;
  }
}

interface Scan {
  cwd: string | null;
  version: string | null;
  firstTs: string | null;
  lastTs: string | null;
  firstPrompt: string | null;
  /** First input of any origin (peer, task notification, …). */
  firstAny: string | null;
  customTitle: string | null;
  agentName: string | null;
  aiTitle: string | null;
  model: string | null;
}

function scan(lines: string[]): Scan {
  const s: Scan = {
    cwd: null,
    version: null,
    firstTs: null,
    lastTs: null,
    firstPrompt: null,
    firstAny: null,
    customTitle: null,
    agentName: null,
    aiTitle: null,
    model: null,
  };
  for (const line of lines) {
    if (!line) continue;
    const r = parseRecord(line);
    if (r.kind === 'invalid' || r.kind === 'other') continue;
    if ('ts' in r && r.ts) {
      if (s.firstTs === null || r.ts < s.firstTs) s.firstTs = r.ts;
      if (s.lastTs === null || r.ts > s.lastTs) s.lastTs = r.ts;
    }
    if ('cwd' in r && r.cwd && s.cwd === null) s.cwd = r.cwd;
    if ('version' in r && r.version) s.version = r.version;
    if (r.kind === 'custom-title' && r.title) s.customTitle = r.title;
    if (r.kind === 'ai-title' && r.title) s.aiTitle = r.title;
    if (r.kind === 'agent-name' && r.title) s.agentName = r.title;
    if (r.kind === 'assistant' && r.model && r.model !== '<synthetic>' && !r.isSidechain)
      s.model = r.model;
    if (r.kind === 'user' && !r.isSidechain && (s.firstPrompt === null || s.firstAny === null)) {
      const origin = promptOrigin(r, true);
      const title = origin === null ? null : cleanPrompt(turnInput(r, origin).prompt);
      if (title) {
        s.firstAny ??= title;
        if (origin === 'human') s.firstPrompt ??= title;
      }
    }
  }
  return s;
}

/** Running Claude Code processes: live state and ClaudeBar probe sessions, by session id. */
export interface LiveRegistry {
  live: Map<string, LiveState>;
  probes: Set<string>;
}

async function realCwd(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return cwd;
  }
}

/** What a scan of one file yields; live state and registry probes are added per discovery. */
interface Scanned {
  size: number;
  mtimeMs: number;
  summary: Omit<SessionSummary, 'live' | 'tags'>;
  probe: boolean;
}

async function scanFile(
  path: string,
  nativeId: string,
  size: number,
  mtime: Date,
): Promise<Scanned> {
  const fh = await open(path, 'r');
  let h: Scan;
  let t: Scan;
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      h = scan(await readLines(fh, 0, size));
      t = h;
    } else {
      h = await scanHead(fh, size);
      t = await scanTail(fh, size);
    }
  } finally {
    await fh.close();
  }
  const cwd = h.cwd ?? t.cwd;
  const probe =
    [t.customTitle, h.customTitle, t.agentName, h.agentName].includes(PROBE_NAME) ||
    (cwd !== null && isProbeCwd(await realCwd(cwd)));
  return {
    size,
    mtimeMs: mtime.getTime(),
    probe,
    summary: {
      id: `claude-code:${nativeId}`,
      agent: 'claude-code',
      nativeId,
      title: pickTitle({
        customTitle: t.customTitle ?? h.customTitle,
        agentName: t.agentName ?? h.agentName,
        aiTitle: t.aiTitle ?? h.aiTitle,
        firstHuman: h.firstPrompt,
        firstAny: h.firstAny,
      }),
      cwd,
      project: cwd ? basename(cwd) : basename(dirname(path)),
      startedAt: h.firstTs,
      // The file's mtime is when its last line was written; the head's times are older.
      updatedAt: t.lastTs ?? mtime.toISOString(),
      version: t.version ?? h.version,
      model: t.model ?? h.model,
      usage: null,
      counts: null,
    },
  };
}

/** Scans by path, reused while a file's size and mtime are unchanged. */
export type DiscoveryCache = Map<string, Scanned>;

export async function discoverSessions(
  claudeDir: string,
  registry: LiveRegistry,
  cache: DiscoveryCache = new Map(),
): Promise<SessionSource[]> {
  const projects = join(claudeDir, 'projects');
  const seenDirs = new Set<string>();
  const seenFiles = new Set<string>();
  const byId = new Map<string, SessionSource>();
  for (const name of await entries(projects)) {
    let dir: string;
    try {
      dir = await realpath(join(projects, name));
      if (!(await stat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    // Symlinked project dirs point at the same sessions.
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    for (const file of await entries(dir)) {
      if (!SESSION_FILE.test(file)) continue;
      const nativeId = file.slice(0, -'.jsonl'.length);
      const location = join(dir, file);
      try {
        const st = await stat(location);
        let scanned = cache.get(location);
        if (!scanned || scanned.size !== st.size || scanned.mtimeMs !== st.mtime.getTime()) {
          scanned = await scanFile(location, nativeId, st.size, st.mtime);
          cache.set(location, scanned);
        }
        seenFiles.add(location);
        const probe = scanned.probe || registry.probes.has(nativeId);
        const summary: SessionSummary = {
          ...scanned.summary,
          live: registry.live.get(nativeId) ?? 'closed',
          ...(probe ? { tags: ['probe'] } : {}),
        };
        const prev = byId.get(nativeId);
        if (!prev || prev.summary.updatedAt < summary.updatedAt)
          byId.set(nativeId, { agent: 'claude-code', nativeId, location, summary });
      } catch {
        // Vanished or unreadable while scanning: it will show up on the next discovery.
      }
    }
  }
  for (const path of cache.keys()) if (!seenFiles.has(path)) cache.delete(path);
  return [...byId.values()];
}

const file = (
  path: string,
  role: string,
  agentId: string | null = null,
  workflowRunId: string | null = null,
): SourceFile => ({
  path,
  format: path.endsWith('.jsonl') ? 'jsonl' : 'json',
  role,
  agentId,
  workflowRunId,
});

const AGENT_FILE = /^agent-(.+?)(\.meta\.json|\.jsonl)$/;

/** Role of a path inside a session, or null when it is not one of the session's files. */
export function classifyPath(source: SessionSource, path: string): SourceFile | null {
  if (path === source.location) return file(path, 'main');
  const rel = relative(sessionDir(source), path);
  if (rel.startsWith('..')) return null;
  const parts = rel.split(sep);
  const name = parts.at(-1) ?? '';
  const agent = AGENT_FILE.exec(name);
  if (parts.length === 2 && parts[0] === 'subagents' && agent) {
    return file(path, agent[2] === '.jsonl' ? 'subagent' : 'subagent-meta', agent[1] ?? null);
  }
  if (parts.length === 4 && parts[0] === 'subagents' && parts[1] === 'workflows') {
    const runId = parts[2] ?? null;
    if (name === 'journal.jsonl') return file(path, 'workflow-journal', null, runId);
    if (agent)
      return file(
        path,
        agent[2] === '.jsonl' ? 'workflow-agent' : 'workflow-agent-meta',
        agent[1] ?? null,
        runId,
      );
  }
  if (parts.length === 2 && parts[0] === 'workflows' && name.endsWith('.json'))
    return file(path, 'workflow-state', null, name.slice(0, -'.json'.length));
  return null;
}

export async function listSessionFiles(source: SessionSource): Promise<SourceFile[]> {
  const dir = sessionDir(source);
  const paths = [source.location];
  const sub = join(dir, 'subagents');
  for (const n of await entries(sub)) paths.push(join(sub, n));
  const wfs = join(sub, 'workflows');
  for (const run of await entries(wfs))
    for (const n of await entries(join(wfs, run))) paths.push(join(wfs, run, n));
  const states = join(dir, 'workflows');
  for (const n of await entries(states)) paths.push(join(states, n));
  return paths.flatMap((p) => classifyPath(source, p) ?? []);
}

export function sessionWatchDirs(source: SessionSource): string[] {
  const dir = sessionDir(source);
  const wfs = join(dir, 'subagents', 'workflows');
  let runs: string[] = [];
  try {
    runs = readdirSync(wfs).map((r) => join(wfs, r));
  } catch {
    // No workflow runs yet.
  }
  return [
    dirname(source.location),
    dir,
    join(dir, 'subagents'),
    wfs,
    ...runs,
    join(dir, 'workflows'),
  ];
}

const LIVE: Record<string, LiveState> = {
  busy: 'busy',
  waiting: 'waiting',
  idle: 'idle',
  shell: 'idle',
};
const RANK: Record<LiveState, number> = { busy: 4, waiting: 3, idle: 2, unknown: 1, closed: 0 };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `<claudeDir>/sessions/*.json`: one entry per running Claude Code process. */
export async function readLiveRegistry(claudeDir: string): Promise<LiveRegistry> {
  const dir = join(claudeDir, 'sessions');
  const out = new Map<string, LiveState>();
  const probes = new Set<string>();
  for (const name of await entries(dir)) {
    if (!name.endsWith('.json')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(await readFile(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const r = (entry ?? {}) as Record<string, unknown>;
    const { pid, sessionId, status, cwd } = r;
    if (typeof pid !== 'number' || typeof sessionId !== 'string' || !alive(pid)) continue;
    if (r.name === PROBE_NAME || (typeof cwd === 'string' && isProbeCwd(await realCwd(cwd))))
      probes.add(sessionId);
    const known = typeof status === 'string' && Object.hasOwn(LIVE, status);
    const state = (known ? LIVE[status as string] : undefined) ?? 'unknown';
    const prev = out.get(sessionId);
    if (!prev || RANK[state] > RANK[prev]) out.set(sessionId, state);
  }
  return { live: out, probes };
}

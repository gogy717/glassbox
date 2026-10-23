/**
 * The filesystem half of the adapter: find sessions, classify their files, read live status.
 * Everything here only reads under the Grok config dir; nothing is ever written.
 *
 * Catalog scans read `summary.json` only. The transcript logs are large and are left to the parser.
 */
import { execFile } from 'node:child_process';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { SessionSource, SourceFile } from '../../core/adapter.js';
import type { LiveState } from '../../core/model.js';
import { parseSummary } from './records.js';

/** Parser inputs at the top of a session directory. Other names (locks, signals, terminals) are skipped. */
const TOP_ROLES: Record<string, string> = {
  'chat_history.jsonl': 'chat-history',
  'events.jsonl': 'events',
  'summary.json': 'summary',
  'tool_definitions.json': 'tool-definitions',
  'updates.jsonl': 'updates',
  'usage.json': 'usage',
};

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** `kill(pid, 0)` probes existence. EPERM still means the process is there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** `pid_start` → epoch ms, by magnitude (µs on Grok 1.0.67); null when it is not a plausible time. */
function pidStartMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v > 1e14) return v / 1000;
  if (v > 1e11) return v;
  if (v > 1e8) return v * 1000;
  return null;
}

/** The process's start time from `ps` (second resolution), or null when it cannot be read. */
function processStartMs(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { ...process.env, LC_ALL: 'C' }, timeout: 2000 },
      (err, out) => {
        const ms = err ? Number.NaN : Date.parse(String(out).trim());
        resolve(Number.isNaN(ms) ? null : ms);
      },
    );
  });
}

/** Busy / waiting / idle from the tail of a session's `events.jsonl`; null when unknown. */
async function activityOf(path: string): Promise<LiveState | null> {
  let text: string;
  try {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - 64 * 1024);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  let state: LiveState | null = null;
  for (const line of text.split('\n')) {
    let type: unknown;
    try {
      type = (JSON.parse(line) as { type?: unknown }).type;
    } catch {
      continue;
    }
    if (type === 'turn_ended') state = 'idle';
    else if (type === 'permission_requested') state = 'waiting';
    else if (
      type === 'permission_resolved' ||
      type === 'turn_started' ||
      type === 'loop_started' ||
      type === 'phase_changed' ||
      type === 'tool_started' ||
      type === 'first_token'
    )
      state = 'busy';
  }
  return state;
}

/** Results reused across polls: a pid's start time does not change while it lives. */
export interface LiveCache {
  pidOk: Map<string, boolean>;
}

/**
 * `active_sessions.json` is an array of `{ session_id, pid, pid_start }`. A torn write is not an
 * array; the previous list may sit beside it as `active_sessions.json.corrupt`. A dead pid, or a
 * pid whose start time is not `pid_start` (reused by another process), is omitted, so a missing
 * id means `closed`. The session's events tell busy, waiting and idle apart.
 */
export async function readLiveStatus(
  grokDir: string,
  cache: LiveCache = { pidOk: new Map() },
): Promise<Map<string, LiveState>> {
  let value = await readJson(join(grokDir, 'active_sessions.json'));
  if (!Array.isArray(value)) value = await readJson(join(grokDir, 'active_sessions.json.corrupt'));
  const out = new Map<string, LiveState>();
  if (!Array.isArray(value)) return out;
  const groups = await entries(join(grokDir, 'sessions'));
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const sessionId = row.session_id;
    if (typeof sessionId !== 'string' || sessionId === '' || !isPid(row.pid) || !alive(row.pid))
      continue;
    const expected = pidStartMs(row.pid_start);
    if (expected !== null) {
      const key = `${row.pid}:${row.pid_start}`;
      let ok = cache.pidOk.get(key);
      if (ok === undefined) {
        const actual = await processStartMs(row.pid);
        ok = actual === null || Math.abs(actual - expected) <= 2000;
        cache.pidOk.set(key, ok);
      }
      if (!ok) continue;
    }
    let state: LiveState | null = null;
    for (const group of groups) {
      state = await activityOf(join(grokDir, 'sessions', group, sessionId, 'events.jsonl'));
      if (state) break;
    }
    out.set(sessionId, state ?? 'busy');
  }
  return out;
}

async function readVersion(grokDir: string): Promise<string | null> {
  const value = await readJson(join(grokDir, 'version.json'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return nonempty((value as Record<string, unknown>).version);
}

export async function discoverSessions(
  grokDir: string,
  cache: LiveCache = { pidOk: new Map() },
): Promise<SessionSource[]> {
  const [live, version] = await Promise.all([readLiveStatus(grokDir, cache), readVersion(grokDir)]);
  const seenGroups = new Set<string>();
  const seenSessions = new Set<string>();
  const byId = new Map<string, SessionSource>();

  for (const groupName of await entries(join(grokDir, 'sessions'))) {
    const groupPath = join(grokDir, 'sessions', groupName);
    let groupReal: string;
    try {
      groupReal = await realpath(groupPath);
      if (!(await stat(groupReal)).isDirectory()) continue;
    } catch {
      continue;
    }
    // Symlinked project groups point at the same sessions.
    if (seenGroups.has(groupReal)) continue;
    seenGroups.add(groupReal);

    for (const sessionName of await entries(groupReal)) {
      const sessionPath = join(groupReal, sessionName);
      let sessionReal: string;
      try {
        sessionReal = await realpath(sessionPath);
        if (!(await stat(sessionReal)).isDirectory()) continue;
      } catch {
        continue;
      }
      if (seenSessions.has(sessionReal)) continue;
      seenSessions.add(sessionReal);

      const raw = await readJson(join(sessionReal, 'summary.json'));
      if (raw === undefined) continue;
      let parsed: ReturnType<typeof parseSummary>;
      try {
        parsed = parseSummary(raw);
      } catch {
        // One broken catalog hides only its own session, never the whole list.
        continue;
      }
      if (!parsed.id) continue;

      const cwd = parsed.cwd;
      const updatedAt =
        parsed.updatedAt ??
        parsed.createdAt ??
        (await stat(join(sessionReal, 'summary.json'))).mtime.toISOString();
      const source: SessionSource = {
        agent: 'grok',
        nativeId: parsed.id,
        location: sessionReal,
        summary: {
          id: `grok:${parsed.id}`,
          agent: 'grok',
          nativeId: parsed.id,
          title: parsed.title,
          cwd,
          project: cwd ? basename(cwd) || cwd : basename(sessionReal),
          startedAt: parsed.createdAt,
          updatedAt,
          live: live.get(parsed.id) ?? 'closed',
          version,
          model: parsed.model,
          usage: null,
          counts: null,
        },
      };
      const prev = byId.get(parsed.id);
      if (!prev || prev.summary.updatedAt < source.summary.updatedAt) byId.set(parsed.id, source);
    }
  }
  return [...byId.values()];
}

function sourceFile(path: string, role: string): SourceFile {
  return {
    path,
    format: path.endsWith('.jsonl') ? 'jsonl' : 'json',
    role,
    agentId: null,
    workflowRunId: null,
  };
}

/** Role of a path inside a session, or null when it is not one of the session's files. */
export function classifyPath(source: SessionSource, path: string): SourceFile | null {
  const rel = relative(source.location, path);
  if (rel.startsWith('..') || rel === '') return null;
  const parts = rel.split(sep);
  const name = parts.at(-1) ?? '';
  if (parts.length === 1) {
    const role = TOP_ROLES[name];
    return role ? sourceFile(path, role) : null;
  }
  // Sub-agent trees are not on disk in current builds, but a later file should still be ingested.
  if (parts[0] !== 'subagents') return null;
  if (name.endsWith('.jsonl')) return sourceFile(path, 'subagent');
  if (name.endsWith('.json')) return sourceFile(path, 'subagent-meta');
  return null;
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await entries(dir)) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.isDirectory()) out.push(...(await filesUnder(path)));
      else if (info.isFile()) out.push(path);
    } catch {
      // Vanished while listing.
    }
  }
  return out;
}

export async function listSessionFiles(source: SessionSource): Promise<SourceFile[]> {
  const paths: string[] = [];
  for (const name of await entries(source.location)) {
    const path = join(source.location, name);
    try {
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue;
    }
    paths.push(path);
  }
  paths.push(...(await filesUnder(join(source.location, 'subagents'))));
  return paths.flatMap((path) => classifyPath(source, path) ?? []);
}

/** The session dir and `subagents/`, even when the latter does not exist yet. */
export function sessionWatchDirs(source: SessionSource): string[] {
  return [source.location, join(source.location, 'subagents')];
}

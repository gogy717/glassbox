/** Client for glassbox-owned runs (B-lite): start, message, interrupt, end, answer prompts. */

import {
  type LiveState,
  MAIN_AGENT_ID,
  type SessionActivity,
  type SessionSummary,
} from '../../../src/core/model.js';
import {
  type ApiErrorResponse,
  api,
  TOKEN_HEADER,
  type TokenResponse,
} from '../../../src/shared/protocol.js';
import {
  type DirectoriesResponse,
  type PermissionDecision,
  type PermissionRequest,
  type RunState,
  runsApi,
  type StartRunRequest,
  type StartRunResponse,
} from '../../../src/shared/runs.js';
import { ApiError } from './api';

async function failure(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as ApiErrorResponse | null;
  return new ApiError(res.status, body?.error ?? res.statusText);
}

export interface RunsClient {
  token(): Promise<string>;
  start(req: StartRunRequest): Promise<RunState>;
  send(runId: string, prompt: string): Promise<void>;
  interrupt(runId: string): Promise<void>;
  close(runId: string): Promise<void>;
  decide(runId: string, permissionId: string, d: PermissionDecision): Promise<void>;
  list(): Promise<RunState[]>;
  directories(): Promise<string[]>;
}

export function createRunsClient(): RunsClient {
  let token: Promise<string> | null = null;
  const fetchToken = () => {
    token = fetch(api.token(), {}).then(async (res) => {
      if (!res.ok) throw await failure(res);
      return ((await res.json()) as TokenResponse).token;
    });
    // A failed fetch must not be cached forever.
    token.catch(() => {
      token = null;
    });
    return token;
  };

  /** Writes carry the per-launch token; a 403 means the server restarted, so refresh once. */
  async function write(method: 'POST' | 'DELETE', url: string, body?: unknown): Promise<Response> {
    const attempt = async (tok: string) =>
      fetch(url, {
        method,
        headers: {
          [TOKEN_HEADER]: tok,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res = await attempt(await (token ?? fetchToken()));
    if (res.status === 403) res = await attempt(await fetchToken());
    if (!res.ok) throw await failure(res);
    return res;
  }

  async function read<T>(url: string): Promise<T> {
    const res = await fetch(url, {});
    if (!res.ok) throw await failure(res);
    return (await res.json()) as T;
  }

  return {
    token: () => token ?? fetchToken(),
    async start(req) {
      const res = await write('POST', runsApi.runs(), req);
      return ((await res.json()) as StartRunResponse).run;
    },
    async send(runId, prompt) {
      await write('POST', runsApi.message(runId), { prompt });
    },
    async interrupt(runId) {
      await write('POST', runsApi.interrupt(runId));
    },
    async close(runId) {
      await write('DELETE', runsApi.run(runId));
    },
    async decide(runId, permissionId, d) {
      await write('POST', runsApi.permission(runId, permissionId), d);
    },
    list: () => read<RunState[]>(runsApi.runs()),
    directories: async () => (await read<DirectoriesResponse>(runsApi.directories())).recent,
  };
}

/** The run attached to a session: the most recently updated one that has not closed. */
export function runForSession(
  runs: Map<string, RunState>,
  sessionId: string | null,
): RunState | null {
  if (!sessionId) return null;
  let best: RunState | null = null;
  for (const r of runs.values()) {
    if (r.sessionId !== sessionId || r.status === 'closed') continue;
    if (!best || r.updatedAt > best.updatedAt) best = r;
  }
  return best;
}

/**
 * The sessions whose glassbox run failed, with the run's error (null when it gave none): the run
 * `runForSession` picks for the session, the one the composer shows, has the status 'error'.
 */
export function failedSessions(runs: Map<string, RunState>): Map<string, string | null> {
  const latest = new Map<string, RunState>();
  for (const r of runs.values()) {
    if (!r.sessionId || r.status === 'closed') continue;
    const best = latest.get(r.sessionId);
    if (!best || r.updatedAt > best.updatedAt) latest.set(r.sessionId, r);
  }
  const failed = new Map<string, string | null>();
  for (const [id, r] of latest) if (r.status === 'error') failed.set(id, r.error);
  return failed;
}

/**
 * The permission prompt or question each session's glassbox runs hold open, by session: the
 * prompt the composer shows (`pendingPermissions`), the oldest when there are several, on any
 * run that has not closed. Their process only knows it is busy.
 */
export function pendingPrompts(runs: Map<string, RunState>): Map<string, PermissionRequest> {
  const out = new Map<string, PermissionRequest>();
  for (const r of runs.values()) {
    if (!r.sessionId || r.status === 'closed') continue;
    for (const p of r.pendingPermissions) {
      const have = out.get(r.sessionId);
      if (!have || p.requestedAt < have.requestedAt) out.set(r.sessionId, p);
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The prompts open, as one string: a run event arrives with every streamed piece of a reply, so
 * what depends on the prompts alone is derived again only when this changes.
 */
export function promptsKey(runs: Map<string, RunState>): string {
  return [...pendingPrompts(runs)].map(([sessionId, p]) => `${sessionId}\t${p.id}`).join('\n');
}

/** A session's live state, 'waiting' ("Waiting for you") when a prompt is open on it. */
export function waitingLive(
  s: SessionSummary,
  prompts: ReadonlyMap<string, PermissionRequest>,
): LiveState {
  return prompts.has(s.id) ? 'waiting' : s.live;
}

/**
 * A prompt as the activity a parser reports for a session blocked on one: waiting, for the
 * prompt's tool, since it was asked. The row then says what the session waits for, and since
 * when, as it does for a session a terminal holds.
 */
export function promptActivity(p: PermissionRequest): SessionActivity {
  return {
    kind: 'waiting',
    tool: p.toolName,
    target: null,
    agentId: MAIN_AGENT_ID,
    since: p.requestedAt,
  };
}

/**
 * `sessions` with those in `prompts` live as 'waiting', their activity the prompt; the same list
 * when none is.
 */
export function withWaiting(
  sessions: SessionSummary[],
  prompts: ReadonlyMap<string, PermissionRequest>,
): SessionSummary[] {
  if (prompts.size === 0) return sessions;
  return sessions.map((s) => {
    const p = prompts.get(s.id);
    return p ? { ...s, live: 'waiting', activity: promptActivity(p) } : s;
  });
}

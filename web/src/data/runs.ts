/** Client for glassbox-owned runs (B-lite): start, message, interrupt, end, answer prompts. */
import {
  type ApiErrorResponse,
  api,
  TOKEN_HEADER,
  type TokenResponse,
} from '../../../src/shared/protocol.js';
import {
  type DirectoriesResponse,
  type PermissionDecision,
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

import { stat } from 'node:fs/promises';
import type { LiveState, SessionSummary } from '../core/model.js';
import type { PermissionDecision, RunState, StartRunRequest } from '../shared/runs.js';

/**
 * What the routes need from the run manager (`src/server/runners/run-manager.ts` implements
 * it). Client errors are thrown as errors with a numeric `status` (400/404/409/503) whose
 * message is shown to the user; anything else is a 500.
 */
export interface RunService {
  start(req: StartRunRequest): Promise<RunState>;
  send(runId: string, prompt: string): void;
  interrupt(runId: string): Promise<void>;
  close(runId: string): void;
  decide(runId: string, permissionId: string, d: PermissionDecision): void;
  list(): RunState[];
  onRun(cb: (r: RunState) => void): () => void;
}

export interface RunSessionInfo {
  nativeId: string;
  cwd: string | null;
  live: LiveState;
}

/** `resolveSession` for the run manager, answered from the session list. */
export function sessionResolver(store: {
  listSessions(): SessionSummary[];
}): (sessionId: string) => RunSessionInfo | null {
  return (sessionId) => {
    const s = store.listSessions().find((x) => x.id === sessionId);
    return s ? { nativeId: s.nativeId, cwd: s.cwd, live: s.live } : null;
  };
}

const MAX_DIRECTORIES = 20;

/** Working directories of known sessions that still exist, most recently used first. */
export async function recentDirectories(sessions: SessionSummary[]): Promise<string[]> {
  const byTime = [...sessions].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of byTime) {
    if (out.length >= MAX_DIRECTORIES) break;
    if (!s.cwd || seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    if (await isDirectory(s.cwd)) out.push(s.cwd);
  }
  return out;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * As soon as a run learns its session id (system/init), have the store look for that
 * session, so a tab navigating to it gets its snapshot without waiting for discovery.
 */
export function linkRunSessions(
  runs: Pick<RunService, 'onRun'>,
  store: { expectSession(sessionId: string): Promise<boolean> },
): () => void {
  const seen = new Set<string>();
  return runs.onRun((run) => {
    if (!run.sessionId || seen.has(run.sessionId)) return;
    seen.add(run.sessionId);
    void store.expectSession(run.sessionId);
  });
}

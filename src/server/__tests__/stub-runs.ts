/**
 * In-memory RunService for route tests. Follows the agreed error convention: client errors
 * are thrown as errors with a numeric `status`.
 */
import type { PermissionDecision, RunState, StartRunRequest } from '../../shared/runs.js';
import type { RunService } from '../run-service.js';

export function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export class StubRuns implements RunService {
  readonly runs = new Map<string, RunState>();
  readonly calls: { method: string; args: unknown[] }[] = [];
  /** Make the next call of `method` throw this. */
  readonly failNext = new Map<string, Error>();
  private readonly listeners = new Set<(r: RunState) => void>();
  private serial = 0;

  get listenerCount(): number {
    return this.listeners.size;
  }

  async start(req: StartRunRequest): Promise<RunState> {
    this.record('start', [req]);
    const id = `run-${++this.serial}`;
    const run = blankRun(id, req);
    this.runs.set(id, run);
    this.emit(run);
    return run;
  }

  send(runId: string, prompt: string): void {
    this.record('send', [runId, prompt]);
    const run = this.get(runId);
    if (run.status !== 'idle') throw statusError(409, 'Wait for the current reply to finish');
    this.emit({ ...run, status: 'running' });
  }

  async interrupt(runId: string): Promise<void> {
    this.record('interrupt', [runId]);
    this.get(runId);
  }

  close(runId: string): void {
    this.record('close', [runId]);
    this.emit({ ...this.get(runId), status: 'closed' });
  }

  decide(runId: string, permissionId: string, d: PermissionDecision): void {
    this.record('decide', [runId, permissionId, d]);
    const run = this.get(runId);
    if (!run.pendingPermissions.some((p) => p.id === permissionId))
      throw statusError(404, 'permission request not found');
    this.emit({
      ...run,
      status: 'running',
      pendingPermissions: run.pendingPermissions.filter((p) => p.id !== permissionId),
    });
  }

  list(): RunState[] {
    return [...this.runs.values()];
  }

  onRun(cb: (r: RunState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Store and broadcast a new state of a run. */
  emit(run: RunState): void {
    this.runs.set(run.id, run);
    for (const cb of this.listeners) cb(run);
  }

  private record(method: string, args: unknown[]): void {
    const err = this.failNext.get(method);
    if (err) {
      this.failNext.delete(method);
      throw err;
    }
    this.calls.push({ method, args });
  }

  private get(runId: string): RunState {
    const run = this.runs.get(runId);
    if (!run) throw statusError(404, 'run not found');
    return run;
  }
}

export function blankRun(id: string, req: Partial<StartRunRequest> = {}): RunState {
  const at = '2026-10-23T02:00:00.000Z';
  return {
    id,
    sessionId: req.sessionId ?? null,
    cwd: req.cwd ?? '/repo',
    mode: req.mode ?? 'new',
    status: 'starting',
    permissionMode: req.permissionMode ?? 'default',
    startedAt: at,
    updatedAt: at,
    pendingPermissions: [],
    partial: null,
    error: null,
    last: null,
  };
}

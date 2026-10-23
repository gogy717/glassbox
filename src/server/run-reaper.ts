import type { RunService } from './run-service.js';

/** Open event-stream connections, and since when there have been none. */
export class ClientCounter {
  count = 0;
  private emptySince = Date.now();

  /** Registers a connection; the returned function (idempotent) unregisters it. */
  join(): () => void {
    this.count++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.count--;
      if (this.count === 0) this.emptySince = Date.now();
    };
  }

  /** When the last client left (or the counter was made); null while anyone is connected. */
  unattendedSince(): number | null {
    return this.count > 0 ? null : this.emptySince;
  }
}

/**
 * Closes runs that sat idle with nobody watching for `idleMs`, so forgotten `claude`
 * processes don't live forever. Both clocks count: the run's last update and the moment the
 * last browser tab went away. Returns a stop function.
 */
export function startRunReaper(opts: {
  runs: Pick<RunService, 'list' | 'close'>;
  clients: ClientCounter;
  idleMs?: number;
  everyMs?: number;
  log?: (msg: string) => void;
}): () => void {
  const idleMs = opts.idleMs ?? 30 * 60_000;
  const everyMs = opts.everyMs ?? 60_000;
  const timer = setInterval(() => {
    const since = opts.clients.unattendedSince();
    if (since === null) return;
    const now = Date.now();
    for (const run of opts.runs.list()) {
      if (run.status !== 'idle') continue;
      if (now - Math.max(Date.parse(run.updatedAt), since) < idleMs) continue;
      try {
        opts.runs.close(run.id);
        opts.log?.(
          `closed run ${run.id}: idle and unwatched for ${Math.round(idleMs / 60_000)} min`,
        );
      } catch (err) {
        opts.log?.(
          `closing idle run ${run.id} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

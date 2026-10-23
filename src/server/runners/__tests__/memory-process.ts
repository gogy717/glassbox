/** An in-memory ClaudeProcess for RunManager tests: records what is sent, replays what is pushed. */
import type { ClaudeProcess, ExitInfo, SpawnClaudeOptions } from '../claude-process.js';

export class MemoryProcess implements ClaudeProcess {
  readonly pid = 4242;
  readonly malformedLines = 0;
  readonly sent: Record<string, unknown>[] = [];
  ended = false;
  killed = false;
  private readonly messages = new Set<(m: Record<string, unknown>) => void>();
  private readonly exits = new Set<(i: ExitInfo) => void>();
  private exitInfo: ExitInfo | null = null;

  constructor(readonly opts: SpawnClaudeOptions) {}

  send(msg: object): void {
    if (!this.exitInfo) this.sent.push(msg as Record<string, unknown>);
  }
  end(): void {
    this.ended = true;
  }
  kill(): void {
    this.killed = true;
  }
  onMessage(cb: (m: Record<string, unknown>) => void): () => void {
    this.messages.add(cb);
    return () => this.messages.delete(cb);
  }
  onExit(cb: (i: ExitInfo) => void): () => void {
    this.exits.add(cb);
    return () => this.exits.delete(cb);
  }

  /** Claude Code writes a line. */
  push(msg: Record<string, unknown>): void {
    for (const cb of this.messages) cb(msg);
  }
  exit(code: number | null, stderrTail: string[] = [], signal: NodeJS.Signals | null = null) {
    this.exitInfo = { code, signal, stderrTail, error: null };
    for (const cb of this.exits) cb(this.exitInfo);
  }

  /** Sent messages of a type (and control subtype). */
  sentOf(type: string, subtype?: string): Record<string, unknown>[] {
    return this.sent.filter(
      (m) =>
        m.type === type &&
        (subtype === undefined ||
          (m.request as { subtype?: string } | undefined)?.subtype === subtype),
    );
  }

  /** Answers the initialize request the way Claude Code 2.1.308 does. */
  initialize(extra: Record<string, unknown> = {}): void {
    const req = this.sentOf('control_request', 'initialize')[0] as { request_id: string };
    this.push({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: req.request_id,
        response: {
          claude_code_version: '2.1.308',
          account: { email: 'someone@example.invalid' },
          commands: [],
          ...extra,
        },
        pending_permission_requests: [],
      },
    });
  }
}

export function memorySpawn() {
  const procs: MemoryProcess[] = [];
  const spawn = (opts: SpawnClaudeOptions) => {
    const p = new MemoryProcess(opts);
    procs.push(p);
    return p;
  };
  return { spawn, procs, last: () => procs.at(-1) as MemoryProcess };
}

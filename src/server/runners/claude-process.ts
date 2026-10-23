/**
 * One child process of the user's installed `claude`, spoken to in newline-delimited JSON over
 * stdin/stdout (`--input-format stream-json --output-format stream-json`): one object per line in
 * both directions. It reads user messages for as long as stdin stays open, and exits once stdin
 * is closed.
 */
import { spawn } from 'node:child_process';
import { stringifyDeep } from '../json.js';

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Last non-empty stderr lines, oldest first. */
  stderrTail: string[];
  /** Set when the process could not be started or its pipes failed. */
  error: string | null;
}

export interface ClaudeProcess {
  readonly pid: number | undefined;
  /** Stdout lines that were not a JSON object; they are skipped. */
  readonly malformedLines: number;
  /** Writes one message as a line. A no-op once the process is gone. */
  send(msg: object): void;
  /** Closes stdin: Claude Code finishes and exits. */
  end(): void;
  /** SIGTERM, then SIGKILL if it is still running after a grace period. */
  kill(): void;
  onMessage(cb: (msg: Record<string, unknown>) => void): () => void;
  /** Called once; listeners added after the exit are called right away. */
  onExit(cb: (info: ExitInfo) => void): () => void;
}

export interface SpawnClaudeOptions {
  bin: string;
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const STDERR_LINES = 20;
const KILL_GRACE_MS = 3000;

export function spawnClaude(opts: SpawnClaudeOptions): ClaudeProcess {
  const child = spawn(opts.bin, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messageListeners = new Set<(msg: Record<string, unknown>) => void>();
  const exitListeners = new Set<(info: ExitInfo) => void>();
  const stderrTail: string[] = [];
  let malformed = 0;
  let exit: ExitInfo | null = null;
  let error: string | null = null;
  let stdinOpen = true;

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exit) return;
    exit = { code, signal, stderrTail: [...stderrTail], error };
    stdinOpen = false;
    for (const cb of exitListeners) cb(exit);
  };

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        malformed += 1;
        continue;
      }
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
        malformed += 1;
        continue;
      }
      for (const cb of messageListeners) cb(msg as Record<string, unknown>);
    }
  });

  let stderrBuffer = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.trim()) continue;
      stderrTail.push(l.trim());
      if (stderrTail.length > STDERR_LINES) stderrTail.shift();
    }
  });

  // A closed pipe (the process died) must not crash the server.
  child.stdin.on('error', () => {
    stdinOpen = false;
  });
  child.on('error', (err) => {
    error = err.message;
    // Spawn failures emit 'error' and may never emit 'close'.
    if (child.pid === undefined) finish(null, null);
  });
  child.on('close', (code, signal) => {
    if (stderrBuffer.trim()) stderrTail.push(stderrBuffer.trim());
    finish(code, signal);
  });

  return {
    get pid() {
      return child.pid;
    },
    get malformedLines() {
      return malformed;
    },
    send(msg) {
      if (!stdinOpen || exit) return;
      child.stdin.write(`${messageLine(msg)}\n`);
    },
    end() {
      if (!stdinOpen) return;
      stdinOpen = false;
      child.stdin.end();
    },
    kill() {
      if (exit) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (!exit) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      timer.unref();
    },
    onMessage(cb) {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onExit(cb) {
      const done = exit;
      if (done) queueMicrotask(() => cb(done));
      else exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}

/**
 * A message as one JSON line. JSON.stringify overflows its stack a few thousand levels down;
 * such a message (e.g. a deeply nested tool input echoed back) is written iteratively, whole.
 */
function messageLine(msg: object): string {
  try {
    return JSON.stringify(msg);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return stringifyDeep(msg) as string;
  }
}

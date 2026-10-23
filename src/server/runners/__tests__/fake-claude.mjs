#!/usr/bin/env node
/**
 * A stand-in for the `claude` binary in tests: replays a scripted stream-json conversation.
 *
 * FAKE_CLAUDE_SCENARIO  JSON array of steps, run in order:
 *   { "wait": <pattern> }   wait for the next stdin message whose fields include <pattern>
 *   { "emit": <message> }   write one JSON line; the string "$id" becomes the request_id of the
 *                           message matched by the last "wait"
 *   { "raw": "<text>" }     write text as is (fragments, malformed lines)
 *   { "stderr": "<text>" }  write a line to stderr
 *   { "sleep": <ms> }
 *   { "exit": <code> }
 *   { "hang": true }        stop the script; keep reading stdin and never exit on its own
 *   After the last step the process exits 0 once stdin closes.
 * FAKE_CLAUDE_SCENARIO_FILE  the same, read from a file (for scenarios too big for an env var)
 * FAKE_CLAUDE_LOG       file receiving {"argv"}, {"cwd"}, {"env"} and one {"stdin"} line per message,
 *                       holding the message exactly as it was written
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const steps = JSON.parse(
  process.env.FAKE_CLAUDE_SCENARIO_FILE
    ? readFileSync(process.env.FAKE_CLAUDE_SCENARIO_FILE, 'utf8')
    : (process.env.FAKE_CLAUDE_SCENARIO ?? '[]'),
);
const logPath = process.env.FAKE_CLAUDE_LOG;
const log = (entry) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};
log({ argv: process.argv.slice(2) });
log({ cwd: process.cwd() });
log({ env: { FAKE_MARK: process.env.FAKE_MARK ?? null } });

const inbox = [];
let waiting = null;
let stdinClosed = false;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  let parsed = true;
  try {
    msg = JSON.parse(line);
  } catch {
    msg = { unparsable: line };
    parsed = false;
  }
  // As written, not re-serialized: a message may nest too deep for JSON.stringify.
  if (logPath && parsed) appendFileSync(logPath, `{"stdin":${line}}\n`);
  else log({ stdin: msg });
  inbox.push(msg);
  waiting?.();
});
rl.on('close', () => {
  stdinClosed = true;
  waiting?.();
});

const includes = (value, pattern) =>
  typeof pattern === 'object' && pattern !== null
    ? typeof value === 'object' &&
      value !== null &&
      Object.entries(pattern).every(([k, p]) => includes(value[k], p))
    : value === pattern;

async function next(pattern) {
  for (;;) {
    const i = inbox.findIndex((m) => includes(m, pattern));
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (stdinClosed) return null;
    await new Promise((r) => {
      waiting = r;
    });
    waiting = null;
  }
}

const fill = (v, id) =>
  v === '$id'
    ? id
    : Array.isArray(v)
      ? v.map((x) => fill(x, id))
      : typeof v === 'object' && v !== null
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, id)]))
        : v;

let lastId = null;
for (const step of steps) {
  if ('wait' in step) {
    const m = await next(step.wait);
    if (m === null) process.exit(0);
    lastId = m.request_id ?? m.response?.request_id ?? null;
  } else if ('emit' in step) process.stdout.write(`${JSON.stringify(fill(step.emit, lastId))}\n`);
  else if ('raw' in step) process.stdout.write(step.raw);
  else if ('stderr' in step) process.stderr.write(`${step.stderr}\n`);
  else if ('sleep' in step) await new Promise((r) => setTimeout(r, step.sleep));
  else if ('exit' in step) process.exit(step.exit);
  else if ('hang' in step) await new Promise(() => {});
}
await next({ never: true });
process.exit(0);

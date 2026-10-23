import { isAbsolute } from 'node:path';
import type { Context, Hono } from 'hono';
import type { SessionSummary } from '../core/model.js';
import type { ApiErrorResponse } from '../shared/protocol.js';
import type {
  DirectoriesResponse,
  PermissionDecision,
  RunEffort,
  RunMode,
  RunPermissionMode,
  RunState,
  StartRunRequest,
  StartRunResponse,
} from '../shared/runs.js';
import { Coalescer } from './coalescer.js';
import { jsonResponse } from './json.js';
import { isDirectory, type RunService, recentDirectories } from './run-service.js';

const MODES: readonly RunMode[] = ['new', 'resume', 'fork'];
const PERMISSION_MODES: readonly RunPermissionMode[] = ['default', 'acceptEdits', 'plan'];
const EFFORTS: readonly RunEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const NO_CLAUDE = 'The claude command was not found';

/** A bad request: the message says which field is wrong. */
class BadRequest extends Error {
  readonly status = 400;
}

/**
 * The /api/runs routes and /api/directories. With `runs` null (no `claude` binary) every
 * mutating route answers 503; reads still work so the viewer is unaffected.
 */
export function registerRunRoutes(
  app: Hono,
  deps: {
    runs: RunService | null;
    listSessions: () => SessionSummary[];
  },
): void {
  const { runs } = deps;
  const unavailable = (c: Context) => jsonResponse<ApiErrorResponse>(c, { error: NO_CLAUDE }, 503);

  app.get('/api/directories', async (c) =>
    jsonResponse<DirectoriesResponse>(c, { recent: await recentDirectories(deps.listSessions()) }),
  );

  app.get('/api/runs', (c) => jsonResponse<RunState[]>(c, runs ? runs.list() : []));

  app.post('/api/runs', async (c) => {
    if (!runs) return unavailable(c);
    const req = parseStartRun(await jsonBody(c));
    if (req.mode === 'new' && !(await isDirectory(req.cwd as string)))
      throw new BadRequest(`cwd is not an existing directory: ${req.cwd}`);
    return jsonResponse<StartRunResponse>(c, { run: await runs.start(req) }, 201);
  });

  app.post('/api/runs/:runId/messages', async (c) => {
    if (!runs) return unavailable(c);
    const body = await jsonBody(c);
    runs.send(c.req.param('runId'), prompt(body));
    return c.body(null, 204);
  });

  app.post('/api/runs/:runId/interrupt', async (c) => {
    if (!runs) return unavailable(c);
    await runs.interrupt(c.req.param('runId'));
    return c.body(null, 204);
  });

  app.delete('/api/runs/:runId', (c) => {
    if (!runs) return unavailable(c);
    runs.close(c.req.param('runId'));
    return c.body(null, 204);
  });

  app.post('/api/runs/:runId/permissions/:permissionId', async (c) => {
    if (!runs) return unavailable(c);
    const decision = parseDecision(await jsonBody(c));
    runs.decide(c.req.param('runId'), c.req.param('permissionId'), decision);
    return c.body(null, 204);
  });
}

/**
 * Per-connection `run` event pacing: at most one event per run every `minMs` (protocol:
 * ≤ 20/s), always ending on the run's latest state. Runs never hold each other back.
 */
export function runEventPacer(send: (run: RunState) => void, minMs = 50) {
  const slots = new Map<string, { latest: RunState | null; pacer: Coalescer }>();
  return {
    push(run: RunState): void {
      let slot = slots.get(run.id);
      if (!slot) {
        const s = {
          latest: null as RunState | null,
          pacer: new Coalescer(minMs, () => {
            const next = s.latest;
            s.latest = null;
            if (next) send(next);
          }),
        };
        slot = s;
        slots.set(run.id, s);
      }
      slot.latest = run;
      slot.pacer.request();
    },
    close(): void {
      for (const slot of slots.values()) slot.pacer.cancel();
      slots.clear();
    },
  };
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new BadRequest('body must be JSON');
  }
}

function parseStartRun(body: unknown): StartRunRequest {
  const b = object(body);
  if (!MODES.includes(b.mode as RunMode)) throw new BadRequest(`mode must be one of ${MODES}`);
  const req: StartRunRequest = { mode: b.mode as RunMode, prompt: prompt(b) };
  if (req.mode === 'new') {
    if (typeof b.cwd !== 'string' || !isAbsolute(b.cwd))
      throw new BadRequest('cwd must be an absolute path');
    req.cwd = b.cwd;
  } else {
    if (typeof b.sessionId !== 'string' || b.sessionId === '')
      throw new BadRequest(`sessionId is required for ${req.mode}`);
    // Runs drive the claude CLI, which can only continue its own sessions.
    if (!b.sessionId.startsWith('claude-code:'))
      throw new BadRequest(
        "Only Claude Code sessions can be continued; other agents' sessions are view-only",
      );
    req.sessionId = b.sessionId;
  }
  if (b.permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(b.permissionMode as RunPermissionMode))
      throw new BadRequest(`permissionMode must be one of ${PERMISSION_MODES}`);
    req.permissionMode = b.permissionMode as RunPermissionMode;
  }
  if (b.model !== undefined) {
    if (typeof b.model !== 'string' || b.model === '')
      throw new BadRequest('model must be a string');
    req.model = b.model;
  }
  if (b.effort !== undefined) {
    if (!EFFORTS.includes(b.effort as RunEffort))
      throw new BadRequest(`effort must be one of ${EFFORTS}`);
    req.effort = b.effort as RunEffort;
  }
  return req;
}

function parseDecision(body: unknown): PermissionDecision {
  const b = object(body);
  if (b.decision !== 'allow' && b.decision !== 'deny')
    throw new BadRequest('decision must be "allow" or "deny"');
  const d: PermissionDecision = { decision: b.decision };
  if (b.answers !== undefined) {
    const answers = object(b.answers, 'answers');
    for (const v of Object.values(answers)) {
      const ok =
        typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
      if (!ok) throw new BadRequest('answers must map questions to a label or labels');
    }
    d.answers = answers as Record<string, string | string[]>;
  }
  if (b.message !== undefined) {
    if (typeof b.message !== 'string') throw new BadRequest('message must be a string');
    d.message = b.message;
  }
  return d;
}

function prompt(body: unknown): string {
  const p = object(body).prompt;
  if (typeof p !== 'string' || p.trim() === '')
    throw new BadRequest('prompt must be non-empty text');
  return p;
}

function object(value: unknown, name = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new BadRequest(`${name} must be a JSON object`);
  return value as Record<string, unknown>;
}

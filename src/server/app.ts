import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { stream, streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type {
  ApiErrorResponse,
  QuotaResponse,
  RateResponse,
  ServerEvent,
  SessionsResponse,
  TokenResponse,
  ToolResultResponse,
} from '../shared/protocol.js';
import type { WeekLine } from '../shared/week.js';
import { jsonResponse, toJson } from './json.js';
import type { ClientCounter } from './run-reaper.js';
import type { RunService } from './run-service.js';
import { registerRunRoutes, runEventPacer } from './runs-routes.js';
import { createSecurity, type Security, securityHeaders } from './security.js';
import type { SessionStore } from './store.js';
import { WeekService, type WeekStore } from './week.js';

/** Prompts and permission answers are small; nothing the UI sends comes near this. */
const MAX_BODY_BYTES = 1024 * 1024;

export type AppStore = Pick<
  SessionStore,
  | 'listSessions'
  | 'getSnapshot'
  | 'getRequestDetail'
  | 'getToolResult'
  | 'onSessions'
  | 'onPatch'
  | 'listQuotas'
  | 'onQuota'
  | 'getRate'
  | 'onRate'
  | 'expectSession'
> &
  Partial<WeekStore>;

export interface AppDeps {
  store: AppStore;
  /** Built web UI. Without it only the API is served (dev uses Vite's server). */
  staticDir?: string;
  /** Defaults to a fresh token; pass one to share it with other parts of the server. */
  security?: Security;
  /** Runs started from the UI; null when no `claude` binary was found (routes answer 503). */
  runs?: RunService | null;
  /** Counts event-stream connections, for closing runs nobody watches. */
  clients?: ClientCounter;
  heartbeatMs?: number;
  /** How long a stream waits for an unknown `?session=` before sending `session-missing`. */
  sessionWaitMs?: number;
  /** The weekly receipt's data; by default read from `store` when it can list and read sessions. */
  week?: WeekService | null;
  log?: (msg: string) => void;
}

export function createApp(deps: AppDeps): Hono {
  const { store, staticDir } = deps;
  const security = deps.security ?? createSecurity();
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const sessionWaitMs = deps.sessionWaitMs ?? 30_000;
  const log = deps.log ?? ((msg: string) => console.error(`[glassbox] ${msg}`));
  const app = new Hono();
  const fail = (c: Context, status: 400 | 404 | 500, error: string) =>
    jsonResponse<ApiErrorResponse>(c, { error }, status);
  const { weekSessions, readSession } = store;
  const week =
    deps.week !== undefined
      ? deps.week
      : weekSessions && readSession
        ? new WeekService(
            { weekSessions: weekSessions.bind(store), readSession: readSession.bind(store) },
            { log },
          )
        : null;

  // Outermost, so early answers (403s, 404s, errors) carry the headers too.
  app.use('*', securityHeaders);
  app.use('/api/*', security.middleware);
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        jsonResponse<ApiErrorResponse>(c, { error: 'request body too large (max 1 MB)' }, 413),
    }),
  );

  app.get('/api/token', (c) => jsonResponse<TokenResponse>(c, { token: security.token }));

  app.get('/api/quota', (c) => jsonResponse<QuotaResponse>(c, { quotas: store.listQuotas() }));
  app.get('/api/rate', (c) => jsonResponse<RateResponse>(c, { rate: store.getRate() }));

  app.get('/api/sessions', (c) => jsonResponse<SessionsResponse>(c, store.listSessions()));

  app.get('/api/sessions/:id', async (c) => {
    const snapshot = await store.getSnapshot(c.req.param('id'));
    return snapshot ? jsonResponse(c, snapshot) : fail(c, 404, 'session not found');
  });

  app.get('/api/sessions/:id/requests/:requestId/detail', async (c) => {
    const detail = await store.getRequestDetail(c.req.param('id'), c.req.param('requestId'));
    return detail ? jsonResponse(c, detail) : fail(c, 404, 'request not found');
  });

  app.get('/api/sessions/:id/tool-calls/:toolCallId/result', async (c) => {
    const toolCallId = c.req.param('toolCallId');
    const { found, result } = await store.getToolResult(c.req.param('id'), toolCallId);
    return found
      ? jsonResponse<ToolResultResponse>(c, { toolCallId, result })
      : fail(c, 404, 'tool call not found');
  });

  // NDJSON: progress lines, then the result (see src/shared/week.ts). The reading goes on if the
  // client leaves: the next open is served from it.
  app.get('/api/week', (c) => {
    if (!week) return fail(c, 404, 'not found');
    const kind = c.req.query('window') ?? 'week';
    if (kind !== 'week' && kind !== '7d') return fail(c, 400, 'window must be week or 7d');
    const refresh = c.req.query('refresh') === '1';
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return stream(c, async (out) => {
      let queue = Promise.resolve();
      const write = (line: WeekLine) => {
        queue = queue
          .then(() => (out.aborted ? undefined : out.write(`${toJson(line)}\n`)))
          .then(() => {})
          .catch(() => {});
      };
      try {
        const result = await week.compute(kind, { refresh }, write);
        write({ type: 'result', result });
      } catch (err) {
        log(`week (${kind}) failed: ${errorText(err)}`);
        write({ type: 'error', error: errorText(err) });
      }
      await queue;
    });
  });

  app.get('/api/events', (c) => {
    const sessionId = c.req.query('session');
    return streamSSE(c, async (stream) => {
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      const cleanups: (() => void)[] = [];
      // One write at a time, in the order events were produced.
      let queue = Promise.resolve();
      const send = (e: ServerEvent) => {
        queue = queue
          .then(() =>
            stream.aborted ? undefined : stream.writeSSE({ event: e.type, data: toJson(e) }),
          )
          .catch(() => {});
      };
      try {
        const leave = deps.clients?.join();
        if (leave) cleanups.push(leave);
        cleanups.push(store.onSessions((sessions) => send({ type: 'sessions', sessions })));
        send({ type: 'sessions', sessions: store.listSessions() });
        cleanups.push(store.onQuota((quotas) => send({ type: 'quota', quotas })));
        send({ type: 'quota', quotas: store.listQuotas() });
        cleanups.push(store.onRate((rate) => send({ type: 'rate', rate })));
        send({ type: 'rate', rate: store.getRate() });
        if (deps.runs) {
          const pacer = runEventPacer((run) => send({ type: 'run', run }));
          cleanups.push(deps.runs.onRun((run) => pacer.push(run)));
          cleanups.push(() => pacer.close());
          // A tab opened later still sees pending permission prompts.
          for (const run of deps.runs.list()) pacer.push(run);
        }
        /** Sends the snapshot and subscribes to patches; false while the session is unknown. */
        const attach = async (id: string): Promise<boolean> => {
          const snapshot = await store.getSnapshot(id);
          if (!snapshot || stream.aborted) return false;
          // Subscribe in the same tick the snapshot was taken: every later patch is at least
          // as new as the snapshot, and none falls in between.
          cleanups.push(
            store.onPatch(
              id,
              (patch) => send({ type: 'patch', sessionId: id, patch }),
              (rebuilt) => send({ type: 'snapshot', sessionId: id, snapshot: rebuilt }),
            ),
          );
          send({ type: 'snapshot', sessionId: id, snapshot });
          return true;
        };
        /**
         * An unknown id is usually a session being created right now (a run started from the
         * UI): wait for discovery to find it, say so if it doesn't in time, and still attach
         * if it turns up later.
         */
        const awaitSession = async (id: string): Promise<void> => {
          const found = await Promise.race([
            store.expectSession(id, sessionWaitMs),
            closed.then(() => false),
          ]);
          if (stream.aborted || (found && (await attach(id))) || stream.aborted) return;
          send({ type: 'session-missing', sessionId: id });
          let attaching = false;
          const off = store.onSessions((list) => {
            if (attaching || !list.some((s) => s.id === id)) return;
            attaching = true;
            void attach(id).then((ok) => {
              attaching = false;
              if (ok) off();
            });
          });
          cleanups.push(off);
        };
        if (sessionId && !(await attach(sessionId)) && !stream.aborted) {
          void awaitSession(sessionId).catch((err) =>
            log(`event stream for ${sessionId} failed: ${errorText(err)}`),
          );
        }
        const heartbeat = setInterval(
          () => send({ type: 'heartbeat', now: new Date().toISOString() }),
          heartbeatMs,
        );
        cleanups.push(() => clearInterval(heartbeat));
        await closed;
      } catch (err) {
        log(`event stream${sessionId ? ` for ${sessionId}` : ''} failed: ${errorText(err)}`);
      } finally {
        for (const cleanup of cleanups) cleanup();
      }
    });
  });

  registerRunRoutes(app, { runs: deps.runs ?? null, listSessions: () => store.listSessions() });

  app.all('/api/*', (c) => fail(c, 404, 'not found'));

  if (staticDir) {
    app.use('*', serveStatic({ root: staticDir }));
    // A built file that is not there (a chunk of an older build, after an upgrade) is a 404, not
    // the page: a script or font that gets HTML back fails in a way no retry can recover from.
    app.all('/assets/*', (c) => c.notFound());
    app.all('/fonts/*', (c) => c.notFound());
    // Client-side routes all render the single page.
    app.get('*', async (c) => c.html(await readFile(join(staticDir, 'index.html'), 'utf8')));
  }

  app.notFound((c) => fail(c, 404, 'not found'));
  app.onError((err, c) => {
    // Client errors (bad body, unknown run, run busy, …) carry their HTTP status.
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 600 && status !== 500)
      return jsonResponse<ApiErrorResponse>(
        c,
        { error: errorText(err) },
        status as ContentfulStatusCode,
      );
    log(`${c.req.method} ${c.req.path} failed: ${errorText(err)}`);
    return fail(c, 500, errorText(err));
  });

  return app;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

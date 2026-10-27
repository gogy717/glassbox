import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { stream, streamSSE } from 'hono/streaming';
import { MAIN_AGENT_ID } from '../core/model.js';
import { RULES_WINDOWS } from '../shared/permissions.js';
import { jsonResponse, toJson } from './json.js';
import { registerRunRoutes, runEventPacer } from './runs-routes.js';
import { createSecurity, securityHeaders } from './security.js';
/** Prompts and permission answers are small; nothing the UI sends comes near this. */
const MAX_BODY_BYTES = 1024 * 1024;
export function createApp(deps) {
    const { store, staticDir } = deps;
    const security = deps.security ?? createSecurity();
    const heartbeatMs = deps.heartbeatMs ?? 15_000;
    const sessionWaitMs = deps.sessionWaitMs ?? 30_000;
    const log = deps.log ?? ((msg) => console.error(`[glassbox] ${msg}`));
    const app = new Hono();
    const fail = (c, status, error) => jsonResponse(c, { error }, status);
    const week = deps.week !== undefined ? deps.week : (store.week ?? null);
    const rules = deps.rules !== undefined ? deps.rules : (store.rules ?? null);
    // Outermost, so early answers (403s, 404s, errors) carry the headers too.
    app.use('*', securityHeaders);
    app.use('/api/*', security.middleware);
    app.use('/api/*', bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => jsonResponse(c, { error: 'request body too large (max 1 MB)' }, 413),
    }));
    app.get('/api/token', (c) => jsonResponse(c, { token: security.token }));
    app.get('/api/quota', (c) => jsonResponse(c, { quotas: store.listQuotas() }));
    app.get('/api/rate', (c) => jsonResponse(c, { rate: store.getRate() }));
    app.get('/api/sessions', (c) => jsonResponse(c, store.listSessions()));
    app.get('/api/sessions/:id', async (c) => {
        const snapshot = await store.getSnapshot(c.req.param('id'));
        return snapshot ? jsonResponse(c, snapshot) : fail(c, 404, 'session not found');
    });
    app.get('/api/sessions/:id/requests/:requestId/detail', async (c) => {
        const detail = await store.getRequestDetail(c.req.param('id'), c.req.param('requestId'));
        return detail ? jsonResponse(c, detail) : fail(c, 404, 'request not found');
    });
    app.get('/api/sessions/:id/context', async (c) => {
        const agentId = c.req.query('agent') || MAIN_AGENT_ID;
        const bill = await store.getContextBill(c.req.param('id'), agentId);
        return bill ? jsonResponse(c, bill) : fail(c, 404, 'session not found');
    });
    app.get('/api/sessions/:id/tool-calls/:toolCallId/result', async (c) => {
        const toolCallId = c.req.param('toolCallId');
        const { found, result } = await store.getToolResult(c.req.param('id'), toolCallId);
        return found
            ? jsonResponse(c, { toolCallId, result })
            : fail(c, 404, 'tool call not found');
    });
    // NDJSON: progress lines, then the result (see src/shared/week.ts). The reading goes on if the
    // client leaves: the next open is served from it.
    app.get('/api/week', (c) => {
        if (!week)
            return fail(c, 404, 'not found');
        const kind = c.req.query('window') ?? 'week';
        if (kind !== 'week' && kind !== '7d')
            return fail(c, 400, 'window must be week or 7d');
        const refresh = c.req.query('refresh') === '1';
        c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
        c.header('Cache-Control', 'no-store');
        return stream(c, async (out) => {
            let queue = Promise.resolve();
            const write = (line) => {
                queue = queue
                    .then(() => (out.aborted ? undefined : out.write(`${toJson(line)}\n`)))
                    .then(() => { })
                    .catch(() => { });
            };
            try {
                const result = await week.compute(kind, { refresh }, write);
                write({ type: 'result', result });
            }
            catch (err) {
                log(`week (${kind}) failed: ${errorText(err)}`);
                write({ type: 'error', error: errorText(err) });
            }
            await queue;
        });
    });
    // NDJSON as the week's: progress lines, then the result (see src/shared/permissions.ts).
    app.get('/api/rules', (c) => {
        if (!rules)
            return fail(c, 404, 'not found');
        const kind = c.req.query('window') ?? '30d';
        if (!RULES_WINDOWS.includes(kind))
            return fail(c, 400, 'window must be 7d, 30d or all');
        const refresh = c.req.query('refresh') === '1';
        c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
        c.header('Cache-Control', 'no-store');
        return stream(c, async (out) => {
            let queue = Promise.resolve();
            const write = (line) => {
                queue = queue
                    .then(() => (out.aborted ? undefined : out.write(`${toJson(line)}\n`)))
                    .then(() => { })
                    .catch(() => { });
            };
            try {
                const result = await rules.compute(kind, { refresh }, write);
                write({ type: 'result', result });
            }
            catch (err) {
                log(`rules (${kind}) failed: ${errorText(err)}`);
                write({ type: 'error', error: errorText(err) });
            }
            await queue;
        });
    });
    app.get('/api/events', (c) => {
        const sessionId = c.req.query('session');
        return streamSSE(c, async (stream) => {
            const closed = new Promise((resolve) => stream.onAbort(resolve));
            const cleanups = [];
            // One write at a time, in the order events were produced.
            let queue = Promise.resolve();
            const send = (e) => {
                queue = queue
                    .then(() => stream.aborted ? undefined : stream.writeSSE({ event: e.type, data: toJson(e) }))
                    .catch(() => { });
            };
            try {
                const leave = deps.clients?.join();
                if (leave)
                    cleanups.push(leave);
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
                    for (const run of deps.runs.list())
                        pacer.push(run);
                }
                /** Sends the snapshot and subscribes to patches; false while the session is unknown. */
                const attach = async (id) => {
                    const snapshot = await store.getSnapshot(id);
                    if (!snapshot || stream.aborted)
                        return false;
                    // Subscribe in the same tick the snapshot was taken: every later patch is at least
                    // as new as the snapshot, and none falls in between.
                    cleanups.push(store.onPatch(id, (patch) => send({ type: 'patch', sessionId: id, patch }), (rebuilt) => send({ type: 'snapshot', sessionId: id, snapshot: rebuilt })));
                    send({ type: 'snapshot', sessionId: id, snapshot });
                    return true;
                };
                /**
                 * An unknown id is usually a session being created right now (a run started from the
                 * UI): wait for discovery to find it, say so if it doesn't in time, and still attach
                 * if it turns up later.
                 */
                const awaitSession = async (id) => {
                    const found = await Promise.race([
                        store.expectSession(id, sessionWaitMs),
                        closed.then(() => false),
                    ]);
                    if (stream.aborted || (found && (await attach(id))) || stream.aborted)
                        return;
                    send({ type: 'session-missing', sessionId: id });
                    let attaching = false;
                    const off = store.onSessions((list) => {
                        if (attaching || !list.some((s) => s.id === id))
                            return;
                        attaching = true;
                        void attach(id).then((ok) => {
                            attaching = false;
                            if (ok)
                                off();
                        });
                    });
                    cleanups.push(off);
                };
                if (sessionId && !(await attach(sessionId)) && !stream.aborted) {
                    void awaitSession(sessionId).catch((err) => log(`event stream for ${sessionId} failed: ${errorText(err)}`));
                }
                const heartbeat = setInterval(() => send({ type: 'heartbeat', now: new Date().toISOString() }), heartbeatMs);
                cleanups.push(() => clearInterval(heartbeat));
                await closed;
            }
            catch (err) {
                log(`event stream${sessionId ? ` for ${sessionId}` : ''} failed: ${errorText(err)}`);
            }
            finally {
                for (const cleanup of cleanups)
                    cleanup();
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
        const status = err.status;
        if (typeof status === 'number' && status >= 400 && status < 600 && status !== 500)
            return jsonResponse(c, { error: errorText(err) }, status);
        log(`${c.req.method} ${c.req.path} failed: ${errorText(err)}`);
        return fail(c, 500, errorText(err));
    });
    return app;
}
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=app.js.map
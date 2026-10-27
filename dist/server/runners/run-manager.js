/**
 * Runs: glassbox-owned `claude` processes driven over the stream-json control protocol, as
 * Claude Code 2.1.308 was observed to speak it:
 * - stdin takes `user` messages (the next one after the previous turn's `result`) and our
 *   `control_request`s: `initialize` (answered with `claude_code_version`) and `interrupt`;
 * - stdout brings `system/init` at the start of every turn (the first place the session id
 *   appears), `stream_event`s wrapping raw API stream events, Claude Code's own
 *   `control_request`s, and one `result` per turn (an error when `is_error` is true, whatever
 *   its `subtype`); unknown kinds are ignored;
 * - with `--permission-prompt-tool=stdio` every permission prompt is a `can_use_tool` request,
 *   answered by a `control_response` with the same `request_id`: `allow` with `updatedInput`
 *   (the input, plus `answers` for AskUserQuestion) or `deny` with a `message`.
 * A run spans several user messages; this module only tracks what the transcript cannot show
 * yet — streaming output and pending permission prompts.
 */
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { redact, tildeHome } from '../../core/redact.js';
import { glassboxDenial } from '../../shared/permissions.js';
import { capDepth } from '../json.js';
import { applyStreamEvent } from './partial.js';
/** A client error; `message` is shown to the user as is. */
export class RunError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'RunError';
    }
}
const BASE_ARGS = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool=stdio',
];
/** ≤ 20 `run` events per second per run while output streams. */
const MIN_EMIT_MS = 50;
const INTERRUPT_TIMEOUT_MS = 5000;
/** Answered prompts kept per run (contract: at most 200). */
const DECIDED_MAX = 200;
/** Runs not yet closed or failed, each a `claude` process. */
const LIVE_RUNS_MAX = 8;
/** Largest message, in UTF-8 bytes. */
const PROMPT_MAX_BYTES = 200 * 1024;
const isLive = (status) => status !== 'closed' && status !== 'error';
function checkPrompt(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim())
        throw new RunError(400, 'The message cannot be empty');
    if (Buffer.byteLength(prompt, 'utf8') > PROMPT_MAX_BYTES)
        throw new RunError(400, 'The message is too long (200 KB max)');
}
/** Upper bound for initialization however chatty the hooks are (Claude Code hooks: ≤ 60 s each). */
const INIT_CAP_MS = 120_000;
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/** Model ids and aliases, e.g. "claude-opus-5-5", "opus", "claude-opus-5-5[1m]"; never a flag. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,99}$/;
const CLOSE_GRACE_MS = 5000;
const obj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
const str = (v) => (typeof v === 'string' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export class RunManager {
    opts;
    runs = new Map();
    listeners = new Set();
    now;
    controlSeq = 0;
    constructor(opts) {
        this.opts = opts;
        this.now = opts.now ?? (() => new Date());
    }
    async start(req) {
        const bin = this.opts.claudeBin;
        if (!bin)
            throw new RunError(503, 'The claude command was not found');
        const prompt = typeof req.prompt === 'string' ? req.prompt : '';
        checkPrompt(prompt);
        if (req.permissionMode !== undefined && !PERMISSION_MODES.has(req.permissionMode))
            throw new RunError(400, 'Unsupported permission mode');
        if (req.effort !== undefined && !EFFORTS.has(req.effort))
            throw new RunError(400, 'Unsupported effort level');
        if (req.model !== undefined && (typeof req.model !== 'string' || !MODEL.test(req.model)))
            throw new RunError(400, 'Invalid model name');
        let cwd;
        let resume = [];
        let sessionId = null;
        if (req.mode === 'new') {
            cwd = req.cwd ?? '';
            if (!isAbsolute(cwd) || !(await isDirectory(cwd)))
                throw new RunError(400, 'The working directory does not exist or is not an absolute path');
        }
        else if (req.mode === 'resume' || req.mode === 'fork') {
            const session = req.sessionId ? this.opts.resolveSession(req.sessionId) : null;
            if (!session)
                throw new RunError(404, 'Session not found');
            if (req.mode === 'resume' && session.live !== 'closed')
                throw new RunError(409, 'This session is running in a terminal and cannot be continued directly; use “Continue in a copy” instead');
            if (!session.cwd || !(await isDirectory(session.cwd)))
                throw new RunError(400, "This session's working directory no longer exists");
            cwd = session.cwd;
            resume =
                req.mode === 'fork'
                    ? ['--resume', session.nativeId, '--fork-session']
                    : ['--resume', session.nativeId];
            // A resumed session keeps its id; a fork's new id arrives with system/init.
            if (req.mode === 'resume')
                sessionId = `claude-code:${session.nativeId}`;
        }
        else
            throw new RunError(400, 'Unknown run mode');
        const args = [
            ...BASE_ARGS,
            '--permission-mode',
            req.permissionMode ?? 'default',
            '--setting-sources',
            'user,project,local',
            ...(req.model ? ['--model', req.model] : []),
            ...(req.effort ? ['--effort', req.effort] : []),
            ...resume,
        ];
        // Checked after the awaits above, right before spawning: two clicks cannot both pass.
        if (req.mode === 'resume' &&
            [...this.runs.values()].some((r) => r.state.sessionId === sessionId && isLive(r.state.status)))
            throw new RunError(409, 'This session is already being continued in glassbox; send your message in that run');
        if ([...this.runs.values()].filter((r) => isLive(r.state.status)).length >= LIVE_RUNS_MAX)
            throw new RunError(429, 'Too many sessions running at once');
        const at = this.now().toISOString();
        const id = `run-${randomUUID()}`;
        const proc = this.opts.spawn({ bin, cwd, args, env: this.opts.env });
        const run = {
            state: {
                id,
                sessionId,
                cwd,
                mode: req.mode,
                status: 'starting',
                permissionMode: req.permissionMode ?? 'default',
                startedAt: at,
                updatedAt: at,
                pendingPermissions: [],
                decidedPermissions: [],
                partial: null,
                error: null,
                last: null,
            },
            proc,
            permissions: new Map(),
            initRequestId: this.nextControlId('init'),
            initTimer: null,
            initDeadline: Date.now() + INIT_CAP_MS,
            initialized: false,
            firstPrompt: prompt,
            statusBeforePermission: 'running',
            version: null,
            closing: false,
            interrupting: false,
            interrupts: new Map(),
            lastEmit: 0,
            emitTimer: null,
        };
        this.runs.set(id, run);
        proc.onMessage((m) => this.receive(run, m));
        proc.onExit((info) => this.onExit(run, info));
        proc.send({
            type: 'control_request',
            request_id: run.initRequestId,
            request: { subtype: 'initialize' },
        });
        this.armInitTimer(run);
        this.emit(run);
        return structuredClone(run.state);
    }
    send(runId, prompt) {
        const run = this.get(runId);
        if (run.state.status === 'closed' || run.state.status === 'error')
            throw new RunError(409, 'This run has ended; start a new one');
        if (run.state.status !== 'idle')
            throw new RunError(409, 'Wait for the current reply to finish');
        checkPrompt(prompt);
        this.sendPrompt(run, prompt);
        this.update(run, { status: 'running', error: null });
    }
    async interrupt(runId) {
        const run = this.get(runId);
        if (!['starting', 'running', 'waiting-permission'].includes(run.state.status))
            return;
        if (run.firstPrompt !== null) {
            // Not sent yet: nothing to stop. The run goes idle once Claude Code has initialized.
            run.firstPrompt = null;
            return;
        }
        const requestId = this.nextControlId('interrupt');
        run.interrupting = true;
        await new Promise((resolve) => {
            const timer = setTimeout(done, INTERRUPT_TIMEOUT_MS);
            timer.unref?.();
            function done() {
                clearTimeout(timer);
                run.interrupts.delete(requestId);
                resolve();
            }
            run.interrupts.set(requestId, done);
            run.proc.send({
                type: 'control_request',
                request_id: requestId,
                request: { subtype: 'interrupt' },
            });
        });
    }
    close(runId) {
        const run = this.get(runId);
        if (run.state.status === 'closed')
            return;
        run.closing = true;
        run.proc.end();
        const timer = setTimeout(() => run.proc.kill(), CLOSE_GRACE_MS);
        timer.unref?.();
    }
    decide(runId, permissionId, d) {
        const run = this.get(runId);
        const pending = run.permissions.get(permissionId);
        if (!pending)
            throw new RunError(404, 'This permission request is no longer open');
        if (!isDecision(d))
            throw new RunError(400, 'Invalid permission decision');
        const { request } = pending;
        let response;
        if (d.decision === 'allow') {
            const input = obj(pending.input);
            response = {
                behavior: 'allow',
                updatedInput: request.questions && d.answers ? { ...input, answers: flattenAnswers(d.answers) } : input,
            };
        }
        else {
            // Said in words the transcript keeps, so Rules reads it as declined after a restart.
            response = { behavior: 'deny', message: glassboxDenial(d.message) };
        }
        run.proc.send({
            type: 'control_response',
            response: { subtype: 'success', request_id: pending.requestId, response },
        });
        this.dropPermission(run, permissionId, d.decision);
    }
    list() {
        return [...this.runs.values()].map((r) => structuredClone(r.state));
    }
    onRun(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    // --- protocol -----------------------------------------------------------------------------
    /** Runs in the child's stdout handler: a message that cannot be handled fails its run only. */
    receive(run, m) {
        try {
            this.onMessage(run, m);
        }
        catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            this.opts.log?.(`run ${run.state.id}: could not handle a message from claude: ${text}`);
            this.fail(run, `Could not handle a message from Claude Code: ${text.slice(0, 200)}`);
        }
    }
    onMessage(run, m) {
        // A failed or closed run is final, whatever the dying process still writes.
        if (run.state.status === 'error' || run.state.status === 'closed')
            return;
        // Still initializing: any output (hook progress) means the CLI is alive, not incompatible.
        if (!run.initialized && run.initTimer)
            this.armInitTimer(run);
        switch (m.type) {
            case 'control_response':
                this.onControlResponse(run, obj(m.response));
                break;
            case 'control_request':
                this.onControlRequest(run, str(m.request_id) ?? '', obj(m.request));
                break;
            case 'control_cancel_request': {
                const requestId = str(m.request_id);
                for (const [id, p] of run.permissions)
                    if (p.requestId === requestId)
                        this.dropPermission(run, id, 'cancelled');
                break;
            }
            case 'system':
                if (m.subtype === 'init' && typeof m.session_id === 'string')
                    this.update(run, {
                        sessionId: `claude-code:${m.session_id}`,
                        ...(run.state.status === 'starting' ? { status: 'running' } : {}),
                    });
                break;
            case 'stream_event': {
                // Sub-agents stream too; the live partial is the main agent's reply only.
                if (typeof m.parent_tool_use_id === 'string')
                    break;
                const partial = applyStreamEvent(run.state.partial, m.event, this.now().toISOString());
                if (partial !== run.state.partial)
                    this.update(run, { partial }, { throttle: true });
                break;
            }
            case 'result':
                this.onResult(run, m);
                break;
            default:
                // assistant / user echoes, rate_limit_event, hooks, unknown kinds: the transcript has them.
                break;
        }
    }
    onControlResponse(run, r) {
        const requestId = str(r.request_id);
        if (requestId === run.initRequestId && !run.initialized) {
            if (run.initTimer)
                clearTimeout(run.initTimer);
            run.initTimer = null;
            run.initialized = true;
            if (r.subtype !== 'success') {
                this.incompatible(run);
                return;
            }
            // Only the version is kept: the response also carries the user's account details.
            run.version = str(obj(r.response).claude_code_version);
            for (const pending of Array.isArray(r.pending_permission_requests)
                ? r.pending_permission_requests
                : []) {
                const p = obj(pending);
                this.onControlRequest(run, str(p.request_id) ?? '', obj(p.request));
            }
            if (run.firstPrompt !== null) {
                this.sendPrompt(run, run.firstPrompt);
                run.firstPrompt = null;
            }
            else if (run.state.status === 'starting')
                this.update(run, { status: 'idle' });
            return;
        }
        if (requestId)
            run.interrupts.get(requestId)?.();
    }
    onControlRequest(run, requestId, req) {
        if (req.subtype !== 'can_use_tool') {
            run.proc.send({
                type: 'control_response',
                response: {
                    subtype: 'error',
                    request_id: requestId,
                    error: `glassbox does not support ${String(req.subtype)}`,
                },
            });
            this.incompatible(run);
            return;
        }
        const toolName = str(req.tool_name) ?? '?';
        const id = str(req.tool_use_id) ?? requestId;
        const input = req.input ?? {};
        const request = {
            id,
            toolName,
            // Kept in the run state, which is cloned and streamed: bounded like every response.
            input: capDepth(input),
            questions: toolName === 'AskUserQuestion' ? parseQuestions(obj(input).questions) : null,
            requestedAt: this.now().toISOString(),
        };
        if (run.state.status !== 'waiting-permission')
            run.statusBeforePermission = run.state.status;
        run.permissions.set(id, { requestId, request, input });
        this.update(run, {
            status: 'waiting-permission',
            pendingPermissions: [...run.permissions.values()].map((p) => p.request),
        });
    }
    onResult(run, m) {
        const aborted = run.interrupting;
        run.interrupting = false;
        const decidedPermissions = this.withdrawAll(run);
        this.update(run, {
            status: 'idle',
            partial: null,
            pendingPermissions: [],
            decidedPermissions,
            error: m.is_error === true && !aborted ? turnError(m) : null,
            last: {
                costUsd: num(m.total_cost_usd),
                durationMs: num(m.duration_ms),
                numTurns: num(m.num_turns),
            },
        });
    }
    onExit(run, info) {
        if (run.initTimer)
            clearTimeout(run.initTimer);
        run.initTimer = null;
        for (const done of run.interrupts.values())
            done();
        const decidedPermissions = this.withdrawAll(run);
        const clean = run.closing || (info.code === 0 && run.state.status === 'idle');
        const already = run.state.status === 'error' ? run.state.error : null;
        this.update(run, {
            status: clean && !already ? 'closed' : 'error',
            partial: null,
            pendingPermissions: [],
            decidedPermissions,
            error: clean && !already ? null : (already ?? exitError(info)),
        });
    }
    /** The CLI does not speak the protocol this module expects: fail fast, never hang. */
    incompatible(run) {
        this.fail(run, `This Claude Code version's streaming protocol is incompatible (version ${run.version ?? 'unknown'})`);
    }
    /** Ends the run in error, withdrawing open prompts, and stops its process. */
    fail(run, error) {
        if (run.state.status === 'error' || run.state.status === 'closed')
            return;
        if (run.initTimer)
            clearTimeout(run.initTimer);
        run.initTimer = null;
        run.firstPrompt = null;
        const decidedPermissions = this.withdrawAll(run);
        this.update(run, {
            status: 'error',
            partial: null,
            pendingPermissions: [],
            decidedPermissions,
            error,
        });
        run.proc.kill();
    }
    // --- state --------------------------------------------------------------------------------
    sendPrompt(run, prompt) {
        run.interrupting = false;
        run.proc.send({
            type: 'user',
            message: { role: 'user', content: prompt },
            parent_tool_use_id: null,
        });
    }
    dropPermission(run, id, decision) {
        const pending = run.permissions.get(id);
        run.permissions.delete(id);
        const pendingPermissions = [...run.permissions.values()].map((p) => p.request);
        this.update(run, {
            pendingPermissions,
            decidedPermissions: this.settled(run, pending ? [pending.request] : [], decision),
            ...(pendingPermissions.length === 0 && run.state.status === 'waiting-permission'
                ? { status: run.statusBeforePermission }
                : {}),
        });
    }
    /** Answered prompts, oldest first, at most `DECIDED_MAX`, with these appended. */
    settled(run, requests, decision) {
        const decidedAt = this.now().toISOString();
        return [
            ...(run.state.decidedPermissions ?? []),
            ...requests.map((r) => ({
                id: r.id,
                toolName: r.toolName,
                requestedAt: r.requestedAt,
                decidedAt,
                decision,
            })),
        ].slice(-DECIDED_MAX);
    }
    /** The turn or the process ended with prompts still open: they were withdrawn. */
    withdrawAll(run) {
        const open = [...run.permissions.values()].map((p) => p.request);
        run.permissions.clear();
        return this.settled(run, open, 'cancelled');
    }
    get(runId) {
        const run = this.runs.get(runId);
        if (!run)
            throw new RunError(404, 'Run not found');
        return run;
    }
    nextControlId(kind) {
        this.controlSeq += 1;
        return `glassbox-${kind}-${this.controlSeq}`;
    }
    update(run, change, opts = {}) {
        // A run's error reaches every view of it (Home, the sidebar, the composer): masked once, here,
        // as activity targets are, with the home directory as ~.
        if (change.error)
            change = { ...change, error: tildeHome(redact(change.error)) };
        run.state = { ...run.state, ...change, updatedAt: this.now().toISOString() };
        this.emit(run, opts.throttle);
    }
    /** Streaming updates are coalesced; anything else goes out at once (with what was pending). */
    emit(run, throttle = false) {
        const t = Date.now();
        if (throttle && t - run.lastEmit < MIN_EMIT_MS) {
            run.emitTimer ??= setTimeout(() => {
                run.emitTimer = null;
                this.emit(run);
            }, MIN_EMIT_MS - (t - run.lastEmit));
            return;
        }
        if (run.emitTimer)
            clearTimeout(run.emitTimer);
        run.emitTimer = null;
        run.lastEmit = t;
        const state = structuredClone(run.state);
        for (const cb of this.listeners) {
            // A listener bug must not break the child's stream handling or starve other tabs.
            try {
                cb(state);
            }
            catch (err) {
                this.opts.log?.(`run listener failed: ${err.message}`);
            }
        }
    }
    armInitTimer(run) {
        if (run.initTimer)
            clearTimeout(run.initTimer);
        const wait = Math.min(this.opts.initTimeoutMs ?? 10_000, run.initDeadline - Date.now());
        run.initTimer = setTimeout(() => this.incompatible(run), Math.max(0, wait));
        run.initTimer.unref?.();
    }
}
function isDecision(d) {
    const o = obj(d);
    if (o.decision !== 'allow' && o.decision !== 'deny')
        return false;
    if (o.message !== undefined && typeof o.message !== 'string')
        return false;
    if (o.answers === undefined)
        return true;
    const answers = obj(o.answers);
    if (answers !== o.answers)
        return false;
    return Object.values(answers).every((a) => typeof a === 'string' || (Array.isArray(a) && a.every((x) => typeof x === 'string')));
}
async function isDirectory(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch {
        return false;
    }
}
function parseQuestions(v) {
    if (!Array.isArray(v))
        return [];
    return v.map((q) => {
        const o = obj(q);
        return {
            question: str(o.question) ?? '',
            header: str(o.header) ?? '',
            multiSelect: o.multiSelect === true,
            options: (Array.isArray(o.options) ? o.options : []).map((opt) => ({
                label: str(obj(opt).label) ?? '',
                description: str(obj(opt).description) ?? '',
            })),
        };
    });
}
/** AskUserQuestion answers are strings; several picks are joined the way the CLI joins them. */
function flattenAnswers(answers) {
    return Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, Array.isArray(a) ? a.join(', ') : a]));
}
function turnError(m) {
    const text = [str(m.result), ...(Array.isArray(m.errors) ? m.errors.map(str) : [])]
        .filter((s) => !!s?.trim())
        .join('; ');
    if (/not logged in/i.test(text))
        return 'Claude Code is not logged in; run claude in a terminal to log in first';
    return `This turn failed: ${(text || str(m.subtype) || 'unknown error').slice(0, 300)}`;
}
function exitError(info) {
    if (info.error)
        return `Could not start claude: ${info.error}`;
    const last = info.stderrTail.at(-1);
    if (last)
        return last.slice(0, 300);
    return `The claude process exited unexpectedly (${info.code !== null ? `exit code ${info.code}` : `signal ${info.signal}`})`;
}
//# sourceMappingURL=run-manager.js.map
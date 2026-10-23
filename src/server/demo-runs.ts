import { createDemoSessions, DEMO_SESSION_ID } from '../core/fixtures/demo.js';
import type {
  LivePartial,
  PermissionDecision,
  PermissionRequest,
  RunState,
  StartRunRequest,
} from '../shared/runs.js';
import type { RunService } from './run-service.js';

/** One streamed piece every 100 ms: 10 updates/s, inside the protocol's 20/s. */
const STEP_MS = 100;
const START_MS = 300;
/** Claude Code streams thinking as a token estimate only (no text): +40 every 200 ms here. */
const THINK_STEP_MS = 200;
const THINK_STEP_TOKENS = 40;

const INTRO = 'Let me run the test suite to see where things stand.';
const AFTER_ALLOW = 'All 89 tests pass. Before I change anything, two quick questions.';
const AFTER_DENY = "OK, I won't run the tests. Two quick questions instead.";
const BASH_JSON = ['{"command": "', 'npm test', '", "description": ', '"Run the test suite"}'];

const QUESTIONS = [
  {
    question: 'Which part should I improve next?',
    header: 'Next step',
    multiSelect: false,
    options: [
      { label: 'Session list', description: 'Sorting and grouping in the sidebar' },
      { label: 'Token view', description: 'Charts of where tokens go' },
      { label: 'Time view', description: 'Swimlane timeline per agent' },
    ],
  },
  {
    question: 'Which checks should run before every commit?',
    header: 'Checks',
    multiSelect: true,
    options: [
      { label: 'Type check', description: 'tsc --noEmit' },
      { label: 'Lint', description: 'biome check' },
      { label: 'Tests', description: 'vitest run' },
    ],
  },
];

const ABORTED = Symbol('aborted');

interface Live {
  state: RunState;
  abort: AbortController;
  /** permission id → resolves the prompt the script is waiting on */
  waiters: Map<string, (d: PermissionDecision) => void>;
}

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * A scripted RunService for `--demo`: no `claude` process, but the same states, partial
 * stream and permission prompts the real runner produces, so the composer, the live overlay
 * and the permission dialogs can be built against it.
 */
export class DemoRuns implements RunService {
  private readonly lives = new Map<string, Live>();
  private readonly listeners = new Set<(r: RunState) => void>();
  private serial = 0;

  async start(req: StartRunRequest): Promise<RunState> {
    if (req.mode !== 'new') {
      const session = createDemoSessions().find((s) => s.id === req.sessionId);
      if (!session) throw statusError(404, 'session not found');
      if (req.mode === 'resume' && session.live !== 'closed')
        throw statusError(
          409,
          'This session is running elsewhere; use “Continue in a copy” instead',
        );
    }
    const now = new Date().toISOString();
    const id = `demo-run-${++this.serial}`;
    const live: Live = {
      state: {
        id,
        sessionId: null,
        cwd: req.cwd ?? '/Users/demo/Dev/glassbox',
        mode: req.mode,
        status: 'starting',
        permissionMode: req.permissionMode ?? 'default',
        startedAt: now,
        updatedAt: now,
        pendingPermissions: [],
        partial: null,
        error: null,
        last: null,
      },
      abort: new AbortController(),
      waiters: new Map(),
    };
    this.lives.set(id, live);
    this.emit(live);
    void this.firstTurn(live);
    return structuredClone(live.state);
  }

  send(runId: string, prompt: string): void {
    const live = this.get(runId);
    if (live.state.status !== 'idle')
      throw statusError(409, 'Wait for the current reply to finish');
    live.state.status = 'running';
    this.emit(live);
    void this.followUp(live, prompt);
  }

  async interrupt(runId: string): Promise<void> {
    const live = this.get(runId);
    if (live.state.status === 'idle' || live.state.status === 'closed') return;
    this.cancel(live);
    Object.assign(live.state, { status: 'idle', partial: null, pendingPermissions: [] });
    this.emit(live);
  }

  close(runId: string): void {
    const live = this.get(runId);
    this.cancel(live);
    Object.assign(live.state, { status: 'closed', partial: null, pendingPermissions: [] });
    this.emit(live);
  }

  decide(runId: string, permissionId: string, d: PermissionDecision): void {
    const live = this.get(runId);
    const resolve = live.waiters.get(permissionId);
    if (!resolve) throw statusError(404, 'permission request not found');
    live.waiters.delete(permissionId);
    live.state.pendingPermissions = live.state.pendingPermissions.filter(
      (p) => p.id !== permissionId,
    );
    live.state.status = 'running';
    this.emit(live);
    resolve(d);
  }

  list(): RunState[] {
    return [...this.lives.values()].map((l) => structuredClone(l.state));
  }

  onRun(cb: (r: RunState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Ends every scripted run and forgets listeners (server shutdown). */
  stop(): void {
    for (const live of this.lives.values()) this.cancel(live);
    this.listeners.clear();
  }

  // ── Scripts ─────────────────────────────────────────────────────────────────────────

  private async firstTurn(live: Live): Promise<void> {
    const began = Date.now();
    try {
      await this.sleep(live, START_MS);
      // Demo mode has one session with data; runs land there so the UI can navigate to it.
      Object.assign(live.state, { status: 'running', sessionId: DEMO_SESSION_ID });
      this.emit(live);
      await this.stream(live, { thinkSteps: 8, text: INTRO, tool: ['Bash', BASH_JSON] });
      const bash = await this.ask(live, {
        id: `toolu_demo_bash_${live.state.id}`,
        toolName: 'Bash',
        input: { command: 'npm test', description: 'Run the test suite' },
        questions: null,
      });
      const ask = chunks(JSON.stringify({ questions: QUESTIONS }), 6);
      await this.stream(live, {
        text: bash.decision === 'allow' ? AFTER_ALLOW : AFTER_DENY,
        tool: ['AskUserQuestion', ask],
      });
      const answer = await this.ask(live, {
        id: `toolu_demo_ask_${live.state.id}`,
        toolName: 'AskUserQuestion',
        input: { questions: QUESTIONS },
        questions: QUESTIONS,
      });
      const picked = Object.values(answer.answers ?? {})
        .flat()
        .join(', ');
      await this.stream(live, { text: `Noted: ${picked || 'no preference'}. Starting now.` });
      this.finish(live, began, 3);
    } catch (err) {
      if (err !== ABORTED) this.fail(live, err);
    }
  }

  private async followUp(live: Live, prompt: string): Promise<void> {
    const began = Date.now();
    try {
      await this.stream(live, {
        thinkSteps: 3,
        text: `You said: "${prompt.slice(0, 60)}". Done.`,
      });
      this.finish(live, began, 1);
    } catch (err) {
      if (err !== ABORTED) this.fail(live, err);
    }
  }

  /** One streamed assistant message: thinking, then text, then an optional tool call. */
  private async stream(
    live: Live,
    parts: { thinkSteps?: number; text?: string; tool?: [string, string[]] },
  ): Promise<void> {
    const partial: LivePartial = {
      messageId: `msg_demo_${++this.serial}`,
      startedAt: new Date().toISOString(),
      thinking: '',
      thinkingTokens: parts.thinkSteps ? 0 : null,
      text: '',
      toolUses: [],
    };
    live.state.partial = partial;
    this.emit(live);
    for (let i = 0; i < (parts.thinkSteps ?? 0); i++) {
      await this.sleep(live, THINK_STEP_MS);
      partial.thinkingTokens = (partial.thinkingTokens ?? 0) + THINK_STEP_TOKENS;
      this.emit(live);
    }
    for (const word of words(parts.text)) {
      await this.sleep(live, STEP_MS);
      partial.text += word;
      this.emit(live);
    }
    if (parts.tool) {
      const [name, chunks] = parts.tool;
      const use = { id: `toolu_demo_${++this.serial}`, name, inputJson: '' };
      partial.toolUses.push(use);
      for (const chunk of chunks) {
        await this.sleep(live, STEP_MS);
        use.inputJson += chunk;
        this.emit(live);
      }
    }
    await this.sleep(live, STEP_MS);
    live.state.partial = null;
    this.emit(live);
  }

  private ask(
    live: Live,
    req: Omit<PermissionRequest, 'requestedAt'>,
  ): Promise<PermissionDecision> {
    live.state.pendingPermissions.push({ ...req, requestedAt: new Date().toISOString() });
    live.state.status = 'waiting-permission';
    this.emit(live);
    const { signal } = live.abort;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        live.waiters.delete(req.id);
        reject(ABORTED);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      live.waiters.set(req.id, (d) => {
        signal.removeEventListener('abort', onAbort);
        resolve(d);
      });
    });
  }

  private sleep(live: Live, ms: number): Promise<void> {
    const { signal } = live.abort;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(ABORTED);
      const onAbort = () => {
        clearTimeout(timer);
        reject(ABORTED);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private finish(live: Live, began: number, numTurns: number): void {
    const durationMs = Date.now() - began;
    Object.assign(live.state, {
      status: 'idle',
      partial: null,
      last: { costUsd: Math.round(durationMs / 10) / 1000, durationMs, numTurns },
    });
    this.emit(live);
  }

  private fail(live: Live, err: unknown): void {
    Object.assign(live.state, {
      status: 'error',
      partial: null,
      error: err instanceof Error ? err.message : String(err),
    });
    this.emit(live);
  }

  /** Stops the current script; a later `send` starts a fresh one. */
  private cancel(live: Live): void {
    live.abort.abort();
    live.abort = new AbortController();
    live.waiters.clear();
  }

  private emit(live: Live): void {
    live.state.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(live.state);
    for (const cb of this.listeners) cb(snapshot);
  }

  private get(runId: string): Live {
    const live = this.lives.get(runId);
    if (!live) throw statusError(404, 'run not found');
    return live;
  }
}

/** `text` cut into `n` roughly equal pieces, as input_json deltas arrive. */
function chunks(text: string, n: number): string[] {
  const size = Math.ceil(text.length / n);
  return Array.from({ length: n }, (_, i) => text.slice(i * size, (i + 1) * size)).filter(Boolean);
}

/** Words with their trailing space, so concatenating them rebuilds the text. */
function words(text: string | undefined): string[] {
  return text ? (text.match(/\S+\s*/g) ?? []) : [];
}

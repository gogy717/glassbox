import { createDemoSnapshot, DEMO_SESSION_ID } from '../../../src/core/fixtures/demo.js';
import type { RunState } from '../../../src/shared/runs.js';
import type { Approvals } from '../data/approvals';
import { createStore, type OpenSession } from '../data/store';

/** Fixed clock for tests; the demo fixture places its in-flight work relative to it. */
export const DEMO_NOW = new Date('2026-10-23T10:00:00.000Z');

export function demoStore(now: Date = DEMO_NOW) {
  const snapshot = createDemoSnapshot(now);
  const store = createStore();
  store.openSession(snapshot.session.id);
  store.applyEvent({ type: 'snapshot', sessionId: snapshot.session.id, snapshot });
  return store;
}

export function demoOpen(now: Date = DEMO_NOW): OpenSession {
  return demoStore(now).getState().open as OpenSession;
}

/** The demo with one tool call turned back into a running one, e.g. blocked on a permission prompt. */
export function withRunningTool(open: OpenSession, toolId: string): OpenSession {
  const tool = open.toolCalls.get(toolId);
  if (!tool) throw new Error(`no tool ${toolId}`);
  const running = { ...tool, status: 'running' as const, endedAt: null, durationMs: null };
  return { ...open, toolCalls: new Map(open.toolCalls).set(toolId, running) };
}

/** Approval windows for tools whose permission prompt is still open (from the tool's start). */
export const pendingFor = (...ids: string[]): Approvals =>
  new Map(ids.map((id) => [id, { requestedAt: 0, decidedAt: null }]));

/** A glassbox run of the demo session with nothing going on; override what a test needs. */
export function testRun(over: Partial<RunState>): RunState {
  return {
    id: 'run_1',
    sessionId: DEMO_SESSION_ID,
    cwd: '/w/demo',
    mode: 'fork',
    status: 'idle',
    permissionMode: 'default',
    startedAt: DEMO_NOW.toISOString(),
    updatedAt: DEMO_NOW.toISOString(),
    pendingPermissions: [],
    partial: null,
    error: null,
    last: null,
    ...over,
  };
}

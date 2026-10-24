import { describe, expect, it, vi } from 'vitest';
import {
  createDemoQuota,
  createDemoSessions,
  createDemoSnapshot,
} from '../../../src/core/fixtures/demo.js';
import type { ModelRequest, SessionPatch, SessionSnapshot, Turn } from '../../../src/core/model.js';
import type { RunState } from '../../../src/shared/runs.js';
import { createStore } from './store';

const NOW = new Date('2026-10-23T10:00:00.000Z');
const snap = (): SessionSnapshot => createDemoSnapshot(NOW);
const SID = snap().session.id;

function emptyPatch(s: SessionSnapshot, over: Partial<SessionPatch> = {}): SessionPatch {
  return {
    session: s.session,
    agents: [],
    turns: [],
    requests: [],
    toolCalls: [],
    workflows: [],
    diagnostics: null,
    ...over,
  };
}

function openedStore() {
  const store = createStore();
  store.openSession(SID);
  store.applyEvent({ type: 'snapshot', sessionId: SID, snapshot: snap() });
  return store;
}

describe('createStore', () => {
  it('starts connecting with nothing loaded', () => {
    const s = createStore().getState();
    expect(s).toMatchObject({ sessions: [], connection: 'connecting', openId: null, open: null });
  });

  it('keeps the latest plan quota', () => {
    const store = createStore();
    expect(store.getState().quotas).toEqual([]);
    store.applyEvent({ type: 'quota', quotas: [createDemoQuota(NOW)] });
    expect(store.getState().quotas[0]?.windows.map((w) => w.id)).toEqual([
      'five_hour',
      'seven_day',
      'weekly:Opus',
    ]);
  });

  it('keeps glassbox-owned runs by id, updating them as run events arrive', () => {
    const store = createStore();
    const run = {
      id: 'run_1',
      sessionId: null,
      status: 'starting',
      updatedAt: '2026-10-23T10:00:00.000Z',
    } as unknown as RunState;
    store.applyEvent({ type: 'run', run });
    store.applyEvent({ type: 'run', run: { ...run, sessionId: SID, status: 'running' } });
    store.applyEvent({ type: 'run', run: { ...run, id: 'run_2' } });
    const runs = store.getState().runs;
    expect([...runs.keys()]).toEqual(['run_1', 'run_2']);
    expect(runs.get('run_1')).toMatchObject({ sessionId: SID, status: 'running' });
  });

  it('knows whether the session list has arrived yet, even when it is empty', () => {
    const store = createStore();
    expect(store.getState().sessionsLoaded).toBe(false);
    store.applyEvent({ type: 'sessions', sessions: [] });
    expect(store.getState().sessionsLoaded).toBe(true);
  });

  it('replaces the session list on a sessions event', () => {
    const store = createStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(NOW) });
    expect(store.getState().sessions.map((s) => s.title)).toEqual([
      'Live viewer research (demo)',
      'Fix flaky login test',
      null,
    ]);
  });

  it('loads a snapshot for the open session into id maps', () => {
    const open = openedStore().getState().open;
    expect(open?.id).toBe(SID);
    expect(open?.agents.size).toBe(5);
    expect(open?.turns.size).toBe(7);
    expect(open?.requests.get('req_m6')?.status).toBe('in-flight');
    expect(open?.toolCalls.get('tu_m2b')?.status).toBe('error');
    expect(open?.workflows.get('wf_demo0001-abc')?.name).toBe('cc-recon');
  });

  it('ignores a snapshot for a session that is not open', () => {
    const store = createStore();
    store.openSession('claude-code:other');
    store.applyEvent({ type: 'snapshot', sessionId: SID, snapshot: snap() });
    expect(store.getState().open).toBeNull();
  });

  it('upserts patched entities and keeps the rest', () => {
    const store = openedStore();
    const s = snap();
    const done: ModelRequest = {
      ...(s.requests.find((r) => r.id === 'req_m6') as ModelRequest),
      status: 'complete',
      endedAt: NOW.toISOString(),
    };
    store.applyEvent({
      type: 'patch',
      sessionId: SID,
      patch: emptyPatch(s, { requests: [done] }),
    });
    const open = store.getState().open;
    expect(open?.requests.get('req_m6')?.status).toBe('complete');
    expect(open?.requests.get('req_m1')?.status).toBe('complete');
    expect(open?.requests.size).toBe(s.requests.length);
  });

  it('accepts a request before its turn and links them once the turn arrives', () => {
    const store = openedStore();
    const s = snap();
    const req: ModelRequest = {
      ...(s.requests[0] as ModelRequest),
      id: 'req_new',
      turnId: 'turn_new',
      index: 1,
    };
    store.applyEvent({ type: 'patch', sessionId: SID, patch: emptyPatch(s, { requests: [req] }) });
    expect(store.getState().open?.requests.get('req_new')?.turnId).toBe('turn_new');
    expect(store.getState().open?.turns.has('turn_new')).toBe(false);

    const turn: Turn = {
      ...(s.turns[0] as Turn),
      id: 'turn_new',
      index: 4,
      requestIds: ['req_new'],
    };
    store.applyEvent({ type: 'patch', sessionId: SID, patch: emptyPatch(s, { turns: [turn] }) });
    expect(store.getState().open?.turns.get('turn_new')?.requestIds).toEqual(['req_new']);
  });

  it('deletes entities a patch removes, after applying its upserts', () => {
    const store = openedStore();
    const s = snap();
    const ghost: ModelRequest = {
      ...(s.requests.find((r) => r.id === 'req_m6') as ModelRequest),
      id: 'req_ghost',
      index: 2,
    };
    store.applyEvent({
      type: 'patch',
      sessionId: SID,
      patch: emptyPatch(s, { requests: [ghost] }),
    });
    expect(store.getState().open?.requests.get('req_ghost')?.status).toBe('in-flight');
    store.applyEvent({
      type: 'patch',
      sessionId: SID,
      patch: emptyPatch(s, { removed: { requests: ['req_ghost'], toolCalls: ['tu_m1a'] } }),
    });
    const open = store.getState().open;
    expect(open?.requests.has('req_ghost')).toBe(false);
    expect(open?.toolCalls.has('tu_m1a')).toBe(false);
    expect(open?.requests.has('req_m6')).toBe(true);
  });

  it('ignores removal of ids it never had', () => {
    const store = openedStore();
    const before = store.getState().open?.requests;
    store.applyEvent({
      type: 'patch',
      sessionId: SID,
      patch: emptyPatch(snap(), { removed: { requests: ['nope'] } }),
    });
    expect(store.getState().open?.requests).toBe(before);
  });

  it('keeps diagnostics when a patch carries none and replaces them when it does', () => {
    const store = openedStore();
    const s = snap();
    store.applyEvent({ type: 'patch', sessionId: SID, patch: emptyPatch(s) });
    expect(store.getState().open?.diagnostics.parseErrors).toBe(0);
    const diagnostics = { unknownRecordTypes: { foo: 2 }, parseErrors: 1, unavailable: [] };
    store.applyEvent({ type: 'patch', sessionId: SID, patch: emptyPatch(s, { diagnostics }) });
    expect(store.getState().open?.diagnostics).toEqual(diagnostics);
  });

  it('updates the open session summary and its row in the list from a patch', () => {
    const store = openedStore();
    store.applyEvent({ type: 'sessions', sessions: createDemoSessions(NOW) });
    const s = snap();
    const session = { ...s.session, live: 'idle' as const };
    store.applyEvent({ type: 'patch', sessionId: SID, patch: emptyPatch(s, { session }) });
    expect(store.getState().open?.session.live).toBe('idle');
    expect(store.getState().sessions[0]?.live).toBe('idle');
    expect(store.getState().sessions[1]?.live).toBe('idle');
    expect(store.getState().sessions[2]?.live).toBe('closed');
  });

  it('ignores patches for a session that is not open, or that arrive before its snapshot', () => {
    const store = createStore();
    store.openSession(SID);
    const s = snap();
    store.applyEvent({
      type: 'patch',
      sessionId: SID,
      patch: emptyPatch(s, { requests: s.requests }),
    });
    expect(store.getState().open).toBeNull();
    store.applyEvent({ type: 'snapshot', sessionId: SID, snapshot: s });
    store.applyEvent({
      type: 'patch',
      sessionId: 'claude-code:other',
      patch: emptyPatch(s, { requests: [{ ...(s.requests[0] as ModelRequest), id: 'x' }] }),
    });
    expect(store.getState().open?.requests.has('x')).toBe(false);
  });

  it('discards the old session when another one is opened', () => {
    const store = openedStore();
    store.openSession('claude-code:other');
    expect(store.getState()).toMatchObject({ openId: 'claude-code:other', open: null });
  });

  it('keeps the loaded session when the same session is opened again', () => {
    const store = openedStore();
    const before = store.getState().open;
    store.openSession(SID);
    expect(store.getState().open).toBe(before);
  });

  it('notifies subscribers on change only, and stops after unsubscribe', () => {
    const store = createStore();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.applyEvent({ type: 'heartbeat', now: NOW.toISOString() });
    expect(fn).not.toHaveBeenCalled();
    store.setConnection('open');
    expect(fn).toHaveBeenCalledTimes(1);
    store.setConnection('open');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    store.setConnection('reconnecting');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.getState().connection).toBe('reconnecting');
  });

  it('produces a new state object on every change so React re-renders', () => {
    const store = openedStore();
    const before = store.getState();
    const s = snap();
    store.applyEvent({ type: 'patch', sessionId: SID, patch: emptyPatch(s, { requests: [] }) });
    const after = store.getState();
    expect(after).not.toBe(before);
    expect(after.open?.requests).toBe(before.open?.requests);
  });
});

describe('session-missing', () => {
  it('marks the open session missing, ignores other ids, and clears when its snapshot arrives', () => {
    const store = createStore();
    store.openSession(SID);
    store.applyEvent({ type: 'session-missing', sessionId: 'claude-code:other' });
    expect(store.getState().missingId).toBeNull();
    store.applyEvent({ type: 'session-missing', sessionId: SID });
    expect(store.getState().missingId).toBe(SID);
    store.applyEvent({ type: 'snapshot', sessionId: SID, snapshot: snap() });
    expect(store.getState().missingId).toBeNull();
    expect(store.getState().open?.id).toBe(SID);
  });

  it('forgets a missing mark when another session is opened', () => {
    const store = createStore();
    store.openSession(SID);
    store.applyEvent({ type: 'session-missing', sessionId: SID });
    store.openSession('claude-code:other');
    expect(store.getState().missingId).toBeNull();
  });
});

describe('token rate', () => {
  it('reaches rate subscribers only: a push does not re-render the page', () => {
    const store = createStore();
    const page = vi.fn();
    const instruments = vi.fn();
    store.subscribe(page);
    store.subscribeRate(instruments);
    const rate = {
      minute: '2026-10-24T10:00:00.000Z',
      at: '2026-10-24T10:00:05.000Z',
      since: '2026-10-24T09:00:00.000Z',
      agents: {},
      coverage: { running: 0, counted: 0, agents: {} },
    };
    store.applyEvent({ type: 'rate', rate });
    expect(instruments).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
    expect(store.getRate()).toBe(rate);
  });
});

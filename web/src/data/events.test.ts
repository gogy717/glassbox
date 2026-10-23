import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDemoQuota,
  createDemoSessions,
  createDemoSnapshot,
} from '../../../src/core/fixtures/demo.js';
import type { ServerEvent, ServerEventType } from '../../../src/shared/protocol.js';
import type { RunState } from '../../../src/shared/runs.js';
import { connectEvents } from './events';
import { createStore } from './store';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event('open'));
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
  send(e: ServerEvent) {
    this.raw(e.type, JSON.stringify(e));
  }
  raw(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data }));
  }
}

const NOW = new Date('2026-10-23T10:00:00.000Z');
const SID = createDemoSnapshot(NOW).session.id;
const latest = () => FakeEventSource.instances.at(-1) as FakeEventSource;
const ES = FakeEventSource as unknown as typeof EventSource;

describe('connectEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it('subscribes to the session stream and marks the connection open', () => {
    const store = createStore();
    connectEvents(store, SID, { EventSource: ES });
    expect(latest().url).toBe(`/api/events?session=${encodeURIComponent(SID)}`);
    expect(store.getState().connection).toBe('connecting');
    latest().open();
    expect(store.getState().connection).toBe('open');
  });

  it('subscribes to the session list only when no session is open', () => {
    connectEvents(createStore(), null, { EventSource: ES });
    expect(latest().url).toBe('/api/events');
  });

  it('feeds named server events into the store', () => {
    const store = createStore();
    store.openSession(SID);
    connectEvents(store, SID, { EventSource: ES });
    latest().send({ type: 'snapshot', sessionId: SID, snapshot: createDemoSnapshot(NOW) });
    expect(store.getState().open?.requests.size).toBe(28);
  });

  it('delivers every kind of server event to the store', () => {
    const snapshot = createDemoSnapshot(NOW);
    // A Record keyed by every ServerEventType: adding an event type breaks this until it is listed.
    const samples: Record<ServerEventType, ServerEvent> = {
      sessions: { type: 'sessions', sessions: createDemoSessions(NOW) },
      snapshot: { type: 'snapshot', sessionId: SID, snapshot },
      patch: {
        type: 'patch',
        sessionId: SID,
        patch: { ...snapshot, diagnostics: null },
      },
      quota: { type: 'quota', quotas: [createDemoQuota(NOW)] },
      run: { type: 'run', run: { id: 'run_1' } as unknown as RunState },
      'session-missing': { type: 'session-missing', sessionId: SID },
      heartbeat: { type: 'heartbeat', now: NOW.toISOString() },
    };
    const store = createStore();
    const seen: string[] = [];
    const apply = store.applyEvent;
    store.applyEvent = (e) => {
      seen.push(e.type);
      apply(e);
    };
    connectEvents(store, SID, { EventSource: ES });
    for (const e of Object.values(samples)) latest().send(e);
    expect(seen).toEqual(Object.keys(samples));
    expect(store.getState().quotas).toHaveLength(1);
  });

  it('ignores a message that is not valid JSON', () => {
    const store = createStore();
    connectEvents(store, SID, { EventSource: ES });
    expect(() => latest().raw('sessions', '{oops')).not.toThrow();
    expect(store.getState().sessions).toEqual([]);
  });

  it('reconnects with exponential backoff capped at 30 s', () => {
    const store = createStore();
    connectEvents(store, SID, { EventSource: ES });
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const es = latest();
      es.fail();
      expect(es.closed).toBe(true);
      expect(store.getState().connection).toBe('reconnecting');
      const before = FakeEventSource.instances.length;
      let waited = 0;
      while (FakeEventSource.instances.length === before) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('replaces stale state with the snapshot sent after a reconnect', () => {
    const store = createStore();
    store.openSession(SID);
    connectEvents(store, SID, { EventSource: ES });
    const first = createDemoSnapshot(NOW);
    latest().send({ type: 'snapshot', sessionId: SID, snapshot: first });
    latest().fail();
    vi.advanceTimersByTime(1000);
    const fresh = { ...first, requests: first.requests.filter((r) => r.id !== 'req_m6') };
    latest().open();
    latest().send({ type: 'snapshot', sessionId: SID, snapshot: fresh });
    expect(store.getState().open?.requests.has('req_m6')).toBe(false);
    expect(store.getState().connection).toBe('open');
  });

  it('resets the backoff once a connection opens', () => {
    const store = createStore();
    connectEvents(store, SID, { EventSource: ES });
    latest().fail();
    vi.advanceTimersByTime(1000);
    latest().fail();
    vi.advanceTimersByTime(2000);
    latest().open();
    latest().fail();
    const before = FakeEventSource.instances.length;
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances.length).toBe(before + 1);
  });

  it('treats a silent connection (no heartbeat for 45 s) as dropped', () => {
    const store = createStore();
    connectEvents(store, SID, { EventSource: ES });
    const es = latest();
    es.open();
    vi.advanceTimersByTime(30_000);
    es.send({ type: 'heartbeat', now: NOW.toISOString() });
    vi.advanceTimersByTime(30_000);
    expect(es.closed).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(es.closed).toBe(true);
    expect(store.getState().connection).toBe('reconnecting');
  });

  it('closes the stream and cancels pending reconnects on disconnect', () => {
    const store = createStore();
    const disconnect = connectEvents(store, SID, { EventSource: ES });
    latest().fail();
    disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    const again = connectEvents(store, SID, { EventSource: ES });
    again();
    expect(latest().closed).toBe(true);
  });
});

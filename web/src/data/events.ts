import { api, type ServerEvent, type ServerEventType } from '../../../src/shared/protocol.js';
import type { Store } from './store';

/**
 * Every SSE event name we listen for. Keyed by ServerEventType so the compiler rejects a missing
 * (or unknown) type: an unlisted event is silently dropped by EventSource, which is how `quota`
 * and `run` once went missing.
 */
const LISTENED: Record<ServerEventType, true> = {
  sessions: true,
  snapshot: true,
  patch: true,
  quota: true,
  rate: true,
  run: true,
  'session-missing': true,
  heartbeat: true,
};
const EVENT_TYPES = Object.keys(LISTENED) as ServerEventType[];
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** The server sends a heartbeat every 15 s; three missed ones mean the stream is dead. */
const SILENCE_LIMIT_MS = 45_000;

export interface ConnectOptions {
  EventSource?: typeof EventSource;
}

/**
 * Keeps one SSE stream open for `sessionId` (or just the session list), feeding the store.
 * Browsers' built-in EventSource retry gives up on some failures and has no backoff, so
 * every error closes the stream and we reconnect ourselves. Returns a disconnect function.
 */
export function connectEvents(
  store: Store,
  sessionId: string | null,
  opts: ConnectOptions = {},
): () => void {
  const Impl = opts.EventSource ?? globalThis.EventSource;
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = BACKOFF_START_MS;
  let stopped = false;

  const clearTimers = () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
    retryTimer = silenceTimer = null;
  };

  const drop = () => {
    es?.close();
    es = null;
    clearTimers();
    if (stopped) return;
    store.setConnection('reconnecting');
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  };

  const armSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(drop, SILENCE_LIMIT_MS);
  };

  const onMessage = (m: MessageEvent) => {
    armSilence();
    let event: ServerEvent;
    try {
      event = JSON.parse(m.data as string) as ServerEvent;
    } catch {
      return;
    }
    store.applyEvent(event);
  };

  function connect() {
    retryTimer = null;
    const source = new Impl(api.events(sessionId ?? undefined));
    es = source;
    source.onopen = () => {
      backoff = BACKOFF_START_MS;
      store.setConnection('open');
      armSilence();
    };
    source.onerror = drop;
    for (const type of EVENT_TYPES) source.addEventListener(type, onMessage);
  }

  connect();
  return () => {
    stopped = true;
    clearTimers();
    es?.close();
    es = null;
  };
}

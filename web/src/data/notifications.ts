/** Desktop notifications when a session begins to wait for you (the "Notify me" setting). */
import { useEffect, useRef } from 'react';
import type { SessionSummary } from '../../../src/core/model.js';
import type { T } from '../i18n';
import { waitingSince, waitLabel } from '../lib/waiting';

/** The browser's answer so far, or that it offers no notifications at all. */
export type NotifyState = NotificationPermission | 'unsupported';

export const notifyState = (): NotifyState =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

/**
 * Asks the browser once, when it has not been asked; it remembers a refusal, and asking again
 * would only be ignored. Resolves to the answer.
 */
export async function askToNotify(): Promise<NotifyState> {
  const state = notifyState();
  if (state !== 'default') return state;
  try {
    // Older Safari takes a callback and returns nothing: read the answer back then.
    return (await Notification.requestPermission()) ?? notifyState();
  } catch {
    return 'denied';
  }
}

export interface NeedsYouOptions {
  /** The setting is on and the browser allows it. */
  enabled: boolean;
  /** The sessions waiting for you, as the board lists them (hidden probes left out). */
  waiting: SessionSummary[];
  /** The session list has arrived: before that, nothing is known. */
  loaded: boolean;
  t: T;
  onOpen(sessionId: string): void;
}

/**
 * One notification per session that begins to wait for you, with its project and title and
 * what it waits for ("Permission · Bash"); silent. None on page load: what already waits when
 * the list arrives, or began to wait before then (a glassbox run's prompt replayed after the
 * list), is not news. Never twice for the same wait, and none while the setting is off, with no
 * catching up when it is turned on. A click focuses the tab and opens the session; a wait that
 * ends takes its notification with it.
 */
export function useNeedsYouNotifications({
  enabled,
  waiting,
  loaded,
  t,
  onOpen,
}: NeedsYouOptions): void {
  // The sessions seen waiting, each with its notification while one shows; null until the list
  // first arrives, which is when "before the page loaded" ends.
  const seen = useRef<Map<string, Notification | null> | null>(null);
  const loadedAt = useRef(0);
  const latest = useRef({ t, onOpen });
  latest.current = { t, onOpen };

  useEffect(() => {
    if (!loaded) return;
    if (seen.current === null) {
      seen.current = new Map(waiting.map((s) => [s.id, null]));
      loadedAt.current = Date.now();
      return;
    }
    const next = new Map<string, Notification | null>();
    for (const s of waiting) {
      if (seen.current.has(s.id)) next.set(s.id, seen.current.get(s.id) ?? null);
      else next.set(s.id, enabled ? show(s, loadedAt.current, latest.current) : null);
    }
    for (const [id, n] of seen.current) if (!next.has(id)) n?.close();
    seen.current = next;
  }, [waiting, loaded, enabled]);
}

/** The notification for `s`, or null when its wait began before the page loaded. */
function show(
  s: SessionSummary,
  loadedAt: number,
  { t, onOpen }: { t: T; onOpen(sessionId: string): void },
): Notification | null {
  const since = waitingSince(s);
  if (since !== null && Date.parse(since) < loadedAt) return null;
  try {
    const n = new Notification(`${s.project} / ${s.title ?? t('sidebar.untitled')}`, {
      body: waitLabel(t, s.activity),
      // One per session: a later wait of the same session replaces an earlier one still shown.
      tag: s.id,
      silent: true,
    });
    n.onclick = () => {
      window.focus();
      onOpen(s.id);
      n.close();
    };
    return n;
  } catch {
    // The browser refused (permission withdrawn since): nothing to show.
    return null;
  }
}

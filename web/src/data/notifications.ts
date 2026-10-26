/**
 * Desktop notifications when a session begins to wait for you or to look stuck (the "Notify
 * me" setting).
 */
import { useEffect, useRef } from 'react';
import type { SessionSummary, TroubleKind, TroubleSignal } from '../../../src/core/model.js';
import type { T } from '../i18n';
import { troubleText } from '../lib/trouble';
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
  /**
   * The running sessions, as the board lists them: those whose `trouble` the server has read (a
   * sign, or null for none) are watched for one.
   */
  running: SessionSummary[];
  /** The session list has arrived: before that, nothing is known. */
  loaded: boolean;
  t: T;
  /** Where a click goes: the Inbox at the session's item, in the app. */
  onOpen(sessionId: string): void;
}

/**
 * One notification per session that begins to wait for you, with its project and title and
 * what it waits for ("Permission · Bash"); silent. None on page load: what already waits when
 * the list arrives, or began to wait before then (a glassbox run's prompt replayed after the
 * list), is not news. Never twice for the same wait, and none while the setting is off, with no
 * catching up when it is turned on. A click focuses the tab and hands the session to `onOpen`; a
 * wait that ends takes its notification with it.
 *
 * And one per running session and kind of sign that it looks stuck, the sign at length as its
 * body ("Repeated npm test 4×"): never twice for one kind of one session, none for the sign the
 * server first says of a session (on page load, once it opens one, once one runs again) or
 * while the setting is off. A sign that goes takes its notification with it.
 */
export function useNeedsYouNotifications({
  enabled,
  waiting,
  running,
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

  // Each session's kinds of sign told so far, whether its sign is known now, and the
  // notification of the one it shows.
  const told = useRef(new Map<string, Told>());
  useEffect(() => {
    if (!loaded) return;
    const read = new Map<string, SessionSummary>();
    for (const s of running) if (s.trouble !== undefined) read.set(s.id, s);
    for (const [id, entry] of told.current) {
      const sign = read.get(id)?.trouble;
      // No longer read (it stopped running): what it says next is where it starts again.
      if (!read.has(id)) entry.known = false;
      // A sign that went, or gave way to another kind, takes its notification with it.
      if (entry.shown && sign?.kind !== entry.shown.kind) {
        entry.shown.notification.close();
        entry.shown = null;
      }
    }
    for (const [id, s] of read) {
      const entry = told.current.get(id) ?? { kinds: new Set(), known: false, shown: null };
      told.current.set(id, entry);
      const sign = s.trouble ?? null;
      // The first the server says of a session is not news: on page load, once it opens one in
      // the background, or once one runs again, its sign may be an hour old.
      const news = entry.known;
      entry.known = true;
      if (!sign || entry.kinds.has(sign.kind)) continue;
      entry.kinds.add(sign.kind);
      // Nor is a sign while the setting is off.
      if (!news || !enabled) continue;
      const notification = showStuck(s, sign, latest.current);
      entry.shown = notification && { kind: sign.kind, notification };
    }
  }, [running, loaded, enabled]);
}

/**
 * A session's kinds of sign told so far, whether the server has said its sign since it last
 * ran, and the notification of the one it shows now.
 */
interface Told {
  kinds: Set<TroubleKind>;
  known: boolean;
  shown: { kind: TroubleKind; notification: Notification } | null;
}

/** The notification that `s` looks stuck: the sign at length; one per session and kind. */
function showStuck(
  s: SessionSummary,
  sign: TroubleSignal,
  { t, onOpen }: { t: T; onOpen(sessionId: string): void },
): Notification | null {
  try {
    const n = new Notification(`${s.project} / ${s.title ?? t('sidebar.untitled')}`, {
      body: troubleText(t, sign, Date.now(), 'long'),
      tag: `${s.id}:${sign.kind}`,
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

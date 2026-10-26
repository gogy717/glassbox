/**
 * What the main agent last said (`SessionSummary.lastReply`), worked out from the views a parser
 * already has. Agent-neutral: every adapter passes its live state, its main agent's latest turn
 * and a way to look up that turn's requests, so "last said" means the same for every agent.
 */
import type { LiveState, ModelRequest, Turn } from './model.js';
import { MAIN_AGENT_ID } from './model.js';
import { redact, tildeHome } from './redact.js';

/** How much of the reply the session list carries: a line's worth, and then some. */
export const LAST_REPLY_CHARS = 140;

export interface LastReplyInput {
  live: LiveState;
  /** The main agent's latest turn, if any. */
  lastTurn: Turn | null;
  /** One of that turn's requests by id, as the parser views it; undefined when unknown. */
  request(id: string): ModelRequest | undefined;
}

/**
 * The main agent's latest text in its latest turn, as a summary's optional field: null while
 * that turn has said nothing yet; absent when the session's process is not up (nothing a parser
 * knows is current then), as `activity` is.
 */
export function lastReplyField(input: LastReplyInput): { lastReply?: string | null } {
  const { live, lastTurn } = input;
  if (live !== 'busy' && live !== 'waiting' && live !== 'idle') return {};
  const ids = lastTurn?.requestIds ?? [];
  // Newest first: the turn's latest request that wrote any text has the last word.
  for (let i = ids.length - 1; i >= 0; i--) {
    const r = input.request(ids[i] as string);
    if (!r || r.agentId !== MAIN_AGENT_ID) continue;
    for (let j = r.blocks.length - 1; j >= 0; j--) {
      const b = r.blocks[j];
      if (b?.kind === 'text' && b.text.trim() !== '') return { lastReply: replyStart(b.text) };
    }
  }
  return { lastReply: null };
}

/** `LastReplyInput.request` over a parser's request views: a lookup by id. */
export function requestsById(
  requests: Iterable<ModelRequest>,
): (id: string) => ModelRequest | undefined {
  const byId = new Map<string, ModelRequest>();
  for (const r of requests) byId.set(r.id, r);
  return (id) => byId.get(id);
}

/**
 * The start of a reply, cut at LAST_REPLY_CHARS characters (not UTF-16 units) with "…", its line
 * breaks kept so the page can read its markdown. The session list goes to every client, so it is
 * masked as activity targets are: credentials whole, the home directory as "~". Masking runs
 * before the cut and on whole words: a word the head's end would split is left out, so no part
 * of a credential shows whose whole would have been masked.
 */
function replyStart(text: string): string {
  const s = text.trim();
  let head = s.slice(0, LAST_REPLY_CHARS * 4);
  if (head.length < s.length && /\S/.test(s[head.length] ?? '')) {
    const whole = head.replace(/\S+$/, '');
    if (whole.trim() !== '') head = whole;
  }
  const points = [...tildeHome(redact(head)).trimEnd()];
  return points.length > LAST_REPLY_CHARS || head.length < s.length
    ? `${points.slice(0, LAST_REPLY_CHARS).join('').trimEnd()}…`
    : points.join('');
}

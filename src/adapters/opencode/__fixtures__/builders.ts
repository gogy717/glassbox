/** Synthetic OpenCode database rows. Nothing here is copied from a real database. */
import type { MessageRow, PartRow, SessionDocument, SessionRow } from '../records.js';

export const ROOT_ID = 'ses_0root00000000000000000000';
export const CWD = '/home/user/garden';
export const VERSION = '1.19.4';
export const MODEL = 'free-model-1';

/** Epoch ms `sec` seconds after 2026-01-01T00:00:00Z. */
export function ms(sec: number): number {
  return Date.UTC(2026, 0, 1, 0, 0, 0) + sec * 1000;
}

/** ISO time `sec` seconds after 2026-01-01T00:00:00Z. */
export function at(sec: number): string {
  return new Date(ms(sec)).toISOString();
}

export function tokens(input: number, output: number, reasoning = 0, read = 0, write = 0) {
  return {
    total: input + output + reasoning + read + write,
    input,
    output,
    reasoning,
    cache: { read, write },
  };
}

export const text = (body: string, startSec?: number, endSec?: number) => ({
  type: 'text',
  text: body,
  ...(startSec !== undefined
    ? { time: { start: ms(startSec), ...(endSec !== undefined ? { end: ms(endSec) } : {}) } }
    : {}),
});

export const reasoning = (body: string, startSec: number, endSec?: number) => ({
  type: 'reasoning',
  text: body,
  time: { start: ms(startSec), ...(endSec !== undefined ? { end: ms(endSec) } : {}) },
});

export const stepStart = () => ({ type: 'step-start', snapshot: 'aaaa' });

export const stepFinish = (reason: string, usage: ReturnType<typeof tokens>) => ({
  type: 'step-finish',
  reason,
  snapshot: 'aaaa',
  tokens: usage,
  cost: 0,
});

export function tool(o: {
  callId: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: unknown;
  output?: string;
  error?: string;
  startSec?: number;
  endSec?: number;
  childSessionId?: string;
}) {
  const time =
    o.startSec !== undefined
      ? { start: ms(o.startSec), ...(o.endSec !== undefined ? { end: ms(o.endSec) } : {}) }
      : undefined;
  return {
    type: 'tool',
    tool: o.name,
    callID: o.callId,
    state: {
      status: o.status,
      input: o.input ?? {},
      ...(o.status === 'pending' ? { raw: JSON.stringify(o.input ?? {}) } : {}),
      ...(o.output !== undefined ? { output: o.output, title: o.name } : {}),
      ...(o.error !== undefined ? { error: o.error } : {}),
      metadata: o.childSessionId
        ? { parentSessionId: ROOT_ID, sessionId: o.childSessionId, truncated: false }
        : { truncated: false },
      ...(time ? { time } : {}),
    },
  };
}

/** Session columns to override; times in seconds after the epoch of `ms`. */
export type SessionSpec = Partial<SessionRow> & { createdSec?: number; updatedSec?: number };

/**
 * Accumulates the rows of one session tree the way OpenCode writes them: ids ascend in
 * creation order, and every row records when it was created and last updated.
 */
export class SessionBuilder {
  readonly sessions: SessionRow[] = [];
  readonly messages: MessageRow[] = [];
  readonly parts: PartRow[] = [];
  private seq = 0;

  constructor(root: SessionSpec = {}) {
    this.session({ id: ROOT_ID, ...root });
  }

  private next(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${String(this.seq).padStart(6, '0')}`;
  }

  session(o: SessionSpec = {}): string {
    const { createdSec = 0, updatedSec, ...row } = o;
    const id = row.id ?? this.next('ses');
    this.sessions.push({
      id,
      parent_id: null,
      title: 'Garden chores',
      directory: CWD,
      version: VERSION,
      agent: 'build',
      model: JSON.stringify({ id: MODEL, providerID: 'opencode', variant: 'default' }),
      time_created: ms(createdSec),
      time_updated: ms(updatedSec ?? createdSec),
      time_compacting: null,
      time_archived: null,
      ...row,
    });
    return id;
  }

  user(sessionId: string, atSec: number, ...parts: object[]): string {
    const id = this.next('msg');
    const data = { role: 'user', time: { created: ms(atSec) }, agent: 'build' };
    this.messages.push(row(id, sessionId, atSec, data));
    for (const p of parts) this.part(id, atSec, p, sessionId);
    return id;
  }

  assistant(
    sessionId: string,
    parentId: string,
    atSec: number,
    o: {
      completedSec?: number | null;
      finish?: string;
      tokens?: ReturnType<typeof tokens>;
      error?: { name: string; data: Record<string, unknown> };
      variant?: string;
      summary?: boolean;
      model?: string;
    } = {},
  ): string {
    const id = this.next('msg');
    const completed = o.completedSec === undefined ? atSec + 1 : o.completedSec;
    const data = {
      parentID: parentId,
      role: 'assistant',
      mode: 'build',
      agent: 'build',
      variant: o.variant ?? 'default',
      path: { cwd: CWD, root: CWD },
      cost: 0,
      tokens: o.tokens ?? tokens(0, 0),
      modelID: o.model ?? MODEL,
      providerID: 'opencode',
      time: { created: ms(atSec), ...(completed !== null ? { completed: ms(completed) } : {}) },
      ...(o.finish ? { finish: o.finish } : {}),
      ...(o.error ? { error: o.error } : {}),
      ...(o.summary ? { summary: true } : {}),
    };
    this.messages.push(row(id, sessionId, completed ?? atSec, data, atSec));
    return id;
  }

  part(messageId: string, atSec: number, data: object, sessionId?: string): string {
    const id = this.next('prt');
    const owner = sessionId ?? this.messages.find((m) => m.id === messageId)?.session_id ?? ROOT_ID;
    this.parts.push({
      id,
      message_id: messageId,
      session_id: owner,
      time_created: ms(atSec),
      time_updated: ms(atSec),
      data: JSON.stringify(data),
    });
    return id;
  }

  /** A copy of the rows as the adapter would hand them over. */
  doc(): SessionDocument {
    return {
      sessions: this.sessions.map((s) => ({ ...s })),
      messages: this.messages.map((m) => ({ ...m })),
      parts: this.parts.map((p) => ({ ...p })),
    };
  }
}

function row(
  id: string,
  sessionId: string,
  updatedSec: number,
  data: object,
  createdSec = updatedSec,
): MessageRow {
  return {
    id,
    session_id: sessionId,
    time_created: ms(createdSec),
    time_updated: ms(updatedSec),
    data: JSON.stringify(data),
  };
}

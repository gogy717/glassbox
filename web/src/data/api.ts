import type { SessionSnapshot } from '../../../src/core/model.js';
import {
  type ApiErrorResponse,
  api,
  type RequestDetailResponse,
  type SessionsResponse,
  type ToolResultResponse,
} from '../../../src/shared/protocol.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorResponse | null;
    throw new ApiError(res.status, body?.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

export const fetchSessions = (signal?: AbortSignal) =>
  getJson<SessionsResponse>(api.sessions(), signal);

/** A session as it is now, read once (the open session comes over the event stream instead). */
export const fetchSnapshot = (sessionId: string, signal?: AbortSignal) =>
  getJson<SessionSnapshot>(api.session(sessionId), signal);

export const fetchRequestDetail = (sessionId: string, requestId: string, signal?: AbortSignal) =>
  getJson<RequestDetailResponse>(api.requestDetail(sessionId, requestId), signal);

export const fetchToolResult = (sessionId: string, toolCallId: string, signal?: AbortSignal) =>
  getJson<ToolResultResponse>(api.toolResult(sessionId, toolCallId), signal);

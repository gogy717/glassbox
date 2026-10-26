import {
  type ApiErrorResponse,
  api,
  type ContextBillResponse,
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

export const fetchRequestDetail = (sessionId: string, requestId: string, signal?: AbortSignal) =>
  getJson<RequestDetailResponse>(api.requestDetail(sessionId, requestId), signal);

export const fetchContextBill = (sessionId: string, agentId: string, signal?: AbortSignal) =>
  getJson<ContextBillResponse>(api.contextBill(sessionId, agentId), signal);

export const fetchToolResult = (sessionId: string, toolCallId: string, signal?: AbortSignal) =>
  getJson<ToolResultResponse>(api.toolResult(sessionId, toolCallId), signal);

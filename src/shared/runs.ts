/**
 * Protocol for sending messages from glassbox (B-lite).
 *
 * A "run" is one live Claude Agent SDK query owned by the glassbox server. It can span several
 * user messages. What the run writes to disk still reaches the UI through the normal transcript
 * pipeline; a run only adds what the transcript cannot show yet: streaming partial output and
 * pending permission prompts.
 *
 * CONTRACT: the server and the web UI both depend on this file; change them together.
 */
import type { IsoTime } from '../core/model.js';

/**
 * 'new' starts a fresh session in `cwd`. 'resume' continues a session in place and is only
 * allowed when no other process has it open (live state 'closed'). 'fork' continues a copy
 * under a new session id, so it is safe while a terminal still has the original open.
 */
export type RunMode = 'new' | 'resume' | 'fork';

export type RunPermissionMode = 'default' | 'acceptEdits' | 'plan';

export type RunEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StartRunRequest {
  mode: RunMode;
  /** glassbox session id (`claude-code:<uuid>`). Required for 'resume' and 'fork'. */
  sessionId?: string;
  /** Absolute working directory. Required for 'new'; ignored otherwise. */
  cwd?: string;
  prompt: string;
  permissionMode?: RunPermissionMode;
  model?: string;
  effort?: RunEffort;
}

export interface StartRunResponse {
  run: RunState;
}

export interface SendMessageRequest {
  prompt: string;
}

export interface PermissionDecision {
  decision: 'allow' | 'deny';
  /** AskUserQuestion only: question text → chosen label (or labels when multiSelect). */
  answers?: Record<string, string | string[]>;
  /** Deny only: reason shown to the model. */
  message?: string;
}

export type RunStatus = 'starting' | 'running' | 'waiting-permission' | 'idle' | 'error' | 'closed';

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

export interface PermissionRequest {
  /** The tool-use id the prompt is about. */
  id: string;
  toolName: string;
  input: unknown;
  /** Present when toolName is 'AskUserQuestion'. */
  questions: AskQuestion[] | null;
  requestedAt: IsoTime;
}

/** A permission prompt that has been answered (or withdrawn by Claude Code). */
export interface DecidedPermission {
  /** The tool-use id, as in PermissionRequest.id. */
  id: string;
  toolName: string;
  requestedAt: IsoTime;
  decidedAt: IsoTime;
  decision: 'allow' | 'deny' | 'cancelled';
}

/** The assistant message currently streaming, accumulated from SDK partial events. */
export interface LivePartial {
  messageId: string;
  startedAt: IsoTime;
  /**
   * Accumulated thinking text. Claude Code 2.1.308 streams no thinking text (only an estimate
   * of thinking tokens), so this usually stays empty — show `thinkingTokens` instead.
   */
  thinking: string;
  /** Running estimate of thinking tokens so far (from thinking deltas); null when unknown. */
  thinkingTokens: number | null;
  text: string;
  toolUses: { id: string; name: string; inputJson: string }[];
}

export interface RunState {
  id: string;
  /** glassbox session id, known once Claude Code reports its session id (system/init). */
  sessionId: string | null;
  cwd: string;
  mode: RunMode;
  status: RunStatus;
  permissionMode: RunPermissionMode;
  startedAt: IsoTime;
  updatedAt: IsoTime;
  pendingPermissions: PermissionRequest[];
  /**
   * Prompts already answered in this run, oldest first, at most 200. Lets the UI show how long
   * a tool waited for the user instead of counting that wait as tool time.
   */
  decidedPermissions?: DecidedPermission[];
  partial: LivePartial | null;
  error: string | null;
  /** From the SDK result message of the latest user message. */
  last: { costUsd: number | null; durationMs: number | null; numTurns: number | null } | null;
}

export interface DirectoriesResponse {
  /** Recently used working directories (from known sessions), most recent first. */
  recent: string[];
}

const enc = encodeURIComponent;

/** All POST/DELETE routes require the `TOKEN_HEADER` header (see protocol.ts). */
export const runsApi = {
  /** POST StartRunRequest → StartRunResponse. GET → RunState[]. */
  runs: () => '/api/runs',
  /** POST SendMessageRequest → 204. 409 while the run is not idle. */
  message: (runId: string) => `/api/runs/${enc(runId)}/messages`,
  /** POST → 204. */
  interrupt: (runId: string) => `/api/runs/${enc(runId)}/interrupt`,
  /** DELETE → 204. Ends the run's process. */
  run: (runId: string) => `/api/runs/${enc(runId)}`,
  /** POST PermissionDecision → 204. */
  permission: (runId: string, permissionId: string) =>
    `/api/runs/${enc(runId)}/permissions/${enc(permissionId)}`,
  /** GET → DirectoriesResponse. */
  directories: () => '/api/directories',
} as const;

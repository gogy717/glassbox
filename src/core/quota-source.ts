import type { QuotaSnapshot, QuotaStaleReason } from './model.js';

/**
 * Somewhere plan quotas can be read: an agent's cache, an agent's session log, or a provider's
 * API (unless --no-fetch-quota). The server reads every source and merges them per provider.
 */
export interface QuotaSource {
  /** Stable id for logs, e.g. "claude-code", "oh-my-pi-cache", "deepseek-balance". */
  readonly id: string;
  /** One snapshot per provider this source knows now; [] when none. Rejects only on a real failure. */
  read(): Promise<QuotaSnapshot[]>;
  /** Files whose changes may change `read()`, for the server to watch. */
  watchFiles?(): string[];
}

/** Why a request to a provider got no usable answer, in the words the UI is told. */
export type FetchProblem = Extract<
  QuotaStaleReason,
  'sign-in-expired' | 'no-credentials' | 'fetch-failed'
>;

/** A network fetcher's state, so a stale quota of its provider can say why it is stale. */
export interface FetchStatus {
  /** Why the last request got no answer; null once one has worked, and before the first. */
  problem(): FetchProblem | null;
}

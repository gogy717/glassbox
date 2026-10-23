import type { QuotaSnapshot } from './model.js';

/**
 * Somewhere plan quotas can be read: an agent's cache, an agent's session log, or (only with
 * --fetch-quota) a provider's API. The server reads every source and merges them per provider.
 */
export interface QuotaSource {
  /** Stable id for logs, e.g. "claude-code", "oh-my-pi-cache", "deepseek-balance". */
  readonly id: string;
  /** One snapshot per provider this source knows now; [] when none. Rejects only on a real failure. */
  read(): Promise<QuotaSnapshot[]>;
  /** Files whose changes may change `read()`, for the server to watch. */
  watchFiles?(): string[];
}

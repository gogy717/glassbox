/** Claude Code adapter: the only entry point the rest of glassbox imports. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentAdapter } from '../../core/adapter.js';
import type { QuotaSnapshot } from '../../core/model.js';
import {
  classifyPath,
  type DiscoveryCache,
  discoverSessions,
  listSessionFiles,
  readLiveRegistry,
  sessionWatchDirs,
} from './discovery.js';
import { ClaudeSessionParser } from './parser.js';
import { readQuotaFile } from './quota.js';
import type { QuotaFetcher } from './quota-fetch.js';

export interface ClaudeCodeAdapterOptions {
  /** The Claude config dir: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeDir: string;
  /** Claude Code's global config file; default `~/.claude.json`, or inside a custom config dir. */
  globalConfigPath?: string;
  /** Set with `--fetch-quota`: also ask the usage endpoint, and show whichever quota is newer. */
  quotaFetcher?: QuotaFetcher;
}

export function createClaudeCodeAdapter({
  claudeDir,
  globalConfigPath,
  quotaFetcher,
}: ClaudeCodeAdapterOptions): AgentAdapter {
  const configPath =
    globalConfigPath ??
    (resolve(claudeDir) === join(homedir(), '.claude')
      ? join(homedir(), '.claude.json')
      : join(claudeDir, '.claude.json'));
  // Claude Code rewrites the config file in place; keep the last good read across a mid-write.
  let lastQuota: QuotaSnapshot | null = null;
  const discoveryCache: DiscoveryCache = new Map();

  return {
    kind: 'claude-code',
    discover: async () =>
      discoverSessions(claudeDir, await readLiveRegistry(claudeDir), discoveryCache),
    listFiles: listSessionFiles,
    watchDirs: sessionWatchDirs,
    classify: classifyPath,
    liveStatus: async () => (await readLiveRegistry(claudeDir)).live,
    createParser: (source) => new ClaudeSessionParser(source),
    quota: async () => {
      const read = await readQuotaFile(configPath);
      if (read.kind === 'ok') lastQuota = read.quota;
      const fetched = (await quotaFetcher?.latest()) ?? null;
      if (!fetched || !lastQuota) return fetched ?? lastQuota;
      return Date.parse(fetched.fetchedAt) >= Date.parse(lastQuota.fetchedAt) ? fetched : lastQuota;
    },
    quotaFiles: () => [configPath],
  };
}

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
  /** Set unless `--no-fetch-quota`: also ask the usage endpoint, and show whichever is newer. */
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
  let lastPlan: string | null = null;
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
      if (read.kind === 'ok') {
        lastQuota = read.quota;
        lastPlan = read.plan;
      }
      const fetched = (await quotaFetcher?.latest()) ?? null;
      const newer =
        fetched && lastQuota
          ? Date.parse(fetched.fetchedAt) >= Date.parse(lastQuota.fetchedAt)
            ? fetched
            : lastQuota
          : (fetched ?? lastQuota);
      // The plan as the config's account record names it wins, cache or not, whichever numbers
      // are newer: the sign-in's tier is the one recorded at login and can be outdated.
      return newer && { ...newer, plan: lastPlan ?? newer.plan };
    },
    quotaFiles: () => [configPath],
  };
}

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

export interface ClaudeCodeAdapterOptions {
  /** The Claude config dir: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeDir: string;
  /** Claude Code's global config file; default `~/.claude.json`, or inside a custom config dir. */
  globalConfigPath?: string;
}

export function createClaudeCodeAdapter({
  claudeDir,
  globalConfigPath,
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
      return lastQuota;
    },
    quotaFiles: () => [configPath],
  };
}

/** Claude Code adapter: the only entry point the rest of glassbox imports. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyPath, discoverSessions, listSessionFiles, readLiveRegistry, sessionWatchDirs, } from './discovery.js';
import { ClaudeSessionParser } from './parser.js';
import { readQuotaFile } from './quota.js';
export function createClaudeCodeAdapter({ claudeDir, globalConfigPath, quotaFetcher, }) {
    const configPath = globalConfigPath ??
        (resolve(claudeDir) === join(homedir(), '.claude')
            ? join(homedir(), '.claude.json')
            : join(claudeDir, '.claude.json'));
    // Claude Code rewrites the config file in place; keep the last good read across a mid-write.
    let lastQuota = null;
    let lastPlan = null;
    const discoveryCache = new Map();
    return {
        kind: 'claude-code',
        discover: async () => discoverSessions(claudeDir, await readLiveRegistry(claudeDir), discoveryCache),
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
            const newer = fetched && lastQuota
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
//# sourceMappingURL=index.js.map
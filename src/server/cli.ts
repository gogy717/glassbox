#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createClaudeCodeAdapter } from '../adapters/claude-code/index.js';
import { createQuotaFetcher } from '../adapters/claude-code/quota-fetch.js';
import { createCodexAdapter } from '../adapters/codex/index.js';
import { createGrokAdapter } from '../adapters/grok/index.js';
import { createXaiQuotaSource } from '../adapters/grok/quota-fetch.js';
import { createOmpAdapter } from '../adapters/omp/index.js';
import { createOmpUsageCacheSource } from '../adapters/omp/usage-cache.js';
import { createOpenCodeAdapter } from '../adapters/opencode/index.js';
import type { AgentAdapter } from '../core/adapter.js';
import type { SessionSummary } from '../core/model.js';
import type { QuotaSource } from '../core/quota-source.js';
import { createDeepSeekBalanceSource } from '../quota/deepseek-balance.js';
import { createApp } from './app.js';
import {
  bindWarning,
  browserUrl,
  type CliOptions,
  codexDirToUse,
  type FetchQuotaProvider,
  grokDirToUse,
  ompAgentDirToUse,
  ompUsageDirToUse,
  opencodeDirToUse,
  parseCliArgs,
  USAGE,
} from './args.js';
import { childEnv, findClaudeBin } from './claude-bin.js';
import { DemoRuns } from './demo-runs.js';
import { DemoStore } from './demo-store.js';
import { openBrowser } from './open-browser.js';
import { ClientCounter, startRunReaper } from './run-reaper.js';
import { isDirectory, linkRunSessions, type RunService, sessionResolver } from './run-service.js';
import { spawnClaude } from './runners/claude-process.js';
import { RunManager } from './runners/run-manager.js';
import { SessionStore } from './store.js';

const log = (msg: string) => console.error(`[glassbox] ${msg}`);

/** Whom `--fetch-quota` asks, and with which credential, for the startup log. */
const FETCH_QUOTA_WITH: Record<FetchQuotaProvider, string> = {
  anthropic: 'Anthropic (your Claude Code sign-in)',
  xai: 'xAI (your Grok CLI sign-in)',
  deepseek: 'DeepSeek ($DEEPSEEK_API_KEY)',
};

/** The built web UI sits next to the built server (dist/web beside dist/server). */
/** The run manager for messages sent from glassbox, or null (runs API answers 503). */
function createRuns(
  opts: CliOptions,
  claudeBin: string | null,
  store: { listSessions(): SessionSummary[] },
): RunService | null {
  if (!claudeBin) {
    log('no `claude` on PATH: sending messages is disabled (point --claude-bin at it)');
    return null;
  }
  return new RunManager({
    spawn: spawnClaude,
    claudeBin,
    resolveSession: sessionResolver(store),
    env: childEnv(process.env, opts.useApiKey),
  });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function findStaticDir(): string | undefined {
  const dir = fileURLToPath(new URL('../web/', import.meta.url));
  return existsSync(join(dir, 'index.html')) ? dir : undefined;
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(process.argv.slice(2), { env: process.env, homedir: homedir() });
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const warning = bindWarning(opts.host);
  if (warning) log(`warning: ${warning}`);

  let claudeBin: string | null = null;
  let grokDir: string | null = null;
  let codexDir: string | null = null;
  let ompAgentDir: string | null = null;
  let ompUsageDir: string | null = null;
  let opencodeDir: string | null = null;
  if (!opts.demo) {
    try {
      claudeBin = await findClaudeBin({
        flag: opts.claudeBin,
        env: process.env,
        platform: process.platform,
      });
      grokDir = await grokDirToUse(opts, isDirectory);
      codexDir = await codexDirToUse(opts, isDirectory);
      ompAgentDir = await ompAgentDirToUse(opts, isDirectory);
      ompUsageDir = await ompUsageDirToUse(opts, isDirectory);
      opencodeDir = await opencodeDirToUse(opts, isFile);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    }
  }

  // Local caches first: on a fetchedAt tie the earlier source wins.
  const quotaSources: QuotaSource[] = [];
  if (ompUsageDir) {
    quotaSources.push(createOmpUsageCacheSource({ agentDir: ompUsageDir }));
    log(`showing plan usage cached by oh-my-pi in ${join(ompUsageDir, 'agent.db')}`);
  }
  // Network and credentials only for the providers named by --fetch-quota.
  const fetching = opts.demo ? [] : opts.fetchQuota;
  const quotaFetcher = fetching.includes('anthropic')
    ? createQuotaFetcher({ claudeDir: opts.claudeDir, log })
    : undefined;
  // Grok CLI's sign-in is used even with --no-grok, which only hides Grok sessions.
  if (fetching.includes('xai')) {
    quotaSources.push(createXaiQuotaSource({ grokDir: opts.grokDir, log }));
  }
  if (fetching.includes('deepseek')) quotaSources.push(createDeepSeekBalanceSource({ log }));
  if (fetching.length > 0) {
    const whom = fetching.map((p) => FETCH_QUOTA_WITH[p]).join(', ');
    log(`asking for plan usage every 5 minutes: ${whom}`);
  }
  const adapters: AgentAdapter[] = [
    createClaudeCodeAdapter({ claudeDir: opts.claudeDir, quotaFetcher }),
  ];
  if (grokDir) {
    adapters.push(createGrokAdapter({ grokDir }));
    log(`showing Grok sessions from ${grokDir} (--no-grok to hide them)`);
  }
  if (codexDir) {
    adapters.push(createCodexAdapter({ codexDir }));
    log(`showing Codex sessions from ${codexDir} (--no-codex to hide them)`);
  }
  if (ompAgentDir) {
    adapters.push(createOmpAdapter({ ompDir: opts.ompDir, agentDir: ompAgentDir }));
    log(`showing oh-my-pi sessions from ${join(ompAgentDir, 'sessions')} (--no-omp to hide them)`);
  }
  if (opencodeDir) {
    adapters.push(createOpenCodeAdapter({ opencodeDir, log }));
    log(`showing OpenCode sessions from ${opencodeDir} (--no-opencode to hide them)`);
  }
  const store = opts.demo ? new DemoStore() : new SessionStore({ adapters, quotaSources, log });
  await store.start();

  const staticDir = findStaticDir();
  const demoRuns = opts.demo ? new DemoRuns() : null;
  const runs = demoRuns ?? createRuns(opts, claudeBin, store);
  const clients = new ClientCounter();
  const stopReaper = runs ? startRunReaper({ runs, clients, log }) : () => {};
  if (runs) linkRunSessions(runs, store);
  const app = createApp({ store, staticDir, runs, clients, log });
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, (info) => {
    const url = browserUrl(opts.host, info.port);
    console.log(`glassbox ${opts.demo ? '(demo data) ' : ''}listening on ${url}`);
    if (!staticDir) log('web UI not built: run `npm run dev` and open http://localhost:5173');
    if (opts.open) openBrowser(staticDir ? url : 'http://localhost:5173', log);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    log(
      err.code === 'EADDRINUSE'
        ? `port ${opts.port} is already in use; pick another with --port`
        : `server error: ${err.message}`,
    );
    process.exit(1);
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    stopReaper();
    demoRuns?.stop();
    // Ending stdin lets each `claude` child finish its turn bookkeeping and exit.
    for (const run of runs?.list() ?? []) if (run.status !== 'closed') runs?.close(run.id);
    await store.stop();
    // Open SSE streams would hold close() forever; the store is already stopped.
    server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

await main();

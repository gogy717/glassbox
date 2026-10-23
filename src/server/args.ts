import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_HOST, DEFAULT_PORT } from '../shared/protocol.js';

export interface CliOptions {
  port: number;
  host: string;
  open: boolean;
  claudeDir: string;
  demo: boolean;
  help: boolean;
  /** Explicit `claude` binary for runs; null → search PATH. */
  claudeBin: string | null;
  /** Keep ANTHROPIC_API_KEY in the environment of `claude` children. */
  useApiKey: boolean;
  /** Show Grok sessions when a Grok data dir exists (`--no-grok` turns it off). */
  grok: boolean;
  /** `--grok-dir`, else $GROK_HOME, else ~/.grok. */
  grokDir: string;
  /** The dir came from `--grok-dir`, so a missing one is an error rather than "no Grok". */
  grokDirFromFlag: boolean;
  /** Show Codex sessions when a Codex home exists (`--no-codex` turns it off). */
  codex: boolean;
  /** `--codex-dir`, else $CODEX_HOME, else ~/.codex. */
  codexDir: string;
  codexDirFromFlag: boolean;
  /** Show OpenCode sessions when its data dir holds a database (`--no-opencode` turns it off). */
  opencode: boolean;
  /** `--opencode-dir`, else $XDG_DATA_HOME/opencode, else ~/.local/share/opencode. */
  opencodeDir: string;
  opencodeDirFromFlag: boolean;
  /** Ask Anthropic's usage endpoint for the plan quota with Claude Code's sign-in. */
  fetchQuota: boolean;
}

export const USAGE = `Usage: glassbox [options]

Live viewer for Claude Code sessions on this machine.

Options:
  --port <n>          port to listen on (default ${DEFAULT_PORT})
  --host <addr>       address to bind (default ${DEFAULT_HOST})
  --no-open           don't open a browser
  --claude-dir <dir>  Claude Code data dir (default $CLAUDE_CONFIG_DIR, else ~/.claude)
  --demo              serve built-in demo data instead of real sessions
  --claude-bin <path> claude binary for messages sent from glassbox (default: claude on PATH)
  --use-api-key       let those claude processes use ANTHROPIC_API_KEY (default: your login)
  --grok-dir <dir>    Grok data dir (default $GROK_HOME, else ~/.grok); Grok sessions are
                      shown whenever that dir exists
  --no-grok           don't show Grok sessions
  --codex-dir <dir>   Codex home (default $CODEX_HOME, else ~/.codex); Codex sessions are
                      shown whenever that dir exists
  --no-codex          don't show Codex sessions
  --opencode-dir <dir>
                      OpenCode data dir (default $XDG_DATA_HOME/opencode, else
                      ~/.local/share/opencode); OpenCode sessions are shown whenever it
                      holds opencode.db
  --no-opencode       don't show OpenCode sessions
  --fetch-quota       keep the plan quota fresh by asking Anthropic for it every 5 minutes,
                      using Claude Code's sign-in (off by default: glassbox otherwise reads no
                      credentials and makes no network requests)
  --help              show this help

glassbox only answers connections from this machine: transcripts are private and the API
can start Claude Code. Binding another --host does not open it to the network; requests from
other machines are refused.`;

export function parseCliArgs(
  argv: string[],
  ctx: { env: Record<string, string | undefined>; homedir: string },
): CliOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'no-open': { type: 'boolean' },
      'claude-dir': { type: 'string' },
      demo: { type: 'boolean' },
      help: { type: 'boolean' },
      'claude-bin': { type: 'string' },
      'use-api-key': { type: 'boolean' },
      'grok-dir': { type: 'string' },
      'no-grok': { type: 'boolean' },
      'codex-dir': { type: 'string' },
      'no-codex': { type: 'boolean' },
      'opencode-dir': { type: 'string' },
      'no-opencode': { type: 'boolean' },
      'fetch-quota': { type: 'boolean' },
    },
  });
  const portText = values.port ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65_535) throw new Error(`invalid --port: ${portText}`);
  const claudeDir = values['claude-dir'] ?? ctx.env.CLAUDE_CONFIG_DIR;
  return {
    port,
    host: values.host ?? DEFAULT_HOST,
    open: !values['no-open'],
    claudeDir: claudeDir ? resolve(claudeDir) : join(ctx.homedir, '.claude'),
    demo: values.demo ?? false,
    help: values.help ?? false,
    claudeBin: values['claude-bin'] ?? null,
    useApiKey: values['use-api-key'] ?? false,
    grok: !values['no-grok'],
    grokDir: resolve(values['grok-dir'] ?? ctx.env.GROK_HOME ?? join(ctx.homedir, '.grok')),
    grokDirFromFlag: values['grok-dir'] !== undefined,
    codex: !values['no-codex'],
    codexDir: resolve(values['codex-dir'] ?? ctx.env.CODEX_HOME ?? join(ctx.homedir, '.codex')),
    codexDirFromFlag: values['codex-dir'] !== undefined,
    opencode: !values['no-opencode'],
    opencodeDir: resolve(
      values['opencode-dir'] ??
        join(ctx.env.XDG_DATA_HOME || join(ctx.homedir, '.local', 'share'), 'opencode'),
    ),
    opencodeDirFromFlag: values['opencode-dir'] !== undefined,
    fetchQuota: values['fetch-quota'] ?? false,
  };
}

/**
 * An optional agent's data dir, or null when it is off or not installed. A dir given by flag
 * that does not exist is a mistake worth stopping for; a missing default just means "not here".
 */
async function optionalAgentDir(
  flag: string,
  on: { enabled: boolean; dir: string; fromFlag: boolean },
  isDirectory: (path: string) => Promise<boolean>,
): Promise<string | null> {
  if (!on.enabled) return null;
  if (await isDirectory(on.dir)) return on.dir;
  if (on.fromFlag) throw new Error(`${flag} ${on.dir}: not a directory`);
  return null;
}

export const grokDirToUse = (opts: CliOptions, isDirectory: (p: string) => Promise<boolean>) =>
  optionalAgentDir(
    '--grok-dir',
    { enabled: opts.grok, dir: opts.grokDir, fromFlag: opts.grokDirFromFlag },
    isDirectory,
  );

export const codexDirToUse = (opts: CliOptions, isDirectory: (p: string) => Promise<boolean>) =>
  optionalAgentDir(
    '--codex-dir',
    { enabled: opts.codex, dir: opts.codexDir, fromFlag: opts.codexDirFromFlag },
    isDirectory,
  );

/**
 * OpenCode's data dir when it holds `opencode.db`, else null. Like `optionalAgentDir`, but the
 * database must be there: OpenCode keeps its sessions in it, not in files of their own.
 */
export async function opencodeDirToUse(
  opts: CliOptions,
  isFile: (path: string) => Promise<boolean>,
): Promise<string | null> {
  if (!opts.opencode) return null;
  if (await isFile(join(opts.opencodeDir, 'opencode.db'))) return opts.opencodeDir;
  if (opts.opencodeDirFromFlag)
    throw new Error(`--opencode-dir ${opts.opencodeDir}: no opencode.db there`);
  return null;
}

/** A startup warning for binding `host`, or null when it is a loopback address. */
export function bindWarning(host: string): string | null {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return null;
  const base = `--host ${host}: the API only accepts connections from this machine`;
  if (h === '0.0.0.0' || h === '::') return `${base}; other machines will be refused`;
  return `${base}, and this machine reaches ${host} from that address, not loopback, so every request will be refused; use 127.0.0.1`;
}

/** The URL to show and open for a server bound to `host`. */
export function browserUrl(host: string, port: number): string {
  if (host === '0.0.0.0' || host === '::') return `http://127.0.0.1:${port}`;
  return host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

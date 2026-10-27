import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_HOST, DEFAULT_PORT } from '../shared/protocol.js';
/** Providers glassbox can ask for plan usage, in the order the quota bar shows them. */
export const FETCH_QUOTA_PROVIDERS = ['anthropic', 'xai', 'deepseek'];
export const USAGE = `Usage: glassbox [options]

Live viewer for Claude Code, Codex, Grok, oh-my-pi and OpenCode sessions on this machine.

Options:
  --port <n>          port to listen on (default ${DEFAULT_PORT})
  --host <addr>       address to bind (default ${DEFAULT_HOST})
  --no-open           don't open a browser
  --claude-dir <dir>  Claude Code data dir (default $CLAUDE_CONFIG_DIR, else ~/.claude)
  --demo              serve built-in demo data instead of real sessions (no network requests)
  --claude-bin <path> claude binary for messages sent from glassbox (default: claude on PATH)
  --use-api-key       let those claude processes use ANTHROPIC_API_KEY (default: your login)
  --grok-dir <dir>    Grok data dir (default $GROK_HOME, else ~/.grok); Grok sessions are
                      shown whenever that dir exists
  --no-grok           don't show Grok sessions
  --codex-dir <dir>   Codex home (default $CODEX_HOME, else ~/.codex); Codex sessions are
                      shown whenever that dir exists
  --no-codex          don't show Codex sessions
  --omp-dir <dir>     oh-my-pi dir (default ~/.omp, or ~/$PI_CONFIG_DIR); oh-my-pi sessions
                      are shown whenever <dir>/agent/sessions exists ($PI_CODING_AGENT_DIR
                      stands in for <dir>/agent when this flag is not given)
  --no-omp            don't show oh-my-pi sessions or the plan usage oh-my-pi caches
  --opencode-dir <dir>
                      OpenCode data dir (default $XDG_DATA_HOME/opencode, else
                      ~/.local/share/opencode); OpenCode sessions are shown whenever it
                      holds opencode.db
  --no-opencode       don't show OpenCode sessions
  --fetch-quota=<list>
                      ask only these providers for plan usage, e.g.
                      --fetch-quota=anthropic,deepseek (default: all of them, see below)
  --no-fetch-quota    ask no provider: no network requests and no credentials read; plan
                      usage then comes only from what the agents cache themselves
  --help              show this help

Plan usage is kept fresh by asking each provider every 5 minutes: anthropic (with Claude
Code's sign-in), xai (SuperGrok, with Grok CLI's sign-in in the Grok data dir) and deepseek
(the balance, with $DEEPSEEK_API_KEY). Each credential is sent only to its own provider, never
stored or renewed; a provider with no credential, or an expired sign-in, is skipped.

glassbox only answers connections from this machine: transcripts are private and the API
can start Claude Code. Binding another --host does not open it to the network; requests from
other machines are refused.`;
/** `--fetch-quota` takes an optional value; alone, it means every provider, as by default. */
const ALL_PROVIDERS_ARG = `--fetch-quota=${FETCH_QUOTA_PROVIDERS.join(',')}`;
/** The providers named by every `--fetch-quota=<list>`, in display order; all without one. */
function fetchQuotaProviders(lists) {
    if (!lists)
        return [...FETCH_QUOTA_PROVIDERS];
    const known = FETCH_QUOTA_PROVIDERS;
    const choices = FETCH_QUOTA_PROVIDERS.join(', ');
    const names = new Set();
    for (const list of lists) {
        const named = list
            .split(',')
            .map((n) => n.trim().toLowerCase())
            .filter((n) => n !== '');
        if (named.length === 0)
            throw new Error(`--fetch-quota=: name a provider (${choices})`);
        for (const name of named) {
            if (!known.includes(name)) {
                throw new Error(`--fetch-quota: unknown provider "${name}" (choose from ${choices})`);
            }
            names.add(name);
        }
    }
    return FETCH_QUOTA_PROVIDERS.filter((p) => names.has(p));
}
export function parseCliArgs(argv, ctx) {
    const { values } = parseArgs({
        args: argv.map((a) => (a === '--fetch-quota' ? ALL_PROVIDERS_ARG : a)),
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
            'omp-dir': { type: 'string' },
            'no-omp': { type: 'boolean' },
            'opencode-dir': { type: 'string' },
            'no-opencode': { type: 'boolean' },
            'fetch-quota': { type: 'string', multiple: true },
            'no-fetch-quota': { type: 'boolean' },
        },
    });
    if (values['no-fetch-quota'] && values['fetch-quota']) {
        throw new Error('--no-fetch-quota and --fetch-quota contradict each other: pick one');
    }
    // Checked even when unused, so a typo in the list is never silently ignored.
    const fetchQuota = fetchQuotaProviders(values['fetch-quota']);
    const portText = values.port ?? String(DEFAULT_PORT);
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || port > 65_535)
        throw new Error(`invalid --port: ${portText}`);
    const claudeDir = values['claude-dir'] ?? ctx.env.CLAUDE_CONFIG_DIR;
    // omp joins PI_CONFIG_DIR onto the home dir, even when it is absolute.
    const ompDir = resolve(values['omp-dir'] ?? join(ctx.homedir, ctx.env.PI_CONFIG_DIR || '.omp'));
    const ompAgentEnv = values['omp-dir'] === undefined ? ctx.env.PI_CODING_AGENT_DIR : undefined;
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
        omp: !values['no-omp'],
        ompDir,
        ompAgentDir: ompAgentEnv ? resolve(ompAgentEnv) : join(ompDir, 'agent'),
        ompDirFromFlag: values['omp-dir'] !== undefined,
        opencode: !values['no-opencode'],
        opencodeDir: resolve(values['opencode-dir'] ??
            join(ctx.env.XDG_DATA_HOME || join(ctx.homedir, '.local', 'share'), 'opencode')),
        opencodeDirFromFlag: values['opencode-dir'] !== undefined,
        // Demo data never asks the network.
        fetchQuota: values.demo || values['no-fetch-quota'] ? [] : fetchQuota,
    };
}
/**
 * An optional agent's data dir, or null when it is off or not installed. A dir given by flag
 * that does not exist is a mistake worth stopping for; a missing default just means "not here".
 */
async function optionalAgentDir(flag, on, isDirectory) {
    if (!on.enabled)
        return null;
    if (await isDirectory(on.dir))
        return on.dir;
    if (on.fromFlag)
        throw new Error(`${flag} ${on.dir}: not a directory`);
    return null;
}
export const grokDirToUse = (opts, isDirectory) => optionalAgentDir('--grok-dir', { enabled: opts.grok, dir: opts.grokDir, fromFlag: opts.grokDirFromFlag }, isDirectory);
export const codexDirToUse = (opts, isDirectory) => optionalAgentDir('--codex-dir', { enabled: opts.codex, dir: opts.codexDir, fromFlag: opts.codexDirFromFlag }, isDirectory);
/**
 * omp's agent dir, or null when omp is off or has no sessions there. A `--omp-dir` that does not
 * exist is an error, like the other agents' dirs.
 */
export async function ompAgentDirToUse(opts, isDirectory) {
    if (!opts.omp)
        return null;
    if (opts.ompDirFromFlag && !(await isDirectory(opts.ompDir)))
        throw new Error(`--omp-dir ${opts.ompDir}: not a directory`);
    return (await isDirectory(join(opts.ompAgentDir, 'sessions'))) ? opts.ompAgentDir : null;
}
/**
 * omp's agent dir for the plan usage omp caches in its agent.db, or null when omp is off or the
 * dir is missing. Unlike sessions, the cache needs no sessions dir.
 */
export async function ompUsageDirToUse(opts, isDirectory) {
    return opts.omp && (await isDirectory(opts.ompAgentDir)) ? opts.ompAgentDir : null;
}
/**
 * OpenCode's data dir when it holds `opencode.db`, else null. Like `optionalAgentDir`, but the
 * database must be there: OpenCode keeps its sessions in it, not in files of their own.
 */
export async function opencodeDirToUse(opts, isFile) {
    if (!opts.opencode)
        return null;
    if (await isFile(join(opts.opencodeDir, 'opencode.db')))
        return opts.opencodeDir;
    if (opts.opencodeDirFromFlag)
        throw new Error(`--opencode-dir ${opts.opencodeDir}: no opencode.db there`);
    return null;
}
/** A startup warning for binding `host`, or null when it is a loopback address. */
export function bindWarning(host) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '::1' || h.startsWith('127.'))
        return null;
    const base = `--host ${host}: the API only accepts connections from this machine`;
    if (h === '0.0.0.0' || h === '::')
        return `${base}; other machines will be refused`;
    return `${base}, and this machine reaches ${host} from that address, not loopback, so every request will be refused; use 127.0.0.1`;
}
/** The URL to show and open for a server bound to `host`. */
export function browserUrl(host, port) {
    if (host === '0.0.0.0' || host === '::')
        return `http://127.0.0.1:${port}`;
    return host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}
//# sourceMappingURL=args.js.map
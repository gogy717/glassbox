import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bindWarning,
  browserUrl,
  codexDirToUse,
  grokDirToUse,
  ompAgentDirToUse,
  ompUsageDirToUse,
  opencodeDirToUse,
  parseCliArgs,
} from './args.js';
import { browserCommand } from './open-browser.js';

const ctx = { env: {}, homedir: '/home/u' };

describe('parseCliArgs', () => {
  it('defaults to loopback, port 7788, opening the browser, real data, every quota fetched', () => {
    expect(parseCliArgs([], ctx)).toEqual({
      port: 7788,
      host: '127.0.0.1',
      open: true,
      claudeDir: '/home/u/.claude',
      demo: false,
      help: false,
      claudeBin: null,
      useApiKey: false,
      grok: true,
      grokDir: '/home/u/.grok',
      grokDirFromFlag: false,
      codex: true,
      codexDir: '/home/u/.codex',
      codexDirFromFlag: false,
      omp: true,
      ompDir: '/home/u/.omp',
      ompAgentDir: '/home/u/.omp/agent',
      ompDirFromFlag: false,
      opencode: true,
      opencodeDir: '/home/u/.local/share/opencode',
      opencodeDirFromFlag: false,
      fetchQuota: ['anthropic', 'xai', 'deepseek'],
    });
  });

  it('reads every flag', () => {
    expect(
      parseCliArgs(
        [
          '--port',
          '9000',
          '--host',
          'localhost',
          '--no-open',
          '--demo',
          '--claude-dir',
          '/data/c',
          '--claude-bin',
          '/opt/claude',
          '--use-api-key',
          '--grok-dir',
          '/data/g',
          '--no-grok',
          '--codex-dir',
          '/data/x',
          '--no-codex',
          '--omp-dir',
          '/data/o',
          '--no-omp',
          '--opencode-dir',
          '/data/oc',
          '--no-opencode',
          '--fetch-quota=xai',
        ],
        ctx,
      ),
    ).toEqual({
      port: 9000,
      host: 'localhost',
      open: false,
      claudeDir: '/data/c',
      demo: true,
      help: false,
      claudeBin: '/opt/claude',
      useApiKey: true,
      grok: false,
      grokDir: '/data/g',
      grokDirFromFlag: true,
      codex: false,
      codexDir: '/data/x',
      codexDirFromFlag: true,
      omp: false,
      ompDir: '/data/o',
      ompAgentDir: '/data/o/agent',
      ompDirFromFlag: true,
      opencode: false,
      opencodeDir: '/data/oc',
      opencodeDirFromFlag: true,
      // Demo data never asks the network, whatever --fetch-quota says.
      fetchQuota: [],
    });
  });

  it('limits --fetch-quota to the providers listed, in display order', () => {
    const fetchQuota = (...argv: string[]) => parseCliArgs(argv, ctx).fetchQuota;
    expect(fetchQuota('--fetch-quota=deepseek,anthropic')).toEqual(['anthropic', 'deepseek']);
    expect(fetchQuota('--fetch-quota=xai', '--fetch-quota=DeepSeek')).toEqual(['xai', 'deepseek']);
    expect(fetchQuota('--fetch-quota=xai', '--fetch-quota')).toEqual([
      'anthropic',
      'xai',
      'deepseek',
    ]);
    expect(fetchQuota('--fetch-quota', '--no-open')).toEqual(['anthropic', 'xai', 'deepseek']);
  });

  it('asks no provider with --no-fetch-quota or --demo', () => {
    expect(parseCliArgs(['--no-fetch-quota'], ctx).fetchQuota).toEqual([]);
    expect(parseCliArgs(['--demo'], ctx).fetchQuota).toEqual([]);
    expect(parseCliArgs(['--demo', '--fetch-quota'], ctx).fetchQuota).toEqual([]);
  });

  it('rejects --no-fetch-quota with --fetch-quota', () => {
    const contradiction = /--no-fetch-quota and --fetch-quota contradict each other/;
    expect(() => parseCliArgs(['--no-fetch-quota', '--fetch-quota'], ctx)).toThrow(contradiction);
    expect(() => parseCliArgs(['--fetch-quota=xai', '--no-fetch-quota'], ctx)).toThrow(
      contradiction,
    );
    expect(() => parseCliArgs(['--no-fetch-quota=xai'], ctx)).toThrow();
  });

  it('rejects an unknown or empty --fetch-quota list', () => {
    expect(() => parseCliArgs(['--fetch-quota=anthropic,openai'], ctx)).toThrow(
      '--fetch-quota: unknown provider "openai" (choose from anthropic, xai, deepseek)',
    );
    expect(() => parseCliArgs(['--fetch-quota='], ctx)).toThrow(/name a provider/);
    // The list is attached with "=": a separate word is a stray argument.
    expect(() => parseCliArgs(['--fetch-quota', 'deepseek'], ctx)).toThrow();
    // Checked even when demo data makes the list moot.
    expect(() => parseCliArgs(['--demo', '--fetch-quota=openai'], ctx)).toThrow(/unknown/);
  });

  it('takes the claude dir from --claude-dir, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    const env = { CLAUDE_CONFIG_DIR: '/env/claude' };
    expect(parseCliArgs([], { ...ctx, env }).claudeDir).toBe('/env/claude');
    expect(parseCliArgs(['--claude-dir', '/flag'], { ...ctx, env }).claudeDir).toBe('/flag');
    expect(parseCliArgs(['--claude-dir', 'rel/dir'], ctx).claudeDir).toBe(resolve('rel/dir'));
  });

  it.each([['abc'], ['70000'], ['-1'], ['80.5']])('rejects --port %s', (port) => {
    expect(() => parseCliArgs(['--port', port], ctx)).toThrow(/port/);
  });

  it('rejects unknown flags and stray arguments', () => {
    expect(() => parseCliArgs(['--prot', '1'], ctx)).toThrow();
    expect(() => parseCliArgs(['serve'], ctx)).toThrow();
  });

  it('recognises --help', () => {
    expect(parseCliArgs(['--help'], ctx).help).toBe(true);
  });
});

describe('browserUrl', () => {
  it.each([
    ['127.0.0.1', 7788, 'http://127.0.0.1:7788'],
    ['localhost', 80, 'http://localhost:80'],
    ['::1', 7788, 'http://[::1]:7788'],
    // Wildcard binds are reachable on loopback; other hostnames would be refused by the
    // Host check anyway.
    ['0.0.0.0', 7788, 'http://127.0.0.1:7788'],
    ['::', 7788, 'http://127.0.0.1:7788'],
  ])('%s:%i → %s', (host, port, url) => {
    expect(browserUrl(host, port)).toBe(url);
  });
});

describe('browserCommand', () => {
  const url = 'http://127.0.0.1:7788';
  it.each([
    ['darwin', 'open', [url]],
    ['linux', 'xdg-open', [url]],
    ['freebsd', 'xdg-open', [url]],
    ['win32', 'cmd', ['/c', 'start', '""', url]],
  ])('%s → %s', (platform, cmd, args) => {
    expect(browserCommand(platform as NodeJS.Platform, url)).toEqual({ cmd, args });
  });
});

describe('bindWarning', () => {
  it.each(['127.0.0.1', '127.0.0.2', 'localhost', '::1'])(
    'says nothing for loopback %s',
    (host) => {
      expect(bindWarning(host)).toBeNull();
    },
  );

  it.each(['0.0.0.0', '::'])('warns that other machines are refused on %s', (host) => {
    expect(bindWarning(host)).toMatch(/only accepts connections from this machine/);
  });

  it('warns that a single LAN address makes glassbox unreachable', () => {
    expect(bindWarning('192.168.1.20')).toMatch(
      /only accepts connections from this machine.*127\.0\.0\.1/s,
    );
  });
});

describe('grokDirToUse', () => {
  const opts = (argv: string[], env: Record<string, string> = {}) =>
    parseCliArgs(argv, { env, homedir: '/home/u' });
  const exists = (dirs: string[]) => async (p: string) => dirs.includes(p);

  it('uses ~/.grok when it exists, $GROK_HOME before it', async () => {
    expect(await grokDirToUse(opts([]), exists(['/home/u/.grok']))).toBe('/home/u/.grok');
    expect(await grokDirToUse(opts([], { GROK_HOME: '/g' }), exists(['/g']))).toBe('/g');
  });

  it('stays off quietly when there is no Grok install', async () => {
    expect(await grokDirToUse(opts([]), exists([]))).toBeNull();
    expect(await grokDirToUse(opts([], { GROK_HOME: '/g' }), exists([]))).toBeNull();
  });

  it('stays off with --no-grok', async () => {
    expect(await grokDirToUse(opts(['--no-grok']), exists(['/home/u/.grok']))).toBeNull();
  });

  it('refuses a --grok-dir that does not exist', async () => {
    await expect(grokDirToUse(opts(['--grok-dir', '/nope']), exists([]))).rejects.toThrow(
      /--grok-dir.*\/nope/,
    );
    expect(await grokDirToUse(opts(['--grok-dir', '/g2']), exists(['/g2']))).toBe('/g2');
  });
});

describe('codexDirToUse', () => {
  const opts = (argv: string[], env: Record<string, string> = {}) =>
    parseCliArgs(argv, { env, homedir: '/home/u' });
  const exists = (dirs: string[]) => async (p: string) => dirs.includes(p);

  it('uses ~/.codex when it exists, $CODEX_HOME before it', async () => {
    expect(await codexDirToUse(opts([]), exists(['/home/u/.codex']))).toBe('/home/u/.codex');
    expect(await codexDirToUse(opts([], { CODEX_HOME: '/c' }), exists(['/c']))).toBe('/c');
  });

  it('stays off without a Codex install, or with --no-codex', async () => {
    expect(await codexDirToUse(opts([]), exists([]))).toBeNull();
    expect(await codexDirToUse(opts(['--no-codex']), exists(['/home/u/.codex']))).toBeNull();
  });

  it('refuses a --codex-dir that does not exist', async () => {
    await expect(codexDirToUse(opts(['--codex-dir', '/nope']), exists([]))).rejects.toThrow(
      /--codex-dir.*\/nope/,
    );
  });
});

describe('ompAgentDirToUse', () => {
  const opts = (argv: string[], env: Record<string, string> = {}) =>
    parseCliArgs(argv, { env, homedir: '/home/u' });
  const exists = (dirs: string[]) => async (p: string) => dirs.includes(p);

  it('uses ~/.omp/agent when it has sessions', async () => {
    expect(await ompAgentDirToUse(opts([]), exists(['/home/u/.omp/agent/sessions']))).toBe(
      '/home/u/.omp/agent',
    );
    // An install that never saved a session shows nothing.
    expect(await ompAgentDirToUse(opts([]), exists(['/home/u/.omp']))).toBeNull();
  });

  it('follows omp: PI_CONFIG_DIR is joined onto home, PI_CODING_AGENT_DIR moves the agent dir', async () => {
    const custom = opts([], { PI_CONFIG_DIR: '.omp-work' });
    expect(custom.ompDir).toBe('/home/u/.omp-work');
    expect(await ompAgentDirToUse(custom, exists(['/home/u/.omp-work/agent/sessions']))).toBe(
      '/home/u/.omp-work/agent',
    );
    const moved = opts([], { PI_CODING_AGENT_DIR: '/data/agent' });
    expect(moved).toMatchObject({ ompDir: '/home/u/.omp', ompAgentDir: '/data/agent' });
    expect(await ompAgentDirToUse(moved, exists(['/data/agent/sessions']))).toBe('/data/agent');
    // The flag names the whole omp dir; the environment no longer applies.
    expect(opts(['--omp-dir', '/o'], { PI_CODING_AGENT_DIR: '/data/agent' }).ompAgentDir).toBe(
      '/o/agent',
    );
  });

  it('stays off with --no-omp, and refuses an --omp-dir that does not exist', async () => {
    expect(
      await ompAgentDirToUse(opts(['--no-omp']), exists(['/home/u/.omp/agent/sessions'])),
    ).toBeNull();
    await expect(ompAgentDirToUse(opts(['--omp-dir', '/nope']), exists([]))).rejects.toThrow(
      /--omp-dir.*\/nope/,
    );
    expect(await ompAgentDirToUse(opts(['--omp-dir', '/o']), exists(['/o']))).toBeNull();
  });
});

describe('ompUsageDirToUse', () => {
  const opts = (argv: string[], env: Record<string, string> = {}) =>
    parseCliArgs(argv, { env, homedir: '/home/u' });
  const exists = (dirs: string[]) => async (p: string) => dirs.includes(p);

  it('reads the usage cache from the agent dir the sessions use, sessions or not', async () => {
    expect(await ompUsageDirToUse(opts([]), exists(['/home/u/.omp/agent']))).toBe(
      '/home/u/.omp/agent',
    );
    const moved = opts([], { PI_CODING_AGENT_DIR: '/data/agent' });
    expect(await ompUsageDirToUse(moved, exists(['/data/agent']))).toBe('/data/agent');
    expect(await ompUsageDirToUse(opts(['--omp-dir', '/o']), exists(['/o/agent']))).toBe(
      '/o/agent',
    );
    expect(await ompUsageDirToUse(opts([]), exists(['/home/u/.omp']))).toBeNull();
  });

  it('stays off with --no-omp: no omp file is read', async () => {
    const isDirectory = vi.fn(async () => true);
    expect(await ompUsageDirToUse(opts(['--no-omp']), isDirectory)).toBeNull();
    expect(await ompAgentDirToUse(opts(['--no-omp']), isDirectory)).toBeNull();
    expect(isDirectory).not.toHaveBeenCalled();
  });
});

describe('opencodeDirToUse', () => {
  const opts = (argv: string[], env: Record<string, string> = {}) =>
    parseCliArgs(argv, { env, homedir: '/home/u' });
  const files = (paths: string[]) => async (p: string) => paths.includes(p);

  it('uses ~/.local/share/opencode when it holds opencode.db, $XDG_DATA_HOME before it', async () => {
    const home = '/home/u/.local/share/opencode';
    expect(await opencodeDirToUse(opts([]), files([`${home}/opencode.db`]))).toBe(home);
    expect(
      await opencodeDirToUse(
        opts([], { XDG_DATA_HOME: '/xdg' }),
        files(['/xdg/opencode/opencode.db']),
      ),
    ).toBe('/xdg/opencode');
    // An empty XDG_DATA_HOME counts as unset, as OpenCode reads it.
    expect(opts([], { XDG_DATA_HOME: '' }).opencodeDir).toBe(home);
  });

  it('stays off without a database, or with --no-opencode', async () => {
    expect(await opencodeDirToUse(opts([]), files([]))).toBeNull();
    expect(
      await opencodeDirToUse(
        opts(['--no-opencode']),
        files(['/home/u/.local/share/opencode/opencode.db']),
      ),
    ).toBeNull();
  });

  it('refuses an --opencode-dir without a database in it', async () => {
    await expect(opencodeDirToUse(opts(['--opencode-dir', '/nope']), files([]))).rejects.toThrow(
      /--opencode-dir.*\/nope.*opencode\.db/,
    );
    expect(await opencodeDirToUse(opts(['--opencode-dir', '/o']), files(['/o/opencode.db']))).toBe(
      '/o',
    );
  });
});

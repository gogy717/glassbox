import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindWarning, browserUrl, codexDirToUse, grokDirToUse, parseCliArgs } from './args.js';
import { browserCommand } from './open-browser.js';

const ctx = { env: {}, homedir: '/home/u' };

describe('parseCliArgs', () => {
  it('defaults to loopback, port 7788, opening the browser, real data from ~/.claude', () => {
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
      fetchQuota: false,
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
          '--fetch-quota',
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
      fetchQuota: true,
    });
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

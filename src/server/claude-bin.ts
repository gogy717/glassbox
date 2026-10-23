import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

type Env = Record<string, string | undefined>;

/**
 * The `claude` binary runs are started with: `--claude-bin` when given (an explicit path that
 * doesn't work is a startup error), else the first executable `claude` on PATH, else null.
 */
export async function findClaudeBin(opts: {
  flag: string | null;
  env: Env;
  platform: NodeJS.Platform;
}): Promise<string | null> {
  const { flag, env, platform } = opts;
  if (flag) {
    const path = resolve(flag);
    if (!(await isRunnable(path, platform)))
      throw new Error(`--claude-bin ${path}: not found or not executable`);
    return path;
  }
  const windows = platform === 'win32';
  const pathVar = windows ? envCaseless(env, 'PATH') : env.PATH;
  const exts = windows
    ? (envCaseless(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of (pathVar ?? '').split(windows ? ';' : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      for (const name of new Set([`claude${ext.toLowerCase()}`, `claude${ext}`])) {
        const path = join(dir, name);
        if (await isRunnable(path, platform)) return path;
      }
    }
  }
  return null;
}

/** The environment for a `claude` child: ours, minus the API key unless asked to keep it. */
export function childEnv(env: Env, useApiKey: boolean): Env {
  if (useApiKey) return { ...env };
  const { ANTHROPIC_API_KEY: _dropped, ...rest } = env;
  // Without the key, Claude Code uses the subscription login, as in the user's terminal.
  return rest;
}

async function isRunnable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function envCaseless(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

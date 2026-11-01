import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
/**
 * The `claude` binary runs are started with: `--claude-bin` when given (an explicit path that
 * doesn't work is a startup error), else the first executable `claude` on PATH, else null.
 */
export async function findClaudeBin(opts) {
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
        if (!dir)
            continue;
        for (const ext of exts) {
            for (const name of new Set([`claude${ext.toLowerCase()}`, `claude${ext}`])) {
                const path = join(dir, name);
                if (await isRunnable(path, platform))
                    return path;
            }
        }
    }
    return null;
}
/** The environment for a `claude` child: ours, minus the API key unless asked to keep it. */
export function childEnv(env, useApiKey) {
    if (useApiKey)
        return { ...env };
    const { ANTHROPIC_API_KEY: _dropped, ...rest } = env;
    // Without the key, Claude Code uses the subscription login, as in the user's terminal.
    return rest;
}
async function isRunnable(path, platform) {
    try {
        if (!(await stat(path)).isFile())
            return false;
        if (platform !== 'win32')
            await access(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function envCaseless(env, name) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name);
    return key === undefined ? undefined : env[key];
}
//# sourceMappingURL=claude-bin.js.map
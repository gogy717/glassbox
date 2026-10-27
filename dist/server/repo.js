/**
 * Which git repository a session's directory belongs to, so the session list can gather the
 * worktrees of one repository under one name whatever their paths. From `cwd` upwards, the
 * first `.git` entry decides: a directory is the main working tree; a file is a worktree (or a
 * submodule) and names its repository's `.git` on its one `gitdir:` line. Nothing else in the
 * repository is read: not its config, not its objects, not its hooks.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
export const nodeRepoFs = {
    kind(path) {
        try {
            const st = statSync(path);
            return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
        }
        catch {
            return null;
        }
    },
    head(path) {
        try {
            return readFileSync(path, 'utf8').slice(0, 4096);
        }
        catch {
            return null;
        }
    },
};
/** How many parents of `cwd` a lookup climbs before giving up. */
const MAX_DEPTH = 32;
const WORKTREE_GITDIR = /^(.*)[\\/]worktrees[\\/][^\\/]+[\\/]?$/;
/**
 * The repository of `cwd`, or null when no parent up to the filesystem's root has a `.git`.
 * A worktree's `.git` file points into the main `.git/worktrees/<name>`: its repository is the
 * directory holding that `.git`. A submodule's points into `.git/modules/<name>`: it counts as
 * a repository of its own, since its sessions are about its own code.
 */
export function repoOf(cwd, fs = nodeRepoFs) {
    let dir = resolve(cwd);
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const dotGit = join(dir, '.git');
        const kind = fs.kind(dotGit);
        if (kind === 'dir')
            return { root: dir, dir, name: basename(dir) };
        if (kind === 'file') {
            const line = fs.head(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/m);
            if (!line)
                return null;
            const gitdir = isAbsolute(line[1])
                ? line[1]
                : resolve(dir, line[1]);
            const common = WORKTREE_GITDIR.exec(gitdir)?.[1];
            if (common && basename(common) === '.git') {
                const root = dirname(common);
                return { root, dir, name: basename(root) };
            }
            return { root: dir, dir, name: basename(dir) };
        }
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
    return null;
}
/**
 * `repoOf` with its answers kept per directory for `ttlMs` (a repository does not move between
 * two polls, and the store lists sessions often), misses included.
 */
export function createRepoLookup(fs = nodeRepoFs, ttlMs = 60_000, now = Date.now) {
    const cache = new Map();
    return (cwd) => {
        const hit = cache.get(cwd);
        const t = now();
        if (hit && t - hit.at < ttlMs)
            return hit.repo;
        const repo = repoOf(cwd, fs);
        cache.set(cwd, { at: t, repo });
        return repo;
    };
}
//# sourceMappingURL=repo.js.map
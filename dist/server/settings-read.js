/**
 * The one more thing the Rules page reads: the permission lists of Claude Code's settings, so it
 * can say which rules you already have. Yours (`<claudeDir>/settings.json`) and each project's:
 * `.claude/settings.json` and `.claude/settings.local.json` in its repository's root and in each
 * worktree its sessions ran in (a worktree keeps a local file of its own).
 *
 * Of each file only `permissions.allow` and `permissions.deny` are kept, and of them only their
 * strings: not the rest of `permissions`, not `env`, not hooks. A file that is not there, larger
 * than `SETTINGS_MAX_BYTES`, not JSON or not an object is passed over. Nothing is ever written,
 * and no directory is made.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
/** Settings files are a few kilobytes; one past this is not read. */
export const SETTINGS_MAX_BYTES = 1024 * 1024;
const FILES = ['settings.json', 'settings.local.json'];
const strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
/**
 * A settings file's two permission lists (empty when it has none), or null when it cannot be read
 * as a settings file.
 */
export async function readPermissionLists(path) {
    try {
        const s = await stat(path);
        if (!s.isFile() || s.size > SETTINGS_MAX_BYTES)
            return null;
        const parsed = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return null;
        const permissions = parsed.permissions;
        const lists = typeof permissions === 'object' && permissions !== null
            ? permissions
            : {};
        return { allow: strings(lists.allow), deny: strings(lists.deny) };
    }
    catch {
        return null;
    }
}
/**
 * The settings files found, yours first, then each project's in the order given, each of its
 * directories once (its root, then its worktrees): the shared file, then the local one. A
 * directory given as a relative path is not looked in.
 */
export async function readRuleSettings(opts) {
    const out = [];
    const read = async (path, scope, root) => {
        const lists = await readPermissionLists(path);
        if (lists)
            out.push({ path, scope, root, ...lists });
    };
    if (isAbsolute(opts.claudeDir))
        await read(join(opts.claudeDir, 'settings.json'), 'global', null);
    for (const { root, dirs } of opts.projects) {
        if (!isAbsolute(root))
            continue;
        for (const dir of new Set([root, ...dirs])) {
            if (!isAbsolute(dir))
                continue;
            for (const name of FILES)
                await read(join(dir, '.claude', name), 'project', root);
        }
    }
    return out;
}
//# sourceMappingURL=settings-read.js.map
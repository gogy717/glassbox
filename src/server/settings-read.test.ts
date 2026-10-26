import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPermissionLists, readRuleSettings, SETTINGS_MAX_BYTES } from './settings-read.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'glassbox-settings-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<string> {
  const full = join(root, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
  return full;
}

/** Every file under `dir` with its size and modification time. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const p = join(e.parentPath, e.name);
    const s = await stat(p);
    out.push(`${p} ${e.isDirectory() ? 'dir' : s.size} ${s.mtimeMs}`);
  }
  return out.sort();
}

describe('the permission lists of a settings file', () => {
  it('keeps the strings of permissions.allow and permissions.deny, and nothing else of the file', async () => {
    const path = await put(
      'settings.json',
      JSON.stringify({
        permissions: {
          allow: ['Bash(npm test:*)', 42, null, 'WebSearch'],
          deny: ['Bash(rm:*)'],
          ask: ['Bash(git push:*)'],
          defaultMode: 'acceptEdits',
          additionalDirectories: ['/work/other'],
        },
        env: { EXAMPLE_TOKEN: 'not-a-real-token' },
        hooks: { Stop: [] },
        model: 'example',
      }),
    );
    expect(await readPermissionLists(path)).toEqual({
      allow: ['Bash(npm test:*)', 'WebSearch'],
      deny: ['Bash(rm:*)'],
    });
  });

  it('reads a file without lists as empty ones, with a byte order mark or not', async () => {
    expect(await readPermissionLists(await put('a.json', '﻿{"model":"x"}'))).toEqual({
      allow: [],
      deny: [],
    });
    expect(
      await readPermissionLists(await put('b.json', '{"permissions":{"allow":"Bash"}}')),
    ).toEqual({ allow: [], deny: [] });
  });

  it('passes over a file that is not there, not JSON, not an object, or too large', async () => {
    expect(await readPermissionLists(join(root, 'missing.json'))).toBeNull();
    expect(await readPermissionLists(await put('bad.json', '{"permissions": {'))).toBeNull();
    expect(await readPermissionLists(await put('list.json', '["Bash"]'))).toBeNull();
    expect(await readPermissionLists(root)).toBeNull();
    const big = `{"permissions":{"allow":["Bash"]}}${' '.repeat(SETTINGS_MAX_BYTES)}`;
    expect(await readPermissionLists(await put('big.json', big))).toBeNull();
  });
});

describe('the settings Rules reads', () => {
  it('reads yours, then each project’s shared and local file, its worktrees’ too, skipping what is not there', async () => {
    const claudeDir = join(root, 'home', '.claude');
    const shop = join(root, 'work', 'shop');
    const tree2 = join(root, 'work', 'shop-feature');
    const blog = join(root, 'work', 'blog');
    await put('home/.claude/settings.json', '{"permissions":{"allow":["Bash(npm test:*)"]}}');
    await put('work/shop/.claude/settings.json', '{"permissions":{"deny":["Bash(rm:*)"]}}');
    await put(
      'work/shop/.claude/settings.local.json',
      '{"permissions":{"allow":["Edit(src/**)"]}}',
    );
    await put(
      'work/shop-feature/.claude/settings.local.json',
      '{"permissions":{"allow":["WebSearch"]}}',
    );
    await mkdir(blog, { recursive: true });

    const files = await readRuleSettings({
      claudeDir,
      projects: [
        { root: shop, dirs: [shop, tree2, shop] },
        { root: blog, dirs: [blog] },
      ],
    });
    expect(files).toEqual([
      {
        path: join(claudeDir, 'settings.json'),
        scope: 'global',
        root: null,
        allow: ['Bash(npm test:*)'],
        deny: [],
      },
      {
        path: join(shop, '.claude', 'settings.json'),
        scope: 'project',
        root: shop,
        allow: [],
        deny: ['Bash(rm:*)'],
      },
      {
        path: join(shop, '.claude', 'settings.local.json'),
        scope: 'project',
        root: shop,
        allow: ['Edit(src/**)'],
        deny: [],
      },
      {
        path: join(tree2, '.claude', 'settings.local.json'),
        scope: 'project',
        root: shop,
        allow: ['WebSearch'],
        deny: [],
      },
    ]);
  });

  it('writes nothing: every file as it was, and no directory made where there was none', async () => {
    await put('home/.claude/settings.json', '{"permissions":{"allow":["Bash"]}}');
    await put('work/shop/.claude/settings.local.json', '{"permissions":{"allow":["Edit"]}}');
    await mkdir(join(root, 'work', 'blog'), { recursive: true });
    const before = await tree(root);
    await readRuleSettings({
      claudeDir: join(root, 'home', '.claude'),
      projects: [
        { root: join(root, 'work', 'shop'), dirs: [join(root, 'work', 'shop')] },
        { root: join(root, 'work', 'blog'), dirs: [join(root, 'work', 'blog')] },
      ],
    });
    expect(await tree(root)).toEqual(before);
  });

  it('looks in no directory given as a relative path', async () => {
    await put('rel/.claude/settings.json', '{"permissions":{"allow":["Bash"]}}');
    const files = await readRuleSettings({
      claudeDir: join(root, 'nowhere'),
      projects: [{ root: 'rel', dirs: ['rel'] }],
    });
    expect(files).toEqual([]);
  });
});

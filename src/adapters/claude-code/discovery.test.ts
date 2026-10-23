import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionSource } from '../../core/adapter.js';
import {
  agentMeta,
  aiTitle,
  assistantBlocks,
  at,
  customTitle,
  journalLine,
  peerMessage,
  rawRecord,
  toolResult,
  userPrompt,
  workflowState,
} from './__fixtures__/builders.js';
import { createClaudeCodeAdapter } from './index.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const DEAD_PID = 2147483646;

let claudeDir: string;
const jsonl = (lines: (string | string[])[]) => `${lines.flat().join('\n')}\n`;

async function put(path: string, content: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  // Session locations are realpaths (macOS tmpdir is behind /private).
  claudeDir = await realpath(await mkdtemp(join(tmpdir(), 'glassbox-claude-')));
});
afterEach(async () => {
  await rm(claudeDir, { recursive: true, force: true });
});

describe('discover', () => {
  it('summarises each main transcript from its head and tail', async () => {
    const proj = join(claudeDir, 'projects', '-work-alpha');
    await put(
      join(proj, `${S1}.jsonl`),
      jsonl([
        userPrompt({
          sessionId: S1,
          text: 'make   the tests pass',
          ts: at(0),
          cwd: '/work/alpha',
          version: '2.1.300',
        }),
        assistantBlocks({
          sessionId: S1,
          requestId: 'r1',
          blocks: ['text'],
          blockTs: [at(30)],
          model: 'claude-sonnet-5-5',
          version: '2.1.308',
        }),
      ]),
    );
    const adapter = createClaudeCodeAdapter({ claudeDir });
    const sources = await adapter.discover();
    expect(sources).toHaveLength(1);
    const s = sources[0] as SessionSource;
    expect(s).toMatchObject({
      agent: 'claude-code',
      nativeId: S1,
      location: join(proj, `${S1}.jsonl`),
    });
    expect(s.summary).toEqual({
      id: `claude-code:${S1}`,
      agent: 'claude-code',
      nativeId: S1,
      title: 'make the tests pass',
      cwd: '/work/alpha',
      project: 'alpha',
      startedAt: at(0),
      updatedAt: at(30),
      live: 'closed',
      version: '2.1.308',
      model: 'claude-sonnet-5-5',
      usage: null,
      counts: null,
    });
  });

  it('titles: session name over AI title; slash commands cleaned; peer-only sessions titled', async () => {
    const proj = join(claudeDir, 'projects', '-work-alpha');
    const S3 = '33333333-3333-4333-8333-333333333333';
    const command = userPrompt({
      sessionId: S1,
      text: '<command-name>/model</command-name>\n<command-args>opus</command-args>',
      origin: null,
    });
    await put(join(proj, `${S1}.jsonl`), jsonl([command]));
    await put(
      join(proj, `${S2}.jsonl`),
      jsonl([
        command,
        aiTitle({ title: 'AI', sessionId: S2 }),
        rawRecord('agent-name', { agentName: 'whitefish-7e', sessionId: S2 }),
      ]),
    );
    await put(
      join(proj, `${S3}.jsonl`),
      jsonl([peerMessage({ sessionId: S3, text: 'from a peer' })]),
    );
    const sources = await createClaudeCodeAdapter({ claudeDir }).discover();
    expect(Object.fromEntries(sources.map((s) => [s.nativeId, s.summary.title]))).toEqual({
      [S1]: '/model opus',
      [S2]: 'whitefish-7e',
      [S3]: 'from a peer',
    });
  });

  it('titles a session after its first real prompt, not a local slash command before it', async () => {
    const proj = join(claudeDir, 'projects', '-work-alpha');
    const S3 = '33333333-3333-4333-8333-333333333333';
    const local = (name: string, sessionId: string) => [
      userPrompt({
        sessionId,
        isMeta: true,
        origin: null,
        text: '<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>',
      }),
      userPrompt({
        sessionId,
        origin: null,
        text: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args></command-args>`,
      }),
      userPrompt({
        sessionId,
        origin: null,
        text: '<local-command-stdout>Done</local-command-stdout>',
      }),
    ];
    // A local command, then the real prompt: the prompt names the session.
    await put(
      join(proj, `${S1}.jsonl`),
      jsonl([
        ...local('/effort', S1),
        userPrompt({ sessionId: S1, text: 'fix the flaky login test' }),
        ...assistantBlocks({ sessionId: S1, requestId: 'r1', blocks: ['text'] }),
      ]),
    );
    // A command the model answered (a skill or custom command) still names it.
    await put(
      join(proj, `${S2}.jsonl`),
      jsonl([
        userPrompt({
          sessionId: S2,
          origin: null,
          text: '<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>the parser</command-args>',
        }),
        userPrompt({ sessionId: S2, isMeta: true, origin: null, text: 'Review the parser.' }),
        ...assistantBlocks({ sessionId: S2, requestId: 'r2', blocks: ['text'] }),
        userPrompt({ sessionId: S2, text: 'now fix what you found' }),
      ]),
    );
    // Nothing but local commands: the command is still better than no title.
    await put(join(proj, `${S3}.jsonl`), jsonl(local('/login', S3)));
    // A local command, then a message from another session: the message names it.
    const S4 = '44444444-4444-4444-8444-444444444444';
    await put(
      join(proj, `${S4}.jsonl`),
      jsonl([
        ...local('/effort', S4),
        peerMessage({ sessionId: S4, text: 'T2 assignment from the PM' }),
        ...assistantBlocks({ sessionId: S4, requestId: 'r4', blocks: ['text'] }),
      ]),
    );
    const sources = await createClaudeCodeAdapter({ claudeDir }).discover();
    expect(Object.fromEntries(sources.map((s) => [s.nativeId, s.summary.title]))).toEqual({
      [S1]: 'fix the flaky login test',
      [S2]: '/review the parser',
      [S3]: '/login',
      [S4]: 'T2 assignment from the PM',
    });
  });

  it('reads titles and times from the tail of a large file and cwd from its head', async () => {
    const proj = join(claudeDir, 'projects', '-work-big');
    const filler = Array.from({ length: 900 }, (_, i) =>
      rawRecord('progress', { pad: 'z'.repeat(400), i }),
    );
    await put(
      join(proj, `${S1}.jsonl`),
      jsonl([
        userPrompt({ sessionId: S1, ts: at(0), cwd: '/work/big' }),
        aiTitle({ title: 'Early AI title', sessionId: S1 }),
        filler,
        aiTitle({ title: 'Late AI title', sessionId: S1 }),
        assistantBlocks({ sessionId: S1, requestId: 'r9', blocks: ['text'], blockTs: [at(500)] }),
      ]),
    );
    const [s] = await createClaudeCodeAdapter({ claudeDir }).discover();
    expect(s?.summary).toMatchObject({
      cwd: '/work/big',
      project: 'big',
      title: 'Late AI title',
      startedAt: at(0),
      updatedAt: at(500),
    });
  });

  it('lists a session once when a project dir is reachable through a symlink', async () => {
    const real = join(claudeDir, 'projects', '-work-real');
    await put(join(real, `${S1}.jsonl`), jsonl([userPrompt({ sessionId: S1 })]));
    await put(join(real, `${S2}.jsonl`), jsonl([userPrompt({ sessionId: S2 })]));
    await symlink(real, join(claudeDir, 'projects', '-work-alias'));
    const sources = await createClaudeCodeAdapter({ claudeDir }).discover();
    expect(sources.map((s) => s.nativeId).sort()).toEqual([S1, S2]);
  });

  it('ignores non-session files and copes with a missing projects dir', async () => {
    expect(await createClaudeCodeAdapter({ claudeDir }).discover()).toEqual([]);
    const proj = join(claudeDir, 'projects', '-work-x');
    await put(join(proj, 'notes.txt'), 'hi');
    await put(join(proj, `${S1}`, 'subagents', 'agent-a1.jsonl'), jsonl([userPrompt()]));
    expect(await createClaudeCodeAdapter({ claudeDir }).discover()).toEqual([]);
  });

  it('marks sessions with a live process', async () => {
    const proj = join(claudeDir, 'projects', '-work-alpha');
    await put(join(proj, `${S1}.jsonl`), jsonl([userPrompt({ sessionId: S1 })]));
    await put(
      join(claudeDir, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: S1, status: 'busy' }),
    );
    const [s] = await createClaudeCodeAdapter({ claudeDir }).discover();
    expect(s?.summary.live).toBe('busy');
  });
});

describe('files', () => {
  async function sessionWithEverything() {
    const proj = join(claudeDir, 'projects', '-work-alpha');
    const main = join(proj, `${S1}.jsonl`);
    const dir = join(proj, S1);
    await put(main, jsonl([userPrompt({ sessionId: S1 })]));
    await put(join(dir, 'subagents', 'agent-a1.jsonl'), jsonl([userPrompt({ agentId: 'a1' })]));
    await put(join(dir, 'subagents', 'agent-a1.meta.json'), JSON.stringify(agentMeta()));
    await put(join(dir, 'subagents', 'agent-a1.prefix.json'), '{}');
    await put(join(dir, 'tool-results', 'x.txt'), 'big output');
    const wf = join(dir, 'subagents', 'workflows', 'wf_run1');
    await put(join(wf, 'journal.jsonl'), `${journalLine({ type: 'launched' })}\n`);
    await put(join(wf, 'agent-w1.jsonl'), jsonl([userPrompt({ agentId: 'w1' })]));
    await put(
      join(wf, 'agent-w1.meta.json'),
      JSON.stringify(agentMeta({ workflowPhase: 'Build' })),
    );
    await put(
      join(dir, 'workflows', 'wf_run1.json'),
      JSON.stringify(workflowState({ runId: 'wf_run1' })),
    );
    const adapter = createClaudeCodeAdapter({ claudeDir });
    const [source] = await adapter.discover();
    return { adapter, source: source as SessionSource, main, dir, wf, proj };
  }

  it('lists and classifies every file of a session', async () => {
    const { adapter, source, main, dir, wf } = await sessionWithEverything();
    const files = await adapter.listFiles(source);
    const rows = files
      .map((f) => [f.path, f.format, f.role, f.agentId, f.workflowRunId])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(rows).toEqual(
      [
        [main, 'jsonl', 'main', null, null],
        [join(dir, 'subagents', 'agent-a1.jsonl'), 'jsonl', 'subagent', 'a1', null],
        [join(dir, 'subagents', 'agent-a1.meta.json'), 'json', 'subagent-meta', 'a1', null],
        [join(wf, 'agent-w1.jsonl'), 'jsonl', 'workflow-agent', 'w1', 'wf_run1'],
        [join(wf, 'agent-w1.meta.json'), 'json', 'workflow-agent-meta', 'w1', 'wf_run1'],
        [join(wf, 'journal.jsonl'), 'jsonl', 'workflow-journal', null, 'wf_run1'],
        [join(dir, 'workflows', 'wf_run1.json'), 'json', 'workflow-state', null, 'wf_run1'],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  });

  it('classifies a single path, and rejects paths of other sessions', async () => {
    const { adapter, source, dir, proj } = await sessionWithEverything();
    expect(adapter.classify(source, join(dir, 'subagents', 'agent-b2.jsonl'))).toMatchObject({
      role: 'subagent',
      agentId: 'b2',
    });
    expect(adapter.classify(source, join(dir, 'subagents', 'agent-b2.prefix.json'))).toBeNull();
    expect(adapter.classify(source, join(proj, `${S2}.jsonl`))).toBeNull();
    expect(adapter.classify(source, join(proj, S2, 'subagents', 'agent-a1.jsonl'))).toBeNull();
  });

  it('watches the project, session, sub-agent and workflow dirs', async () => {
    const { adapter, source, dir, wf, proj } = await sessionWithEverything();
    expect(adapter.watchDirs(source).sort()).toEqual(
      [
        proj,
        dir,
        join(dir, 'subagents'),
        join(dir, 'subagents', 'workflows'),
        wf,
        join(dir, 'workflows'),
      ].sort(),
    );
  });
});

describe('liveStatus', () => {
  it('maps registered live processes by session id and skips dead ones', async () => {
    const reg = join(claudeDir, 'sessions');
    const entry = (pid: number, sessionId: string, status: string) =>
      put(join(reg, `${pid}-${sessionId}.json`), JSON.stringify({ pid, sessionId, status }));
    await entry(process.pid, 'busy-s', 'busy');
    await entry(process.pid, 'wait-s', 'waiting');
    await entry(process.pid, 'idle-s', 'idle');
    await entry(process.pid, 'shell-s', 'shell');
    await entry(process.pid, 'odd-s', 'compacting');
    await entry(DEAD_PID, 'dead-s', 'busy');
    await put(join(reg, 'broken.json'), '{nope');
    await put(join(reg, `${process.pid}.abc.key`), 'not json');
    const live = await createClaudeCodeAdapter({ claudeDir }).liveStatus();
    expect(Object.fromEntries(live)).toEqual({
      'busy-s': 'busy',
      'wait-s': 'waiting',
      'idle-s': 'idle',
      'shell-s': 'idle',
      'odd-s': 'unknown',
    });
  });

  it('is empty without a sessions dir', async () => {
    expect((await createClaudeCodeAdapter({ claudeDir }).liveStatus()).size).toBe(0);
  });

  it('an entry whose status is not a known word is unknown, however it is shaped', async () => {
    const reg = join(claudeDir, 'sessions');
    const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
    const at = (sessionId: string, status: string) =>
      put(
        join(reg, `${process.pid}-${sessionId}.json`),
        `{"pid":${process.pid},"sessionId":"${sessionId}","status":${status}}`,
      );
    await at('deep-s', deep);
    await at('proto-s', '"toString"');
    const live = await createClaudeCodeAdapter({ claudeDir }).liveStatus();
    expect(Object.fromEntries(live)).toEqual({ 'deep-s': 'unknown', 'proto-s': 'unknown' });
  });
});

describe('createParser', () => {
  it('returns a parser for the source', async () => {
    const proj = join(claudeDir, 'projects', '-work-alpha');
    await put(join(proj, `${S1}.jsonl`), jsonl([userPrompt({ sessionId: S1 })]));
    const adapter = createClaudeCodeAdapter({ claudeDir });
    const [source] = await adapter.discover();
    const parser = adapter.createParser(source as SessionSource);
    const [file] = await adapter.listFiles(source as SessionSource);
    parser.ingestLines(file as never, [userPrompt({ sessionId: S1, text: 'hi' })]);
    expect(parser.snapshot().turns).toHaveLength(1);
    expect(adapter.kind).toBe('claude-code');
  });
});

describe('probe sessions', () => {
  it('tags sessions titled "ClaudeBar Probe" or run in a ClaudeBar/Probe dir', async () => {
    const probeDir = join(claudeDir, 'Library', 'ClaudeBar', 'Probe');
    await mkdir(probeDir, { recursive: true });
    await symlink(probeDir, join(claudeDir, 'probe-link'));
    const proj = join(claudeDir, 'projects', '-work-alpha');
    await put(
      join(proj, `${S1}.jsonl`),
      jsonl([
        userPrompt({ sessionId: S1, text: '/usage' }),
        customTitle({ title: 'ClaudeBar Probe', sessionId: S1 }),
      ]),
    );
    await put(
      join(proj, `${S2}.jsonl`),
      jsonl([userPrompt({ sessionId: S2, cwd: join(claudeDir, 'probe-link') })]),
    );
    const S3 = '33333333-3333-4333-8333-333333333333';
    await put(join(proj, `${S3}.jsonl`), jsonl([userPrompt({ sessionId: S3 })]));
    const sources = await createClaudeCodeAdapter({ claudeDir }).discover();
    const tags = Object.fromEntries(sources.map((s) => [s.nativeId, s.summary.tags]));
    expect(tags).toEqual({ [S1]: ['probe'], [S2]: ['probe'], [S3]: undefined });
  });

  it('tags a session whose live registry entry is the probe', async () => {
    const proj = join(claudeDir, 'projects', '-work-alpha');
    await put(join(proj, `${S1}.jsonl`), jsonl([userPrompt({ sessionId: S1 })]));
    await put(
      join(claudeDir, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: S1, status: 'busy', name: 'ClaudeBar Probe' }),
    );
    const [s] = await createClaudeCodeAdapter({ claudeDir }).discover();
    expect(s?.summary).toMatchObject({ live: 'busy', tags: ['probe'] });
  });
});

describe('discovery window edges', () => {
  const filler = () =>
    Array.from({ length: 900 }, (_, i) => rawRecord('progress', { pad: 'z'.repeat(400), i }));
  const bigImage = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(200_000) },
  };

  it('a first line over 64 KB still gives cwd, start time and title', async () => {
    const proj = join(claudeDir, 'projects', '-work-pics');
    await put(
      join(proj, `${S1}.jsonl`),
      jsonl([
        userPrompt({
          sessionId: S1,
          ts: at(0),
          cwd: '/work/pics',
          contentBlocks: [{ type: 'text', text: 'describe this screenshot' }, bigImage],
        }),
        filler(),
        assistantBlocks({ sessionId: S1, requestId: 'r1', blocks: ['text'], blockTs: [at(30)] }),
      ]),
    );
    const [s] = await createClaudeCodeAdapter({ claudeDir }).discover();
    expect(s?.summary).toMatchObject({
      startedAt: at(0),
      cwd: '/work/pics',
      project: 'pics',
      title: 'describe this screenshot',
      updatedAt: at(30),
    });
  });

  it('a last line over 256 KB still gives the update time and the latest title', async () => {
    const proj = join(claudeDir, 'projects', '-work-big');
    await put(
      join(proj, `${S1}.jsonl`),
      jsonl([
        userPrompt({ sessionId: S1, ts: at(0), cwd: '/work/big', text: 'hello there' }),
        filler(),
        aiTitle({ title: 'Fixing the parser', sessionId: S1 }),
        toolResult({
          sessionId: S1,
          toolUseId: 'toolu_big',
          content: 'x'.repeat(400_000),
          ts: at(900),
        }),
      ]),
    );
    const [s] = await createClaudeCodeAdapter({ claudeDir }).discover();
    expect(s?.summary).toMatchObject({
      updatedAt: at(900),
      title: 'Fixing the parser',
      startedAt: at(0),
    });
  });

  it('re-reads a session when it changes, and keeps live state fresh without re-reading', async () => {
    const proj = join(claudeDir, 'projects', '-work-alpha');
    const path = join(proj, `${S1}.jsonl`);
    await put(path, jsonl([userPrompt({ sessionId: S1, text: 'first title' })]));
    const adapter = createClaudeCodeAdapter({ claudeDir });
    expect((await adapter.discover())[0]?.summary).toMatchObject({
      title: 'first title',
      live: 'closed',
    });
    await appendFile(path, jsonl([customTitle({ title: 'Renamed', sessionId: S1 })]));
    await put(
      join(claudeDir, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: S1, status: 'busy' }),
    );
    expect((await adapter.discover())[0]?.summary).toMatchObject({
      title: 'Renamed',
      live: 'busy',
    });
  });
});

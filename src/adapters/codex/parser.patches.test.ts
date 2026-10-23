/**
 * Live-update completeness: each scenario is fed one line at a time, patches are applied to a
 * client-side store, and the store must equal a fresh snapshot after every step.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChangeSet } from '../../core/adapter.js';
import { mergeChanges } from '../../core/changes.js';
import { checkSnapshot } from '../../core/invariants.js';
import type { SessionSnapshot } from '../../core/model.js';
import { applyPatch } from '../../server/__tests__/apply-patch.js';
import {
  CHILD_ID,
  gardenSession,
  line,
  SESSION_ID,
  sessionMeta,
  TURN_1,
  TURN_2,
  tokenCount,
  unix,
  usage,
} from './__fixtures__/builders.js';
import { childFile, mainFile, makeSource, replayChecked } from './__fixtures__/harness.js';
import { CodexSessionParser } from './parser.js';

const pass = (turnId: string) => ({
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});

/** A turn whose usage comes only from token_count (older rollouts), then an aborted turn. */
function tokenCountSession(): string[] {
  return [
    sessionMeta(),
    line('event_msg', 1, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
    line('response_item', 2, 2, {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Sort the seeds' }],
      ...pass(TURN_1),
    }),
    line('response_item', 3, 3, {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'x',
      ...pass(TURN_1),
    }),
    line('response_item', 4, 3, {
      type: 'function_call',
      name: 'js',
      call_id: 'call_js',
      arguments: '{}',
      ...pass(TURN_1),
    }),
    tokenCount(5, 4, 100, 60, 8, 2),
    line('response_item', 6, 5, {
      type: 'function_call_output',
      call_id: 'call_js',
      output: 'ok',
      ...pass(TURN_1),
    }),
    line('response_item', 7, 6, {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Sorted.' }],
      ...pass(TURN_1),
    }),
    tokenCount(8, 6, 120, 100, 4, 0),
    tokenCount(9, 6, 120, 100, 4, 0),
    line('event_msg', 10, 7, { type: 'task_complete', turn_id: TURN_1, completed_at: unix(7) }),
    line('event_msg', 11, 8, { type: 'task_started', turn_id: TURN_2, started_at: unix(8) }),
    line('response_item', 12, 9, {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'x',
      ...pass(TURN_2),
    }),
    line('event_msg', 13, 10, { type: 'turn_aborted', turn_id: TURN_2, reason: 'interrupted' }),
  ];
}

/** A parent that spawns a sub-agent, and the child's own rollout. */
function spawnSession(): { main: string[]; child: string[] } {
  return {
    main: [
      sessionMeta(),
      line('event_msg', 1, 1, { type: 'task_started', turn_id: TURN_1, started_at: unix(1) }),
      line('response_item', 2, 2, {
        type: 'function_call',
        name: 'spawn_agent',
        namespace: 'collaboration',
        call_id: 'call_spawn',
        arguments: '{}',
        ...pass(TURN_1),
      }),
      line('event_msg', 3, 2, {
        type: 'item_completed',
        item: {
          type: 'SubAgentActivity',
          id: 'call_spawn',
          agent_thread_id: CHILD_ID,
          agent_path: 'helper',
          kind: 'started',
        },
      }),
      usage({ ordinal: 4, sec: 3, responseId: 'resp_p1', turnId: TURN_1, input: 50, output: 5 }),
      line('event_msg', 5, 9, { type: 'task_complete', turn_id: TURN_1, completed_at: unix(9) }),
    ],
    child: [
      line('session_meta', 0, 2, {
        id: CHILD_ID,
        session_id: CHILD_ID,
        timestamp: '2026-01-01T00:00:02.000Z',
        parent_thread_id: SESSION_ID,
        agent_path: 'helper',
        agent_nickname: 'Helper',
      }),
      line('event_msg', 1, 2, { type: 'task_started', turn_id: 'child-turn', started_at: unix(2) }),
      line('response_item', 2, 3, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'On it.' }],
        ...pass('child-turn'),
      }),
      usage({
        ordinal: 3,
        sec: 4,
        responseId: 'resp_c1',
        turnId: 'child-turn',
        input: 30,
        output: 3,
      }),
      line('event_msg', 4, 5, {
        type: 'task_complete',
        turn_id: 'child-turn',
        completed_at: unix(5),
      }),
    ],
  };
}

describe('patches keep a live client equal to the snapshot', () => {
  it('a multi-response turn with tools and usage records, through a close', () => {
    const { parser, problems } = replayChecked([
      { file: mainFile, lines: gardenSession() },
      { live: 'closed' },
    ]);
    expect(problems).toEqual([]);
    expect(checkSnapshot(parser.snapshot())).toEqual([]);
  });

  it('token_count-only usage and an aborted turn', () => {
    expect(
      replayChecked([{ file: mainFile, lines: tokenCountSession() }, { live: 'closed' }]).problems,
    ).toEqual([]);
  });

  it('a spawned sub-agent, child file first or parent first', () => {
    const s = spawnSession();
    expect(
      replayChecked([
        { file: mainFile, lines: s.main },
        { file: childFile, lines: s.child },
      ]).problems,
    ).toEqual([]);
    expect(
      replayChecked([
        { file: childFile, lines: s.child },
        { file: mainFile, lines: s.main },
      ]).problems,
    ).toEqual([]);
  });

  it('an archive that cannot be read shows up in diagnostics', () => {
    const archived = {
      ...mainFile,
      path: '/codex/archived_sessions/broken.jsonl.zst',
      role: 'archived-unavailable',
    };
    const { parser, problems } = replayChecked([
      { file: mainFile, lines: gardenSession() },
      { file: archived, lines: ['x'] },
    ]);
    expect(problems).toEqual([]);
    expect(parser.snapshot().diagnostics.unavailable).toContain('archived-sessions');
  });
});

const KINDS = ['agents', 'turns', 'requests', 'toolCalls', 'workflows'] as const;

describe('change sets are worked out when they are read', () => {
  const batches = (lines: string[], n: number) =>
    Array.from({ length: n }, (_, i) =>
      lines.slice(Math.floor((i * lines.length) / n), Math.floor(((i + 1) * lines.length) / n)),
    );

  it('a load whose change sets nobody reads builds the views once, not once per batch', () => {
    const build = vi.spyOn(
      CodexSessionParser.prototype as unknown as { build: () => SessionSnapshot },
      'build',
    );
    try {
      const p = new CodexSessionParser(makeSource('closed'));
      for (const batch of batches(gardenSession(), 20)) p.ingestLines(mainFile, batch);
      p.setLive('busy');
      p.snapshot();
      expect(build.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      build.mockRestore();
    }
  });

  it('one read late names what the unread ones before it touched', () => {
    const p = new CodexSessionParser(makeSource('closed'));
    p.ingestLines(
      mainFile,
      gardenSession().filter((l) => l !== '{'),
    );
    // On its own this line is a parse error, and touches nothing else.
    const late = p.ingestLines(mainFile, ['{']);
    expect(late.diagnostics).toBe(true);
    expect(late.turns).toEqual([TURN_1]);
    expect(late.requests).toEqual(expect.arrayContaining(['resp_1', 'resp_2']));
  });

  it('read late and merged in order, with snapshots for other clients between, a follower keeps up', () => {
    const s = spawnSession();
    const feed = [
      ...batches(s.main, 4).map((lines) => ({ file: mainFile, lines })),
      ...batches(s.child, 3).map((lines) => ({ file: childFile, lines })),
      ...batches(gardenSession().slice(1), 5).map((lines) => ({ file: mainFile, lines })),
    ];
    for (let seed = 1; seed <= 30; seed++) {
      let x = seed;
      const rand = (n: number) => {
        x = (x * 1103515245 + 12345) % 2 ** 31;
        return x % n;
      };
      const p = new CodexSessionParser(makeSource('busy'));
      let client = p.snapshot();
      let unread: ChangeSet[] = [];
      const catchUp = () => {
        const patch = p.patch(mergeChanges(...unread));
        unread = [];
        client = applyPatch(client, patch);
      };
      for (const step of feed) {
        unread.push(p.ingestLines(step.file, step.lines));
        // Another client opens the session: the parser hands out a snapshot mid-stream.
        if (rand(3) === 0) p.snapshot();
        if (rand(2) === 0) catchUp();
      }
      unread.push(p.setLive('closed'));
      catchUp();
      // Clients key entities by id; a patch appends where a snapshot sorts.
      const byId = (snap: SessionSnapshot) => ({
        ...snap,
        ...Object.fromEntries(
          KINDS.map((k) => [k, [...snap[k]].sort((a, b) => a.id.localeCompare(b.id))]),
        ),
      });
      expect([seed, byId(client)]).toEqual([seed, byId(p.snapshot())]);
    }
  });
});

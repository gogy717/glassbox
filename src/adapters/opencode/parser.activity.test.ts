import { describe, expect, it } from 'vitest';
import {
  at,
  ROOT_ID,
  reasoning,
  SessionBuilder,
  stepStart,
  text,
  tool,
} from './__fixtures__/builders.js';
import { feed } from './__fixtures__/harness.js';

/** A reply OpenCode is still writing to its database: no completion time yet. */
function open() {
  const b = new SessionBuilder();
  const u = b.user(ROOT_ID, 1, text('build it'));
  const a = b.assistant(ROOT_ID, u, 2, { completedSec: null });
  b.part(a, 2, stepStart());
  b.part(a, 3, reasoning('Plan the build.', 3, 4));
  return { b, a };
}

describe('activity of a live OpenCode session', () => {
  it('thinks until the reply has text, then writes it', () => {
    const { b, a } = open();
    expect(feed(b.doc(), 'busy').snapshot().session.activity).toEqual({
      kind: 'thinking',
      tool: null,
      target: null,
      agentId: 'main',
      since: at(2),
    });
    // The text part streams in: it has a start and no end yet.
    b.part(a, 5, text('Building now', 5));
    expect(feed(b.doc(), 'busy').snapshot().session.activity).toMatchObject({
      kind: 'writing',
      since: at(2),
    });
  });

  it('names a running tool, and a pending one from its raw input', () => {
    const { b, a } = open();
    b.part(
      a,
      5,
      tool({
        callId: 'c1',
        name: 'bash',
        status: 'running',
        input: { command: 'make' },
        startSec: 5,
      }),
    );
    expect(feed(b.doc(), 'busy').snapshot().session.activity).toEqual({
      kind: 'tool',
      tool: 'bash',
      target: 'make',
      agentId: 'main',
      since: at(5),
    });

    const { b: b2, a: a2 } = open();
    b2.part(
      a2,
      6,
      tool({
        callId: 'c2',
        name: 'read',
        status: 'pending',
        input: { filePath: '/home/user/garden/beds.md' },
      }),
    );
    expect(feed(b2.doc(), 'busy').snapshot().session.activity).toMatchObject({
      tool: 'read',
      target: 'beds.md',
    });
  });

  it('is absent once the session is closed', () => {
    const { b } = open();
    expect('activity' in feed(b.doc(), 'closed').snapshot().session).toBe(false);
  });
});

describe('what a live OpenCode session last said', () => {
  it('is the reply’s latest text, as far as it has been written, and absent once closed', () => {
    const { b, a } = open();
    expect(feed(b.doc(), 'busy').snapshot().session.lastReply).toBeNull();
    b.part(a, 5, text('Building now', 5));
    const parser = feed(b.doc(), 'busy');
    expect(parser.snapshot().session.lastReply).toBe('Building now');
    parser.setLive('closed');
    expect('lastReply' in parser.snapshot().session).toBe(false);
  });
});

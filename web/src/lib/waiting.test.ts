import { describe, expect, it } from 'vitest';
import type { SessionActivity, SessionSummary } from '../../../src/core/model.js';
import { makeI18n } from '../i18n';
import { longestWaitFirst, waitingSince, waitKind, waitLabel } from './waiting';

const waiting = (tool: string | null, since: string | null = null): SessionActivity => ({
  kind: 'waiting',
  tool,
  target: null,
  agentId: 'main',
  since,
});

describe('waitKind', () => {
  it('is a permission for a tool, a question for an ask tool, else your turn', () => {
    expect(waitKind(waiting('Bash'))).toBe('permission');
    expect(waitKind(waiting('mcp__linear__get_issue'))).toBe('permission');
    expect(waitKind(waiting('AskUserQuestion'))).toBe('question');
    expect(waitKind(waiting('request_user_input'))).toBe('question');
    expect(waitKind(waiting(null))).toBe('turn');
    expect(waitKind(undefined)).toBe('turn');
  });
});

describe('waitLabel', () => {
  it('words the wait on one line, in both languages', () => {
    const en = makeI18n('en').t;
    const zh = makeI18n('zh').t;
    expect(waitLabel(en, waiting('Bash'))).toBe('Permission · Bash');
    expect(waitLabel(en, waiting('AskUserQuestion'))).toBe('Question');
    expect(waitLabel(en, undefined)).toBe('Your turn');
    expect(waitLabel(zh, waiting('Bash'))).toBe('权限 · Bash');
    expect(waitLabel(zh, waiting('AskUserQuestion'))).toBe('有问题问你');
    expect(waitLabel(zh, undefined)).toBe('轮到你了');
  });
});

describe('waitingSince and longestWaitFirst', () => {
  const s = (updatedAt: string | undefined, activity?: SessionActivity) =>
    ({ updatedAt, activity }) as unknown as SessionSummary;
  const t1 = '2026-10-24T10:00:01.000Z';
  const t2 = '2026-10-24T10:00:02.000Z';
  const t3 = '2026-10-24T10:00:03.000Z';

  it('reads the prompt’s or the tool’s start, else the last write', () => {
    expect(waitingSince(s(t2, waiting('Bash', t1)))).toBe(t1);
    expect(waitingSince(s(t2, waiting(null)))).toBe(t2);
    expect(waitingSince(s(t2))).toBe(t2);
    expect(waitingSince(s(undefined))).toBeNull();
  });

  it('sorts the longest wait first and an unknown start last', () => {
    const a = s(t3, waiting('Bash', t2));
    const b = s(t1);
    const c = s(undefined);
    const d = s(t3, waiting('Read', t3));
    expect([c, d, a, b].sort(longestWaitFirst)).toEqual([b, a, d, c]);
  });
});

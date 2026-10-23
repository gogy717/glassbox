import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_SESSION_ID } from '../core/fixtures/demo.js';
import type { RunState } from '../shared/runs.js';
import { DemoRuns } from './demo-runs.js';

let runs: DemoRuns;
let seen: RunState[];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-23T02:00:00.000Z') });
  runs = new DemoRuns();
  seen = [];
  runs.onRun((r) => seen.push(r));
});

afterEach(() => {
  runs.stop();
  vi.useRealTimers();
});

const latest = () => seen.at(-1) as RunState;
/** Advance until the run asks for permission (or the budget runs out). */
async function untilStatus(status: RunState['status'], budgetMs = 30_000) {
  for (let t = 0; t < budgetMs && latest()?.status !== status; t += 50)
    await vi.advanceTimersByTimeAsync(50);
  expect(latest().status).toBe(status);
  return latest();
}

const status = (err: unknown) => (err as { status?: number }).status;

describe('DemoRuns', () => {
  it('scripts a whole turn: thinking, text, a Bash call, two prompts, then idle', async () => {
    const run = await runs.start({ mode: 'new', cwd: '/tmp', prompt: 'hi' });
    expect(run.status).toBe('starting');

    const asking = await untilStatus('waiting-permission');
    expect(asking.sessionId).toBe(DEMO_SESSION_ID);
    // The streamed message grew piece by piece before the prompt.
    const partials = seen.map((r) => r.partial).filter((p) => p !== null);
    // Like Claude Code 2.1.308: thinking streams a token estimate, never text.
    expect(partials.every((p) => p?.thinking === '')).toBe(true);
    const tokens = partials
      .map((p) => p?.thinkingTokens)
      .filter((n): n is number => n !== null && n !== undefined);
    expect(Math.max(...tokens)).toBeGreaterThanOrEqual(200);
    for (let i = 1; i < tokens.length; i++)
      expect(tokens[i] as number).toBeGreaterThanOrEqual(tokens[i - 1] as number);
    expect(new Set(tokens).size).toBeGreaterThan(3);
    expect(new Set(partials.map((p) => p?.text)).size).toBeGreaterThan(3);
    const tool = partials.at(-1)?.toolUses[0];
    expect(tool?.name).toBe('Bash');
    expect(JSON.parse(tool?.inputJson ?? '')).toEqual({
      command: 'npm test',
      description: 'Run the test suite',
    });
    expect(new Set(partials.map((p) => p?.toolUses[0]?.inputJson)).size).toBeGreaterThan(2);
    expect(asking.partial).toBeNull();
    const [bash] = asking.pendingPermissions;
    expect(bash).toMatchObject({
      toolName: 'Bash',
      input: { command: 'npm test' },
      questions: null,
    });

    runs.decide(run.id, bash?.id as string, { decision: 'allow' });
    expect(latest().status).toBe('running');
    expect(latest().pendingPermissions).toEqual([]);

    const question = await untilStatus('waiting-permission');
    const askTool = seen
      .map((r) => r.partial?.toolUses[0])
      .filter((t) => t?.name === 'AskUserQuestion')
      .at(-1);
    expect(JSON.parse(askTool?.inputJson ?? '')).toEqual({
      questions: question.pendingPermissions[0]?.questions,
    });
    const [ask] = question.pendingPermissions;
    expect(ask?.toolName).toBe('AskUserQuestion');
    expect(ask?.questions).toHaveLength(2);
    expect(ask?.questions?.map((q) => q.multiSelect).sort()).toEqual([false, true]);
    expect(ask?.questions?.every((q) => q.options.length >= 2)).toBe(true);

    const answers = Object.fromEntries(
      (ask?.questions ?? []).map((q) => [
        q.question,
        q.multiSelect ? q.options.map((o) => o.label) : (q.options[0]?.label as string),
      ]),
    );
    runs.decide(run.id, ask?.id as string, { decision: 'allow', answers });

    const done = await untilStatus('idle');
    expect(done.partial).toBeNull();
    expect(done.last).toEqual({
      costUsd: expect.any(Number),
      durationMs: expect.any(Number),
      numTurns: 3,
    });
    expect(runs.list()).toEqual([done]);
  });

  it('emits at most 20 updates per second per run', async () => {
    await runs.start({ mode: 'new', cwd: '/tmp', prompt: 'hi' });
    await untilStatus('waiting-permission');
    const times = seen.map((r) => Date.parse(r.updatedAt));
    for (let i = 20; i < times.length; i++)
      expect((times[i] as number) - (times[i - 20] as number)).toBeGreaterThanOrEqual(1000);
  });

  it('refuses follow-ups until idle, then runs a short turn', async () => {
    const run = await runs.start({ mode: 'fork', sessionId: DEMO_SESSION_ID, prompt: 'hi' });
    try {
      runs.send(run.id, 'more');
      expect.unreachable();
    } catch (err) {
      expect(status(err)).toBe(409);
      expect((err as Error).message).toBe('Wait for the current reply to finish');
    }

    await runs.interrupt(run.id);
    expect(latest()).toMatchObject({ status: 'idle', partial: null, pendingPermissions: [] });

    runs.send(run.id, 'and now?');
    expect(latest().status).toBe('running');
    await untilStatus('idle');
    expect(latest().last?.numTurns).toBe(1);
  });

  it('applies the mode rules of the real runner', async () => {
    // The demo session is live (busy), so it can only be forked, not resumed.
    await expect(
      runs.start({ mode: 'resume', sessionId: DEMO_SESSION_ID, prompt: 'x' }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'This session is running elsewhere; use “Continue in a copy” instead',
    });
    await expect(
      runs.start({ mode: 'fork', sessionId: 'claude-code:nope', prompt: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('answers 404 for unknown runs and permission requests', async () => {
    const run = await runs.start({ mode: 'new', cwd: '/tmp', prompt: 'hi' });
    for (const call of [
      () => runs.send('nope', 'x'),
      () => runs.close('nope'),
      () => runs.decide('nope', 'p', { decision: 'allow' }),
      () => runs.decide(run.id, 'nope', { decision: 'allow' }),
    ]) {
      try {
        call();
        expect.unreachable();
      } catch (err) {
        expect(status(err)).toBe(404);
      }
    }
    await expect(runs.interrupt('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('closing a run stops it for good', async () => {
    const run = await runs.start({ mode: 'new', cwd: '/tmp', prompt: 'hi' });
    await vi.advanceTimersByTimeAsync(1000);
    runs.close(run.id);
    expect(latest().status).toBe('closed');
    const count = seen.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands out copies', async () => {
    const run = await runs.start({ mode: 'new', cwd: '/tmp', prompt: 'hi' });
    run.status = 'error';
    expect(runs.list()[0]?.status).toBe('starting');
  });
});

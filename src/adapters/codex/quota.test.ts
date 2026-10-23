import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, CWD, line, ms, tokenCount } from './__fixtures__/builders.js';
import {
  PROTOCOL_EXAMPLE_LINE,
  plusLimits,
  rateLimits,
  tokenCountWithLimits,
} from './__fixtures__/rate-limits.js';
import { createCodexAdapter } from './index.js';
import { codexPlanName, quotaFromRolloutLines, windowKind } from './quota.js';

/** Ten minutes after the fixtures' records. */
const NOW = ms(600);

describe('quotaFromRolloutLines', () => {
  it('maps the last rate limits of a ChatGPT sign-in to an openai snapshot', () => {
    expect(
      quotaFromRolloutLines(
        [tokenCountWithLimits(1, 10, plusLimits(5, 30)), tokenCountWithLimits(2, 20, plusLimits())],
        NOW,
      ),
    ).toEqual({
      provider: 'openai',
      agent: 'codex',
      plan: 'Plus',
      fetchedAt: at(20),
      stale: false,
      windows: [
        {
          id: 'primary',
          kind: 'session',
          label: null,
          model: null,
          usedPercent: 12.5,
          resetsAt: '2026-01-01T02:00:00.000Z',
        },
        {
          id: 'secondary',
          kind: 'weekly',
          label: null,
          model: null,
          usedPercent: 40,
          resetsAt: '2026-01-07T00:00:00.000Z',
        },
      ],
      extraUsage: null,
      balance: null,
      source: 'codex-session',
    });
  });

  it('skips token counts without rate limits, other records and broken lines', () => {
    const q = quotaFromRolloutLines(
      [
        tokenCountWithLimits(1, 10, plusLimits()),
        tokenCountWithLimits(2, 20, null),
        tokenCount(3, 30, 10, 0, 2, 0),
        line('event_msg', 4, 40, { type: 'token_count', info: null, rate_limits: 'soon' }),
        line('response_item', 5, 50, { type: 'message', role: 'assistant', content: [] }),
        '{"timestamp":',
        '',
      ],
      NOW,
    );
    expect(q?.fetchedAt).toBe(at(10));
    expect(q?.windows.map((w) => w.usedPercent)).toEqual([12.5, 40]);
  });

  it("reads the example line from Codex's own rollout tests", () => {
    expect(
      quotaFromRolloutLines([PROTOCOL_EXAMPLE_LINE], Date.parse('2025-01-03T12:30:00Z')),
    ).toEqual({
      provider: 'openai',
      agent: 'codex',
      plan: null,
      fetchedAt: '2025-01-03T12:00:00.000Z',
      stale: false,
      windows: [
        {
          id: 'primary',
          kind: 'session',
          label: null,
          model: null,
          usedPercent: 0,
          resetsAt: new Date(1800000000 * 1000).toISOString(),
        },
        {
          id: 'secondary',
          kind: 'weekly',
          label: null,
          model: null,
          usedPercent: 12.5,
          resetsAt: new Date(1800100000 * 1000).toISOString(),
        },
      ],
      extraUsage: null,
      balance: null,
      source: 'codex-session',
    });
  });

  it('is null when no record carries rate limits (an API-key sign-in)', () => {
    expect(quotaFromRolloutLines([tokenCountWithLimits(1, 10, null)], NOW)).toBeNull();
    expect(quotaFromRolloutLines([], NOW)).toBeNull();
    expect(
      quotaFromRolloutLines([tokenCountWithLimits(1, 10, rateLimits({ plan_type: 'plus' }))], NOW),
    ).toBeNull();
  });

  it('is stale when the record is more than an hour old', () => {
    const lines = [tokenCountWithLimits(1, 10, plusLimits())];
    expect(quotaFromRolloutLines(lines, ms(10) + 61 * 60_000)?.stale).toBe(true);
    expect(quotaFromRolloutLines(lines, ms(10) + 59 * 60_000)?.stale).toBe(false);
  });

  it('works out a reset from the older resets_in_seconds', () => {
    const q = quotaFromRolloutLines(
      [
        tokenCountWithLimits(
          1,
          10,
          rateLimits({ primary: { used_percent: 3, window_minutes: 300, resets_in_seconds: 90 } }),
        ),
      ],
      NOW,
    );
    expect(q?.windows[0]?.resetsAt).toBe(at(100));
  });

  it('keeps a window without a usable reset or length, and drops one without a percentage', () => {
    const q = quotaFromRolloutLines(
      [
        tokenCountWithLimits(
          1,
          10,
          rateLimits({
            primary: { used_percent: 7, window_minutes: null, resets_at: 1e300 },
            secondary: { window_minutes: 10080, resets_at: 1767744000 },
          }),
        ),
      ],
      NOW,
    );
    expect(q?.windows).toEqual([
      { id: 'primary', kind: 'other', label: null, model: null, usedPercent: 7, resetsAt: null },
    ]);
  });

  it('shows a model-specific bucket as model windows next to the plan windows', () => {
    const spark = rateLimits({
      limit_id: 'codex_bengalfox',
      limit_name: 'GPT-5.3-Codex-Spark',
      primary: { used_percent: 50, window_minutes: 300, resets_at: 1767232800 },
      secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1767744000 },
    });
    const q = quotaFromRolloutLines(
      [
        tokenCountWithLimits(1, 10, plusLimits(1, 2)),
        tokenCountWithLimits(2, 20, plusLimits()),
        tokenCountWithLimits(3, 30, spark),
      ],
      NOW,
    );
    expect(q).toMatchObject({ plan: 'Plus', fetchedAt: at(30) });
    expect(q?.windows).toEqual([
      expect.objectContaining({ id: 'primary', kind: 'session', usedPercent: 12.5 }),
      expect.objectContaining({ id: 'secondary', kind: 'weekly', usedPercent: 40 }),
      {
        id: 'codex_bengalfox:secondary',
        kind: 'weekly-model',
        label: null,
        model: 'GPT-5.3-Codex-Spark',
        usedPercent: 20,
        resetsAt: '2026-01-07T00:00:00.000Z',
      },
      {
        id: 'codex_bengalfox:primary',
        kind: 'other',
        label: 'GPT-5.3-Codex-Spark (5h)',
        model: 'GPT-5.3-Codex-Spark',
        usedPercent: 50,
        resetsAt: '2026-01-01T02:00:00.000Z',
      },
    ]);
  });

  it('names a model bucket by its id when Codex gives no name', () => {
    const q = quotaFromRolloutLines(
      [
        tokenCountWithLimits(
          1,
          10,
          rateLimits({
            limit_id: 'codex_other',
            secondary: { used_percent: 9, window_minutes: 10080 },
          }),
        ),
      ],
      NOW,
    );
    expect(q?.windows).toEqual([
      expect.objectContaining({ kind: 'weekly-model', model: 'codex_other', usedPercent: 9 }),
    ]);
  });
});

describe('windowKind', () => {
  it('names a window by its length in minutes', () => {
    expect(windowKind(300)).toBe('session');
    expect(windowKind(60)).toBe('session');
    expect(windowKind(10080)).toBe('weekly');
    expect(windowKind(43200)).toBe('monthly');
    expect(windowKind(28 * 1440)).toBe('monthly');
    expect(windowKind(31 * 1440)).toBe('monthly');
    expect(windowKind(1440)).toBe('other');
    expect(windowKind(0)).toBe('other');
    expect(windowKind(null)).toBe('other');
  });
});

describe('codexPlanName', () => {
  it("uses the names Codex's /status shows", () => {
    expect(codexPlanName('free')).toBe('Free');
    expect(codexPlanName('plus')).toBe('Plus');
    expect(codexPlanName('pro')).toBe('Pro 200');
    expect(codexPlanName('prolite')).toBe('Pro 100');
    expect(codexPlanName('team')).toBe('Business');
    expect(codexPlanName('business')).toBe('Enterprise');
    expect(codexPlanName('self_serve_business_prolite')).toBe('Business Premium');
    expect(codexPlanName('edu_plus')).toBe('Edu Plus');
  });

  it('spells out a plan it does not know, and has none for unknown or missing', () => {
    expect(codexPlanName('galaxy_brain')).toBe('Galaxy Brain');
    expect(codexPlanName('unknown')).toBeNull();
    expect(codexPlanName(null)).toBeNull();
    expect(codexPlanName('')).toBeNull();
    expect(codexPlanName(3)).toBeNull();
  });
});

describe('adapter quota()', () => {
  const NEWEST = '11111111-1111-4111-8111-111111111111';
  const CHATGPT = '22222222-2222-4222-8222-222222222222';
  const OLDEST = '33333333-3333-4333-8333-333333333333';
  let codexDir: string;

  beforeEach(async () => {
    codexDir = await realpath(await mkdtemp(join(tmpdir(), 'glassbox-codex-quota-')));
  });
  afterEach(async () => {
    await rm(codexDir, { recursive: true, force: true });
  });

  async function rollout(id: string, lines: string[], mtimeSec: number): Promise<string> {
    const dir = join(codexDir, 'sessions', '2026', '01', '01');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
    const meta = line('session_meta', 0, 0, { id, session_id: id, timestamp: at(0), cwd: CWD });
    await writeFile(path, `${[meta, ...lines].join('\n')}\n`);
    const t = new Date(ms(mtimeSec));
    await utimes(path, t, t);
    return path;
  }

  it('reads the newest rollout that has rate limits, past an API-key session', async () => {
    await rollout(OLDEST, [tokenCountWithLimits(1, 5, plusLimits(90, 90))], 5);
    await rollout(CHATGPT, [tokenCountWithLimits(1, 20, plusLimits())], 20);
    await rollout(NEWEST, [tokenCountWithLimits(1, 30, null)], 30);
    const adapter = createCodexAdapter({ codexDir });
    const q = await adapter.quota?.();
    expect(q).toMatchObject({ provider: 'openai', source: 'codex-session', fetchedAt: at(20) });
    expect(q?.windows.map((w) => w.usedPercent)).toEqual([12.5, 40]);
  });

  it('is null without rollouts or rate limits', async () => {
    const adapter = createCodexAdapter({ codexDir });
    expect(await adapter.quota?.()).toBeNull();
    await rollout(NEWEST, [tokenCountWithLimits(1, 30, null)], 30);
    expect(await adapter.quota?.()).toBeNull();
  });

  it('only reads the tail of a long rollout', async () => {
    const filler = line('response_item', 2, 11, {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'x'.repeat(4 * 1024 * 1024) }],
    });
    await rollout(CHATGPT, [tokenCountWithLimits(1, 10, plusLimits()), filler], 20);
    expect(await createCodexAdapter({ codexDir }).quota?.()).toBeNull();
    await rollout(CHATGPT, [filler, tokenCountWithLimits(3, 12, plusLimits())], 20);
    expect((await createCodexAdapter({ codexDir }).quota?.())?.fetchedAt).toBe(at(12));
  });
});

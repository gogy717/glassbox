import { describe, expect, it } from 'vitest';
import type { TroubleSignal } from '../../../src/core/model.js';
import { makeI18n } from '../i18n';
import { looksStuck, troubleText } from './trouble';

const NOW = Date.UTC(2026, 9, 23, 10, 0);
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const sign = (kind: TroubleSignal['kind'], params: TroubleSignal['params'], since = ago(1)) =>
  ({ kind, params, at: null, since }) satisfies TroubleSignal;

const en = makeI18n('en').t;
const zh = makeI18n('zh').t;

describe('troubleText', () => {
  it('says each sign at length, as the summary bar lists it and a notification reads', () => {
    const say = (s: TroubleSignal) => troubleText(en, s, NOW, 'long');
    expect(say(sign('repeat', { x: 'npm test', n: 4 }))).toBe('Repeated npm test 4×');
    expect(say(sign('failing', { n: 4 }))).toBe('4 tool calls failed in a row');
    expect(say(sign('errors', { n: 2, of: 10 }))).toBe('2 API errors in the last 10 model calls');
    expect(say(sign('waiting', {}, ago(14)))).toBe('Waiting for you for 14 min');
    expect(say(sign('long-turn', { median: 4 * 60_000 }, ago(34)))).toBe(
      'This prompt has run 34 min; the others took 4 min',
    );
    expect(say(sign('compaction', { n: 3 }))).toBe('Context compacted 3 times');
  });

  it('says each sign short, as a row has room for', () => {
    const say = (s: TroubleSignal) => troubleText(en, s, NOW, 'short');
    expect(say(sign('repeat', { x: 'npm test', n: 4 }))).toBe('Retrying npm test · 4×');
    expect(say(sign('failing', { n: 4 }))).toBe('4 failures in a row');
    expect(say(sign('errors', { n: 2, of: 10 }))).toBe('2 API errors');
    expect(say(sign('waiting', {}, ago(14)))).toBe('Waiting 14 min');
    expect(say(sign('long-turn', { median: 4 * 60_000 }, ago(34)))).toBe('Prompt running 34 min');
    expect(say(sign('compaction', { n: 3 }))).toBe('Compacted 3×');
  });

  it('reads hours past an hour, and speaks Chinese', () => {
    expect(troubleText(en, sign('waiting', {}, ago(95)), NOW, 'long')).toBe(
      'Waiting for you for 1 h 35 min',
    );
    expect(troubleText(zh, sign('repeat', { x: 'npm test', n: 4 }), NOW, 'long')).toBe(
      '重复执行 npm test 4 次',
    );
    expect(troubleText(zh, sign('long-turn', { median: 4 * 60_000 }, ago(34)), NOW, 'long')).toBe(
      '这一轮已运行 34 分钟，其他轮通常只要 4 分钟',
    );
    expect(troubleText(zh, sign('repeat', { x: 'npm test', n: 4 }), NOW, 'short')).toBe(
      '正在重试 npm test · 4 次',
    );
    expect(troubleText(zh, sign('waiting', {}, ago(95)), NOW, 'short')).toBe('已等 1 小时 35 分钟');
  });

  it('says a context nearly full by its share, in both languages, long and short', () => {
    const full = sign('context-full', { pct: 92, tokens: 184_000, window: 200_000 });
    expect(troubleText(en, full, NOW, 'short')).toBe('Context 92%');
    expect(troubleText(zh, full, NOW, 'short')).toBe('上下文 92%');
    expect(troubleText(en, full, NOW, 'long')).toBe('Context 92% full; compaction soon');
    expect(troubleText(zh, full, NOW, 'long')).toBe('上下文已用 92%，即将压缩');
  });
});

describe('looksStuck', () => {
  it('is every sign but a context nearly full: that session is working, not stuck', () => {
    expect(looksStuck(sign('repeat', { x: 'npm test', n: 4 }))).toBe(true);
    expect(looksStuck(sign('long-turn', { median: 1 }))).toBe(true);
    expect(looksStuck(sign('context-full', { pct: 92, tokens: 1, window: 1 }))).toBe(false);
  });
});

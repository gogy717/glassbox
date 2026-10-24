import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { translate, useI18n } from './index';
import { zh } from './zh';

describe('useI18n', () => {
  it('speaks English outside any provider', () => {
    expect(renderHook(() => useI18n()).result.current.locale).toBe('en');
  });
});

describe('translate', () => {
  it('fills {placeholders} from params', () => {
    expect(translate('zh', 'flow.turnLabel', { n: 3 })).toBe('第 3 轮');
    expect(translate('en', 'detail.callRef', { n: 3 })).toBe('call #3');
  });

  it('picks the singular or plural noun for a count', () => {
    expect(translate('en', 'flow.callsTools', { calls: 1, tools: 1 })).toBe(
      '1 model call · 1 tool',
    );
    expect(translate('en', 'flow.callsTools', { calls: 2, tools: 0 })).toBe(
      '2 model calls · 0 tools',
    );
    expect(translate('en', 'common.tokens', { n: '1,024' })).toBe('1,024 tokens');
    expect(translate('en', 'common.tokens', { n: '1' })).toBe('1 token');
    expect(translate('zh', 'flow.callsTools', { calls: 1, tools: 1 })).toBe('1 次调用 · 1 个工具');
  });

  it('leaves an unknown placeholder visible rather than printing undefined', () => {
    expect(translate('en', 'flow.turnLabel', {})).toBe('Conversation {n}');
  });
});

describe('dictionaries', () => {
  it('have the same keys and no empty strings', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const dict of [zh, en]) for (const v of Object.values(dict)) expect(v).not.toBe('');
  });
});

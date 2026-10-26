import { afterEach, describe, expect, it } from 'vitest';
import { loadPrefs, type Prefs, savePrefs } from './prefs';

const defaults: Prefs = {
  locale: 'en',
  theme: 'system',
  showProbes: false,
  rateAgent: null,
  notify: false,
  groupBy: 'project',
  folded: [],
  pinned: [],
  statsNoteSeen: false,
  prices: {},
};

describe('prefs', () => {
  afterEach(() => localStorage.clear());

  it('defaults to English, system theme, hidden probes, every CLI’s rate, no notifications, and a list by project with nothing folded or pinned', () => {
    expect(loadPrefs()).toEqual(defaults);
  });

  it('reads the "auto" language an older version saved as English', () => {
    localStorage.setItem('glassbox.prefs', '{"locale":"auto","theme":"dark"}');
    expect(loadPrefs()).toEqual({ ...defaults, theme: 'dark' });
  });

  it('round-trips through storage and ignores junk', () => {
    const saved: Prefs = {
      locale: 'zh',
      theme: 'dark',
      showProbes: true,
      rateAgent: 'codex',
      notify: true,
      groupBy: 'time',
      folded: ['glassbox', '/earlier'],
      pinned: ['claude-code:a', 'codex:b'],
      statsNoteSeen: true,
      prices: {
        'claude-opus-5-5': {
          input: 3,
          cacheWrite: 3.75,
          cacheWrite1h: 6,
          cacheRead: 0.3,
          output: 15,
        },
      },
    };
    savePrefs(saved);
    expect(loadPrefs()).toEqual(saved);
    localStorage.setItem(
      'glassbox.prefs',
      '{"locale":"fr","showProbes":"yes","rateAgent":"foo","notify":"yes","groupBy":"week","folded":"glassbox","pinned":{},"statsNoteSeen":"no","prices":[1]}',
    );
    expect(loadPrefs()).toEqual(defaults);
    localStorage.setItem('glassbox.prefs', 'not json');
    expect(loadPrefs()).toEqual(defaults);
  });

  // Branch D (F7): the list's folds and pins, saved by name and by id.
  it('keeps only the strings of the folded and pinned lists, each once', () => {
    localStorage.setItem(
      'glassbox.prefs',
      '{"folded":["a",2,"a","b"],"pinned":["x:1",null,"x:1"]}',
    );
    expect(loadPrefs()).toEqual({ ...defaults, folded: ['a', 'b'], pinned: ['x:1'] });
  });

  // API prices (estimate): a model's row is kept whole, five prices of zero or more, or not at all.
  it('keeps only whole price rows of numbers, by model id', () => {
    const row = { input: 1, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 };
    localStorage.setItem(
      'glassbox.prefs',
      JSON.stringify({
        prices: {
          good: row,
          free: { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
          missing: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 },
          text: { ...row, output: '5' },
          negative: { ...row, input: -1 },
          none: null,
          '': row,
        },
      }),
    );
    expect(loadPrefs().prices).toEqual({
      good: row,
      free: { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
    });
  });
});

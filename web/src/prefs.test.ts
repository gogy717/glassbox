import { afterEach, describe, expect, it } from 'vitest';
import { loadPrefs, savePrefs } from './prefs';

const DEFAULTS = {
  locale: 'en',
  theme: 'system',
  showProbes: false,
  rateAgent: null,
  notify: false,
};

describe('prefs', () => {
  afterEach(() => localStorage.clear());

  it('defaults to English, system theme, hidden probe sessions, every CLI’s rate and no notifications', () => {
    expect(loadPrefs()).toEqual(DEFAULTS);
  });

  it('reads the "auto" language an older version saved as English', () => {
    localStorage.setItem('glassbox.prefs', '{"locale":"auto","theme":"dark"}');
    expect(loadPrefs()).toEqual({ ...DEFAULTS, theme: 'dark' });
  });

  it('round-trips through storage and ignores junk', () => {
    savePrefs({ locale: 'zh', theme: 'dark', showProbes: true, rateAgent: 'codex', notify: true });
    expect(loadPrefs()).toEqual({
      locale: 'zh',
      theme: 'dark',
      showProbes: true,
      rateAgent: 'codex',
      notify: true,
    });
    localStorage.setItem(
      'glassbox.prefs',
      '{"locale":"fr","showProbes":"yes","rateAgent":"foo","notify":"yes"}',
    );
    expect(loadPrefs()).toEqual(DEFAULTS);
    localStorage.setItem('glassbox.prefs', 'not json');
    expect(loadPrefs()).toEqual(DEFAULTS);
  });
});

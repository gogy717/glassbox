import { afterEach, describe, expect, it } from 'vitest';
import { loadPrefs, savePrefs } from './prefs';

describe('prefs', () => {
  afterEach(() => localStorage.clear());

  it('defaults to English, system theme, hidden probe sessions and every CLI’s rate', () => {
    expect(loadPrefs()).toEqual({
      locale: 'en',
      theme: 'system',
      showProbes: false,
      rateAgent: null,
    });
  });

  it('reads the "auto" language an older version saved as English', () => {
    localStorage.setItem('glassbox.prefs', '{"locale":"auto","theme":"dark"}');
    expect(loadPrefs()).toEqual({
      locale: 'en',
      theme: 'dark',
      showProbes: false,
      rateAgent: null,
    });
  });

  it('round-trips through storage and ignores junk', () => {
    savePrefs({ locale: 'zh', theme: 'dark', showProbes: true, rateAgent: 'codex' });
    expect(loadPrefs()).toEqual({
      locale: 'zh',
      theme: 'dark',
      showProbes: true,
      rateAgent: 'codex',
    });
    localStorage.setItem('glassbox.prefs', '{"locale":"fr","showProbes":"yes","rateAgent":7}');
    expect(loadPrefs()).toEqual({
      locale: 'en',
      theme: 'system',
      showProbes: false,
      rateAgent: null,
    });
    localStorage.setItem('glassbox.prefs', 'not json');
    expect(loadPrefs()).toEqual({
      locale: 'en',
      theme: 'system',
      showProbes: false,
      rateAgent: null,
    });
  });
});

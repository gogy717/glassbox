import { afterEach, describe, expect, it } from 'vitest';
import { loadPrefs, savePrefs } from './prefs';

describe('prefs', () => {
  afterEach(() => localStorage.clear());

  it('defaults to English, system theme and hidden probe sessions', () => {
    expect(loadPrefs()).toEqual({ locale: 'en', theme: 'system', showProbes: false });
  });

  it('reads the "auto" language an older version saved as English', () => {
    localStorage.setItem('glassbox.prefs', '{"locale":"auto","theme":"dark"}');
    expect(loadPrefs()).toEqual({ locale: 'en', theme: 'dark', showProbes: false });
  });

  it('round-trips through storage and ignores junk', () => {
    savePrefs({ locale: 'zh', theme: 'dark', showProbes: true });
    expect(loadPrefs()).toEqual({ locale: 'zh', theme: 'dark', showProbes: true });
    localStorage.setItem('glassbox.prefs', '{"locale":"fr","showProbes":"yes"}');
    expect(loadPrefs()).toEqual({ locale: 'en', theme: 'system', showProbes: false });
    localStorage.setItem('glassbox.prefs', 'not json');
    expect(loadPrefs()).toEqual({ locale: 'en', theme: 'system', showProbes: false });
  });
});

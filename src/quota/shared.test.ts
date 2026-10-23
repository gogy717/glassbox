import { describe, expect, it } from 'vitest';
import { codexPlanName, msToIso, windowKind } from './shared.js';

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

describe('msToIso', () => {
  it('turns epoch milliseconds into ISO time, and anything else into null', () => {
    expect(msToIso(Date.parse('2026-10-23T02:00:00.000Z'))).toBe('2026-10-23T02:00:00.000Z');
    expect(msToIso(1e300)).toBeNull();
    expect(msToIso(Number.NaN)).toBeNull();
    expect(msToIso('1792768975290')).toBeNull();
    expect(msToIso(null)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { formatRoute, mergeRoute, pageOf, parseRoute, type Route } from './router';

const HOME: Route = {
  sessionId: null,
  agentId: 'main',
  tab: 'flow',
  turnId: null,
  requestId: null,
};

describe('parseRoute', () => {
  it.each(['', '#', '#/', '#/nonsense'])('treats %j as the home route', (hash) => {
    expect(parseRoute(hash)).toEqual(HOME);
  });

  it('reads the session, agent, tab, turn and request', () => {
    expect(parseRoute('#/s/claude-code%3Aabc?agent=a1&tab=tokens&turn=t1&req=r%2F1')).toEqual({
      sessionId: 'claude-code:abc',
      agentId: 'a1',
      tab: 'tokens',
      turnId: 't1',
      requestId: 'r/1',
    });
  });

  it('knows the files tab', () => {
    expect(parseRoute('#/s/x?tab=files')).toEqual({ ...HOME, sessionId: 'x', tab: 'files' });
    expect(formatRoute({ ...HOME, sessionId: 'x', tab: 'files' })).toBe('#/s/x?tab=files');
  });

  it('treats a malformed escape in the session id as the home route instead of throwing', () => {
    expect(parseRoute('#/s/%E0%A4%A')).toEqual(HOME);
  });

  it('falls back to the flow tab and main agent for unknown or missing values', () => {
    expect(parseRoute('#/s/x?tab=bogus&agent=')).toEqual({ ...HOME, sessionId: 'x' });
  });
});

describe('formatRoute', () => {
  it('omits defaults', () => {
    expect(formatRoute(HOME)).toBe('#/');
    expect(formatRoute({ ...HOME, sessionId: 'claude-code:abc' })).toBe('#/s/claude-code%3Aabc');
  });

  it('encodes every set field and round-trips', () => {
    const r: Route = {
      sessionId: 'claude-code:abc',
      agentId: 'a1',
      tab: 'time',
      turnId: 't 1',
      requestId: 'r/1',
    };
    const hash = formatRoute(r);
    expect(hash).toBe('#/s/claude-code%3Aabc?agent=a1&tab=time&turn=t+1&req=r%2F1');
    expect(parseRoute(hash)).toEqual(r);
  });
});

describe('the open card (card=)', () => {
  it.each([
    ['request', 'request'],
    ['response', 'response'],
    ['tool%3Atu_m1a', 'tool:tu_m1a'],
  ])('reads card=%s with the request it belongs to', (param, card) => {
    expect(parseRoute(`#/s/x?turn=t1&req=r1&card=${param}`)).toEqual({
      ...HOME,
      sessionId: 'x',
      turnId: 't1',
      requestId: 'r1',
      card,
    });
  });

  it.each(['bogus', 'tool%3A', ''])('leaves out an unknown card (%j)', (param) => {
    expect(parseRoute(`#/s/x?req=r1&card=${param}`)).not.toHaveProperty('card');
  });

  it('leaves out a card without a request: it would open nothing', () => {
    expect(parseRoute('#/s/x?card=request')).not.toHaveProperty('card');
    expect(formatRoute({ ...HOME, sessionId: 'x', card: 'request' })).toBe('#/s/x');
  });

  it('round-trips a link to a tool call', () => {
    const r: Route = {
      ...HOME,
      sessionId: 'claude-code:abc',
      turnId: 'turn_m1',
      requestId: 'req_m1',
      card: 'tool:tu_m1a',
    };
    const hash = formatRoute(r);
    expect(hash).toBe('#/s/claude-code%3Aabc?turn=turn_m1&req=req_m1&card=tool%3Atu_m1a');
    expect(parseRoute(hash)).toEqual(r);
  });
});

describe('mergeRoute', () => {
  const open: Route = {
    ...HOME,
    sessionId: 's1',
    turnId: 't1',
    requestId: 'r1',
    card: 'response',
  };

  it.each<[string, Partial<Route>]>([
    ['another request', { requestId: 'r5' }],
    [
      'another request and turn (a step, a token row, a timeline bar)',
      { turnId: 't3', requestId: 'r5' },
    ],
    ['another turn', { turnId: 't3' }],
    ['another agent', { agentId: 'a1' }],
    ['another session', { sessionId: 's2' }],
  ])('closes the card on %s: it belonged to the old request', (_what, next) => {
    expect(mergeRoute(open, next)).not.toHaveProperty('card');
  });

  it('keeps the card when the move names it', () => {
    expect(mergeRoute(open, { requestId: 'r5', card: 'request' }).card).toBe('request');
  });

  it('keeps the card across a tab switch, or a move to where it already is', () => {
    expect(mergeRoute(open, { tab: 'steps' }).card).toBe('response');
    expect(mergeRoute(open, { turnId: 't1', requestId: 'r1' }).card).toBe('response');
  });
});

describe('the Stats page (#/stats)', () => {
  it.each([
    ['#/stats', 'week'],
    ['#/stats?window=week', 'week'],
    ['#/stats?window=7d', '7d'],
    ['#/stats?window=bogus', 'week'],
    ['#/stats?', 'week'],
  ] as const)('reads %s as Stats over the window %s', (hash, stats) => {
    expect(parseRoute(hash)).toEqual({ ...HOME, stats });
  });

  it.each(['#/statsx', '#/stats/7d', '#/s/'])('does not read %j as Stats', (hash) => {
    expect(parseRoute(hash)).not.toHaveProperty('stats');
  });

  it('writes this week as the bare page, and round-trips both windows', () => {
    expect(formatRoute({ ...HOME, stats: 'week' })).toBe('#/stats');
    expect(formatRoute({ ...HOME, stats: '7d' })).toBe('#/stats?window=7d');
    for (const stats of ['week', '7d'] as const)
      expect(parseRoute(formatRoute({ ...HOME, stats }))).toEqual({ ...HOME, stats });
  });

  it('switches the window in place', () => {
    expect(mergeRoute({ ...HOME, stats: 'week' }, { stats: '7d' })).toEqual({
      ...HOME,
      stats: '7d',
    });
  });

  it('leaves Stats for a session named without it, as a click on a session does', () => {
    const next = { sessionId: 's1', agentId: 'main', turnId: null, requestId: null };
    const merged = mergeRoute({ ...HOME, stats: '7d' }, next);
    expect(merged).not.toHaveProperty('stats');
    expect(formatRoute(merged)).toBe('#/s/s1');
  });

  it('opens Stats over a session: the page wins, the session is left behind', () => {
    const merged = mergeRoute({ ...HOME, sessionId: 's1', tab: 'time' }, { stats: 'week' });
    expect(formatRoute(merged)).toBe('#/stats');
  });
});

describe('pageOf', () => {
  it.each<[Route, string]>([
    [HOME, 'home'],
    [{ ...HOME, sessionId: 's1' }, 'session'],
    [{ ...HOME, stats: 'week' }, 'stats'],
    [{ ...HOME, stats: '7d' }, 'stats'],
  ])('%j is the %s page', (route, page) => {
    expect(pageOf(route)).toBe(page);
  });
});

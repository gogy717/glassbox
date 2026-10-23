import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute, type Route } from './router';

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

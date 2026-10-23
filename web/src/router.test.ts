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

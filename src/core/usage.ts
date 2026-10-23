import type { TokenUsage } from './model.js';

export function emptyUsage(): TokenUsage {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    thinking: 0,
    webSearch: 0,
    webFetch: 0,
  };
}

/** Adds `b` into `a` in place and returns `a`. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  a.input += b.input;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.cacheWrite5m += b.cacheWrite5m;
  a.cacheWrite1h += b.cacheWrite1h;
  a.output += b.output;
  a.thinking += b.thinking;
  a.webSearch += b.webSearch;
  a.webFetch += b.webFetch;
  return a;
}

export function sumUsage(items: Iterable<TokenUsage | null | undefined>): TokenUsage {
  const total = emptyUsage();
  for (const item of items) if (item) addUsage(total, item);
  return total;
}

/** Tokens the model had to read for a request: uncached input + cache read + cache write. */
export function contextSize(u: TokenUsage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

/** Every token billed for a request: context plus output. */
export function totalTokens(u: TokenUsage): number {
  return contextSize(u) + u.output;
}

/** Share of context tokens served from cache, 0..1; 0 when there is no context. */
export function cacheHitRate(u: TokenUsage): number {
  const ctx = contextSize(u);
  return ctx === 0 ? 0 : u.cacheRead / ctx;
}

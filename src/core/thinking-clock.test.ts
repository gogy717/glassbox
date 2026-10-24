import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { thinkingSince as fromActivity } from './activity.js';
import { thinkingSince } from './thinking-clock.js';

describe('thinking-clock', () => {
  it('is the rule activity.ts exports, not a copy', () => {
    expect(fromActivity).toBe(thinkingSince);
  });

  // The web imports it for the flow's clock: anything it imports lands in the web bundle.
  it('imports nothing but types', () => {
    const source = readFileSync(join(import.meta.dirname, 'thinking-clock.ts'), 'utf8');
    const imports = [...source.matchAll(/^import (.*) from/gm)].map((m) => m[1]);
    expect(imports.every((i) => i?.startsWith('type '))).toBe(true);
  });
});

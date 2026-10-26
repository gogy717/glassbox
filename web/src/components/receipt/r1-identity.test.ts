/**
 * The session receipt, byte for byte: every image and text the demo sessions make, at each size,
 * paper and language, names shown and hidden, hashed in one time zone. The hash is what the
 * receipt drew before its pen was shared with the weekly receipt (78cb423), then with WORK's
 * turns line saying "Prompts", not "Conversations" (the UX pass's words). Changing how the
 * session receipt looks changes it on purpose: then the hash changes in the same commit, which
 * says why. So does changing what the demo sessions did: the receipt prints their tool calls and
 * the mix of their kinds (the demo's fix grew file work; the pen did not change). WORK then
 * gained the outcome's test runs and commits: the flaky-login session's `npm test` prints
 * "1  Test run · last ✓"; with those two lines left out, the hash is the one before.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDemoSideSnapshots, createDemoSnapshot } from '../../../../src/core/fixtures/demo.js';
import { createStore, type OpenSession } from '../../data/store';
import { receiptData } from './data';
import { receiptSvg } from './svg';
import { receiptText } from './text';

const tz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

/** Every session receipt the demo sessions make: each size, paper, language and its text. */
function receipts(): string {
  const now = new Date('2026-10-23T10:00:00.000Z');
  const out: string[] = [];
  for (const snap of [createDemoSnapshot(now), ...createDemoSideSnapshots(now)]) {
    const store = createStore();
    store.openSession(snap.session.id);
    store.applyEvent({ type: 'snapshot', sessionId: snap.session.id, snapshot: snap });
    const d = receiptData(store.getState().open as OpenSession, now.getTime());
    for (const paper of ['paper', 'night'] as const)
      for (const locale of ['en', 'zh'] as const)
        for (const hideNames of [false, true]) {
          out.push(receiptText(d, { paper, locale, hideNames }));
          for (const size of ['tall', 'post', 'story'] as const)
            out.push(receiptSvg(d, { paper, locale, hideNames }, size).svg);
        }
  }
  return out.join('\n');
}

it('draws the session receipt exactly as it did before the weekly receipt shared its pen', () => {
  expect(createHash('sha256').update(receipts()).digest('hex')).toBe(
    '0b18280509eedcf568d85753df8c24fcfcc545d95b40fed7b21e8b1788e39f79',
  );
});

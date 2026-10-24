import { describe, expect, it } from 'vitest';
import type { ModelRequest, ResponseBlock, ToolCall } from '../../../../src/core/model.js';
import { demoOpen } from '../../test/demo';
import { firstSentence, thinkingSince, whyLine } from './why';

const AT = '2026-10-24T01:00:00.000Z';
const text = (t: string): ResponseBlock => ({ kind: 'text', text: t, at: AT });
const thought = (t: string | null): ResponseBlock => ({
  kind: 'thinking',
  text: t,
  durationMs: 900,
  at: AT,
});

function call(blocks: ResponseBlock[], over: Partial<ModelRequest> = {}): ModelRequest {
  const base = demoOpen().requests.get('req_m3') as ModelRequest;
  return { ...base, blocks, ...over };
}

describe('whyLine', () => {
  it('is the first sentence of what the call said', () => {
    expect(
      whyLine(
        call([
          thought('Plan the split.'),
          text('Splitting the research by version. Then a verifier checks it.'),
        ]),
      ),
    ).toBe('Splitting the research by version.');
  });

  it('reads markdown as plain words', () => {
    expect(whyLine(call([text('**Fixed:** busy sessions sort first.\n\n- by status')]))).toBe(
      'Fixed: busy sessions sort first.',
    );
  });

  it('ends at a line break, and skips code', () => {
    expect(whyLine(call([text('### Plan\n- read the store')]))).toBe('Plan');
    expect(whyLine(call([text('```ts\nconst a = 1;\n```\nThen it sorts.')]))).toBe(
      'Then it sorts.',
    );
  });

  it('falls back to the recorded thinking when the call said nothing', () => {
    expect(whyLine(call([thought("I'll check the store first. Then the sort.")]))).toBe(
      "I'll check the store first.",
    );
  });

  it('is nothing for a call that only ran tools, or whose thinking is not recorded', () => {
    expect(whyLine(call([]))).toBeNull();
    expect(whyLine(call([thought(null)]))).toBeNull();
    expect(whyLine(call([text('   ')]))).toBeNull();
  });
});

describe('firstSentence', () => {
  it.each([
    ['One. Two.', 'One.'],
    ['Is it? Yes.', 'Is it?'],
    ['Done! Next.', 'Done!'],
    ['先看看存储。然后修改。', '先看看存储。'],
    // Not ends of sentences: an abbreviation, a version, a path.
    ['Use e.g. the store. Then sort.', 'Use e.g. the store.'],
    ['Bump to v2.0 now. Done.', 'Bump to v2.0 now.'],
    ['Read src/app.ts first', 'Read src/app.ts first'],
    // Abbreviations before a capital or a number do not end one either.
    ['Use e.g. React here. Then sort.', 'Use e.g. React here.'],
    ['Keep i.e. The store. Then sort.', 'Keep i.e. The store.'],
    ['Ask Mr. Smith and Dr. Who. Then sort.', 'Ask Mr. Smith and Dr. Who.'],
    ['Files, logs, etc. Then sort.', 'Files, logs, etc. Then sort.'],
    ['Tabs vs. Spaces matter. Then sort.', 'Tabs vs. Spaces matter.'],
    ['See fig. 2 and No. 5 here. Done.', 'See fig. 2 and No. 5 here.'],
    ['  Spaced   out.  ', 'Spaced out.'],
  ])('%j → %j', (input, want) => {
    expect(firstSentence(input)).toBe(want);
  });

  it('cuts a sentence that never ends', () => {
    const s = firstSentence('word '.repeat(200));
    expect(s.length).toBeLessThanOrEqual(241);
    expect(s.endsWith('…')).toBe(true);
  });

  it('cuts between characters, never inside an emoji', () => {
    const s = firstSentence(`${'a'.repeat(239)}😀😀 and on`);
    expect([...s]).toHaveLength(241);
    expect(s).toBe(`${'a'.repeat(239)}😀…`);
  });
});

describe('thinkingSince', () => {
  const tool = (id: string, endedAt: string | null): ToolCall =>
    ({ id, endedAt }) as unknown as ToolCall;

  it('starts at the end of the call’s latest own tool, else at the call’s start', () => {
    const c = call([], {
      startedAt: '2026-10-24T01:00:00.000Z',
      toolCallIds: ['a', 'b'],
    });
    expect(thinkingSince(c, [])).toBe('2026-10-24T01:00:00.000Z');
    expect(
      thinkingSince(c, [
        tool('a', '2026-10-24T01:00:05.000Z'),
        tool('b', '2026-10-24T01:00:09.000Z'),
        tool('other', '2026-10-24T01:00:30.000Z'),
      ]),
    ).toBe('2026-10-24T01:00:09.000Z');
    // A running tool has no end yet.
    expect(thinkingSince(c, [tool('a', null)])).toBe('2026-10-24T01:00:00.000Z');
  });

  it('compares instants, not text', () => {
    const c = call([], { startedAt: '2026-10-24T01:00:05Z', toolCallIds: ['a'] });
    expect(thinkingSince(c, [tool('a', '2026-10-24T01:00:04.900Z')])).toBe('2026-10-24T01:00:05Z');
  });
});

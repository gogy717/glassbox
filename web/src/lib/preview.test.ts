import { describe, expect, it } from 'vitest';
import { plainText } from './preview';

describe('plainText', () => {
  it.each([
    ['### Spec Compliance\n- **Spec compliant:** yes', 'Spec Compliance Spec compliant: yes'],
    ['# Title\n\nSome *emphasis* and __strong__ text.', 'Title Some emphasis and strong text.'],
    ['1. First\n2) Second\n* third\n+ fourth', 'First Second third fourth'],
    ['> quoted\n>> nested', 'quoted nested'],
    ['- [ ] todo\n- [x] done', 'todo done'],
    [
      'See [the docs](https://example.com/docs) and ![a chart](c.png).',
      'See the docs and a chart.',
    ],
    ['Run `npm test` first', 'Run npm test first'],
    ['```ts\nconst a = 1;\n```\nAfter', 'const a = 1; After'],
    ['Above\n\n---\n\nBelow', 'Above Below'],
    ['| a | b |\n|---|:-:|\n| 1 | 2 |', 'a b 1 2'],
    ['a | b\n--|--\n1 | 2\n\nAfter | the table', 'a b 1 2 After | the table'],
    // Pipes outside tables are shell pipes, and mean something.
    ['ls | grep x', 'ls | grep x'],
    ['Run `ls | grep x` first', 'Run ls | grep x first'],
    ['~~old~~ new', 'old new'],
    // Not markdown: kept as written.
    ['snake_case and a__b and 2 * 3 * 4', 'snake_case and a__b and 2 * 3 * 4'],
    ['a_b_c', 'a_b_c'],
    ['   ', ''],
  ])('%j → %j', (md, want) => {
    expect(plainText(md)).toBe(want);
  });

  it('only reads as far as a one-line preview needs', () => {
    const text = plainText(`**Start** ${'word '.repeat(100_000)}`);
    expect(text.startsWith('Start word')).toBe(true);
    expect(text.length).toBeLessThan(2_100);
  });
});

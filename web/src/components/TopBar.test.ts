import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom applies no media queries: the thresholds are read from the sheet itself.
const sheet = readFileSync(join(import.meta.dirname, 'TopBar.module.css'), 'utf8');

/** Each `@media (max-width: …)` block of the sheet: its width and what it holds. */
function mediaBlocks(css: string): { max: number; body: string }[] {
  const blocks: { max: number; body: string }[] = [];
  const head = /@media \(max-width: (\d+)px\) \{/g;
  for (let m = head.exec(css); m; m = head.exec(css)) {
    let depth = 1;
    let i = head.lastIndex;
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    blocks.push({ max: Number(m[1]), body: css.slice(head.lastIndex, i - 1) });
  }
  return blocks;
}

describe('the top bar as it narrows (D4 DR1)', () => {
  it('drops the page nav words at one width on all three pages, a session included', () => {
    const hiding = mediaBlocks(sheet).filter((b) => /\.pageLabel\b/.test(b.body));
    expect(hiding.map((b) => b.max)).toEqual([1199]);
    // Nothing narrows the nav for one page only: no rule ties its words to an open session.
    expect(sheet).not.toMatch(/\[data-session\][^{,]*\.pageLabel/);
  });

  it('lets a session pay for its title with the other words first, below 1400', () => {
    const session = mediaBlocks(sheet).find((b) => b.max === 1399);
    expect(session?.body).toMatch(/\.bar\[data-session\] \.conn\[data-state="open"\]/);
    expect(session?.body).toMatch(/\.bar\[data-session\] \.toggleLabel/);
    expect(session?.body).not.toMatch(/\.pageLabel/);
  });
});

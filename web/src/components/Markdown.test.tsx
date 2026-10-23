import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeI18n } from '../i18n';
import { Markdown } from './Markdown';
import { MarkdownRender } from './MarkdownRender';

/** The renderer itself; `Markdown` loads it lazily (tested at the end). */
function renderMd(text: string) {
  return render(
    <I18nContext.Provider value={makeI18n('en')}>
      <MarkdownRender text={text} label="Content" clip={6_000} />
    </I18nContext.Provider>,
  );
}

describe('Markdown', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders headings, lists, tasks, tables, quotes, rules and inline styles', () => {
    const { container } = renderMd(
      [
        '# Plan',
        '## Steps',
        '1. First',
        '2. Second',
        '',
        '- [x] done',
        '- [ ] open',
        '',
        '| Tool | Version |',
        '|---|---|',
        '| grok | 1.0.67 |',
        '',
        '> quoted',
        '',
        '---',
        '',
        'Some **bold**, *em*, ~~gone~~ and `npm test`.',
      ].join('\n'),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Steps' })).toBeInTheDocument();
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false]);
    const table = screen.getByRole('table');
    // The table scrolls inside its own box instead of widening the panel.
    expect(table.parentElement).toHaveAttribute('data-scroll-region');
    expect(within(table).getByRole('cell', { name: '1.0.67' })).toBeInTheDocument();
    expect(container.querySelector('blockquote')).toHaveTextContent('quoted');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('em');
    expect(container.querySelector('del')).toHaveTextContent('gone');
    expect(container.querySelector('code')).toHaveTextContent('npm test');
  });

  it('never renders raw HTML: it stays text', () => {
    const { container } = renderMd(
      'Hello <b>bold</b>\n\n<script>alert(1)</script>\n\n<div onclick="steal()">hi</div>',
    );
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container).toHaveTextContent('Hello <b>bold</b>');
    expect(container).toHaveTextContent('<script>alert(1)</script>');
    expect(container).toHaveTextContent('<div onclick="steal()">hi</div>');
  });

  it('links only http(s) and mailto, in a new tab; any other scheme is text', () => {
    const { container } = renderMd(
      [
        '[site](https://example.com/a)',
        '[mail](mailto:dev@example.com)',
        '[bad](javascript:alert(1))',
        '[data](data:text/html,hi)',
        '[file](file:///etc/passwd)',
        '[rel](./notes.md)',
      ].join(' '),
    );
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/a',
      'mailto:dev@example.com',
    ]);
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
    for (const word of ['bad', 'data', 'file', 'rel']) expect(container).toHaveTextContent(word);
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('never loads an image: shows its alt text and address instead', () => {
    const { container } = renderMd('Look: ![a cat](https://example.com/cat.png)');
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('[image: a cat] https://example.com/cat.png');
  });

  it('shows fenced code as a code block: line breaks, language, a copy of all of it', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { container } = renderMd('Run:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone.');
    expect(container.querySelector('pre')?.textContent).toBe('const a = 1;\nconst b = 2;');
    expect(screen.getByText('ts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('const a = 1;\nconst b = 2;'));
  });

  it('parses only the start of a huge reply, keeps each code block whole, shows the rest on request', () => {
    const code = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
    const huge = `${'word '.repeat(200_000)}`;
    const started = performance.now();
    const { container } = renderMd(`\`\`\`\n${code}\n\`\`\`\n\n${huge}`);
    // A megabyte of markdown parsed whole takes seconds; the clip keeps this well under that.
    expect(performance.now() - started).toBeLessThan(3000);
    // The code block comes first and shows whole; the prose after it is clipped.
    expect(container.querySelector('pre')?.textContent).toBe(code);
    const prose = [...container.querySelectorAll('p')].map((p) => p.textContent ?? '').join('');
    expect(prose.length).toBeLessThan(6_000);
    expect(
      screen.getByRole('button', { name: /^Show all \(1,00\d,\d{3} characters\)$/ }),
    ).toBeInTheDocument();
  });

  it('shows the text as written until the renderer has loaded, then renders it', async () => {
    const { container } = render(
      <I18nContext.Provider value={makeI18n('en')}>
        <Markdown text={'# Ready\n\nSet.'} label="Content" />
      </I18nContext.Provider>,
    );
    expect(await screen.findByRole('heading', { name: 'Ready' })).toBeInTheDocument();
    expect(container).not.toHaveTextContent('# Ready');
  });
});

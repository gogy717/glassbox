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
    // Inside a panel whose cells are h4, a reply's headings read as levels 5 and 6.
    expect(screen.getByRole('heading', { level: 5, name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Steps' })).toBeInTheDocument();
    expect(container.querySelector('h1, h2')).toBeNull();
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
    // The code does not use up the prose budget: the prose after it shows, clipped.
    const prose = [...container.querySelectorAll('p')].map((p) => p.textContent ?? '').join('');
    expect(prose.length).toBeGreaterThan(5_000);
    expect(prose.length).toBeLessThanOrEqual(6_000);
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
    // First the text as written: the renderer is still loading.
    expect(screen.queryByRole('heading')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('# Ready\n\nSet.');
    expect(await screen.findByRole('heading', { name: 'Ready' })).toBeInTheDocument();
    expect(container).not.toHaveTextContent('# Ready');
  });

  it('keeps numbered steps one list, their code in place and copied without the list indent', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { container } = renderMd(
      [
        '1. Install',
        '',
        '   ```bash',
        '   npm i',
        '   ```',
        '',
        '2. Write it:',
        '',
        '   ```python',
        '   def f():',
        '       return 1',
        '   ```',
        '',
        '3. Run',
      ].join('\n'),
    );
    const lists = container.querySelectorAll('ol');
    expect(lists).toHaveLength(1);
    expect(lists[0]?.hasAttribute('start')).toBe(false);
    const items = container.querySelectorAll('ol > li');
    expect(items).toHaveLength(3);
    expect(items[0]?.querySelector('pre')?.textContent).toBe('npm i');
    expect(items[1]?.querySelector('pre')?.textContent).toBe('def f():\n    return 1');
    fireEvent.click(within(items[1] as HTMLElement).getByRole('button', { name: 'Copy code' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('def f():\n    return 1'));
  });

  it('shows the prose after a code block longer than the inline clip', () => {
    const code = 'x = 1\n'.repeat(1_400);
    const { container } = renderMd(`\`\`\`\n${code}\`\`\`\n\nThe explanation follows.`);
    expect(container).toHaveTextContent('The explanation follows.');
  });

  it('cuts long prose at a line break, never inside a line', () => {
    const line = (i: number) => `Row ${i}: [a link](https://example.com/${i}) and more words.`;
    const text = Array.from({ length: 400 }, (_, i) => line(i)).join('\n');
    const { container } = renderMd(text);
    const shown = container.querySelector('p')?.textContent ?? '';
    expect(shown.length).toBeLessThanOrEqual(6_000);
    // The last link shown is whole: the cut came at the end of a line.
    const links = [...container.querySelectorAll('a')];
    expect(links.at(-1)?.getAttribute('href')).toBe(`https://example.com/${links.length - 1}`);
    expect(shown.endsWith('and more words.')).toBe(true);
  });

  it('shows footnotes as written: no English label, no in-page links', () => {
    const { container } = renderMd('A claim[^1].\n\n[^1]: The source.');
    expect(container).toHaveTextContent('A claim[^1].');
    expect(container).toHaveTextContent('[^1]: The source.');
    expect(container.querySelector('section, sup, [id]')).toBeNull();
    expect(container).not.toHaveTextContent('Footnotes');
  });

  it('shows text nested thousands of levels deep as written, without failing the view', async () => {
    // Load the renderer first, so the deep text really goes through it.
    render(
      <I18nContext.Provider value={makeI18n('en')}>
        <Markdown text="# Loaded" label="Content" />
      </I18nContext.Provider>,
    );
    await screen.findByRole('heading', { name: 'Loaded' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deep = `${'>'.repeat(3_000)} deep`;
    const { container } = render(
      <I18nContext.Provider value={makeI18n('en')}>
        <Markdown text={deep} label="Content" />
      </I18nContext.Provider>,
    );
    await new Promise((r) => setTimeout(r, 300));
    // The parser gives up on such nesting; the text shows as written instead.
    expect(container).toHaveTextContent('deep');
    expect(container.querySelector('p')?.textContent).toBe(deep);
    errors.mockRestore();
  });
});

describe('Markdown when its renderer cannot load', () => {
  afterEach(() => {
    vi.doUnmock('./MarkdownRender');
    vi.resetModules();
  });

  it('shows the text as written instead of failing the view', async () => {
    vi.resetModules();
    vi.doMock('./MarkdownRender', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Markdown: Fresh } = await import('./Markdown');
    const { I18nContext: Ctx, makeI18n: make } = await import('../i18n');
    const { container } = render(
      <Ctx.Provider value={make('en')}>
        <Fresh text={'# Still here\n\nAs written.'} label="Content" />
      </Ctx.Provider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('p')?.textContent).toBe('# Still here\n\nAs written.');
    expect(screen.queryByRole('heading')).toBeNull();
    vi.mocked(console.error).mockRestore();
  });
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestDetail } from '../../../../../src/core/model.js';
import { I18nContext, makeI18n } from '../../../i18n';
import { useFakeLayout } from '../../../test/layout';
import { resetDetailPrefs } from './prefs';
import { RequestReadable } from './RequestReadable';

const detail = (over: Partial<RequestDetail>): RequestDetail => ({
  requestId: 'r1',
  completeness: 'full',
  notes: [],
  params: null,
  system: null,
  tools: null,
  messages: null,
  ...over,
});

function renderDetail(d: RequestDetail, locale: 'en' | 'zh' = 'en') {
  return render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <RequestReadable detail={d} />
    </I18nContext.Provider>,
  );
}

const messages = () => screen.getAllByRole('article');
const positions = () => messages().map((m) => m.getAttribute('aria-label'));

const conversation = [
  { role: 'user', content: 'Fix the flaky test' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'The timeout is too short.' },
      {
        type: 'text',
        text: 'Here is the fix:\n```ts\nconst timeout = 5_000;\nawait run(timeout);\n```',
      },
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'Edit',
        input: { file_path: '/src/a.test.ts', old_string: 'a\nb', new_string: 'c\nd' },
      },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'String not found' },
      {
        type: 'tool_result',
        tool_use_id: 'tu_2',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4096) },
          },
        ],
      },
    ],
  },
];

describe('RequestReadable', () => {
  useFakeLayout();
  afterEach(() => {
    localStorage.clear();
    resetDetailPrefs();
  });

  it('shows the conversation readable: text, code with its line breaks, thinking, tools, results', async () => {
    renderDetail(detail({ messages: conversation }));
    const [results, assistant, user] = messages() as [HTMLElement, HTMLElement, HTMLElement];
    expect(user).toHaveTextContent('Fix the flaky test');
    // A fenced code block is code, with real line breaks, not "\n" (once markdown has loaded).
    await vi.waitFor(() =>
      expect([...assistant.querySelectorAll('pre')].map((p) => p.textContent)).toContain(
        'const timeout = 5_000;\nawait run(timeout);',
      ),
    );
    expect(within(assistant).getAllByRole('button', { name: 'Copy code' }).length).toBeGreaterThan(
      0,
    );
    // Thinking is folded away, labelled.
    expect(
      within(assistant).getByText('Thinking · 25 characters').closest('details'),
    ).not.toHaveAttribute('open');
    // Tool arguments: every string field readable, under its name.
    expect(within(assistant).getByText('Tool call · Edit')).toBeInTheDocument();
    expect(within(assistant).getByText('/src/a.test.ts')).toBeInTheDocument();
    const pres = [...assistant.querySelectorAll('pre')].map((p) => p.textContent);
    expect(pres).toEqual(expect.arrayContaining(['a\nb', 'c\nd']));
    // Results: the error flagged; an image as a placeholder with its type and size, no base64.
    expect(within(results).getByText('Tool result · error')).toBeInTheDocument();
    expect(within(results).getByText('String not found')).toBeInTheDocument();
    expect(results).toHaveTextContent('Image · image/png · 3 KB');
    expect(results).not.toHaveTextContent('AAAA');
  });

  it('lists the newest message first, says where each one sits, and remembers the order', () => {
    renderDetail(detail({ messages: conversation }));
    expect(positions()).toEqual([
      'Tool message #3 of 3',
      'Assistant message #2 of 3',
      'User message #1 of 3',
    ]);
    fireEvent.click(screen.getByRole('radio', { name: 'Oldest first' }));
    expect(positions()).toEqual([
      'User message #1 of 3',
      'Assistant message #2 of 3',
      'Tool message #3 of 3',
    ]);
    expect(JSON.parse(localStorage.getItem('glassbox.detail') ?? '{}')).toMatchObject({
      order: 'oldest',
    });
  });

  it('opens a code block too long to show inline in one click, with its line breaks', async () => {
    const long = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n');
    renderDetail(detail({ messages: [{ role: 'assistant', content: `\`\`\`\n${long}\n\`\`\`` }] }));
    fireEvent.click(await screen.findByRole('button', { name: /^Show all/ }));
    const dialog = screen.getByRole('dialog');
    const lines = [...dialog.querySelectorAll('[data-line]')].map((l) => l.textContent);
    expect(lines.slice(0, 3)).toEqual(['line 0', 'line 1', 'line 2']);
  });

  it('stays light on a huge request: a page of messages at a time, long text clipped', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({
      role: 'user',
      content: `message ${i}`,
    }));
    many.push({ role: 'assistant', content: 'x'.repeat(3_000_000) });
    renderDetail(detail({ messages: many }));
    expect(messages()).toHaveLength(30);
    expect(screen.getByText('1,501 messages')).toBeInTheDocument();
    const huge = messages()[0] as HTMLElement;
    expect((huge.querySelector('p')?.textContent ?? '').length).toBeLessThanOrEqual(6_000);
    expect(
      await within(huge).findByRole('button', { name: 'Show all (3,000,000 characters)' }),
    ).toBeInTheDocument();
    expect((huge.querySelector('p')?.textContent ?? '').length).toBeLessThanOrEqual(6_000);
    fireEvent.click(screen.getByRole('button', { name: 'Show 30 more' }));
    expect(messages()).toHaveLength(60);
  });

  it('shows a section it cannot read as JSON, and an unknown block as its own JSON', () => {
    renderDetail(
      detail({
        system: { weird: true },
        messages: [{ role: 'user', content: [{ type: 'mystery', x: 1 }] }],
      }),
    );
    expect(
      screen.getByText('Shown as JSON: glassbox does not know this format'),
    ).toBeInTheDocument();
    expect(screen.getByText('Unrecognised block · mystery')).toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveTextContent('"x": 1');
  });

  it('reads the system prompt, params and tool list, a tool’s details only when opened', () => {
    renderDetail(
      detail({
        system: [{ type: 'text', text: 'You are Claude Code.\nBe brief.' }],
        params: { model: 'claude-opus-5-5', betas: ['a', 'b'], thinking: { type: 'adaptive' } },
        tools: [
          {
            name: 'Bash',
            description: 'Run a command\nin a shell',
            input_schema: { type: 'object' },
          },
        ],
      }),
    );
    expect(screen.getByText('Block 1 · 30 characters')).toBeInTheDocument();
    // Real line breaks, kept as such (the matcher would collapse them).
    const prose = [...document.querySelectorAll('p')].find((p) =>
      p.textContent?.startsWith('You are Claude Code.'),
    );
    expect(prose?.textContent).toBe('You are Claude Code.\nBe brief.');
    expect(screen.getByText('claude-opus-5-5')).toBeInTheDocument();
    expect(screen.getByText('a, b')).toBeInTheDocument();
    expect(screen.getByText('{"type":"adaptive"}')).toBeInTheDocument();
    expect(screen.queryByText('Input schema')).toBeNull();
    const summary = screen.getByText('Bash').closest('summary') as HTMLElement;
    const details = summary.parentElement as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(screen.getByText('Input schema')).toBeInTheDocument();
  });

  it('reads oh-my-pi’s and Grok’s shapes', () => {
    renderDetail(
      detail({
        system: ['Block one', 'Block two'],
        tools: ['read', 'bash'],
        messages: [
          { role: 'user', content: 'list files' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run_command' }] },
          { role: 'tool', toolCallId: 'c1' },
        ],
      }),
    );
    expect(screen.getByText('Block 2 · 9 characters')).toBeInTheDocument();
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('Tool call · run_command')).toBeInTheDocument();
    expect(screen.getByText('Arguments not recorded')).toBeInTheDocument();
    expect(screen.getByText('The result is not part of this record')).toBeInTheDocument();
  });

  it('shows the messages Claude Code could not reconstruct, counted in every position', () => {
    renderDetail(
      detail({
        messages: [
          { unresolved: 'base:req_0123', messages: 120 },
          { role: 'user', content: 'next' },
          { unresolved: 'a3f1c9e0' },
          { role: 'assistant', content: 'done' },
        ],
      }),
    );
    expect(screen.getByText('123 messages · 121 not reconstructed')).toBeInTheDocument();
    expect(positions()).toEqual(['Assistant message #123 of 123', 'User message #121 of 123']);
    const list = screen.getByRole('list');
    expect(list).toHaveTextContent('#122 of 123Message not reconstructed');
    expect(list).toHaveTextContent('#1–120 of 123120 earlier messages not reconstructed');
    expect(screen.queryByText(/Unrecognised block/)).toBeNull();
  });

  it('names roles it knows, and others generically', () => {
    renderDetail(
      detail({
        messages: [
          { role: 'developer', content: 'Be terse' },
          { role: 'critic', content: 'Hmm' },
          42,
        ],
      }),
    );
    expect(positions()).toEqual([
      'Unknown message #3 of 3',
      'Role “critic” message #2 of 3',
      'Developer message #1 of 3',
    ]);
  });

  it('looks ahead for the next page inside the scrolling list', () => {
    const roots: unknown[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(_cb: unknown, opts: { root: unknown }) {
          roots.push(opts.root);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      const many = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `m ${i}` }));
      renderDetail(detail({ messages: many }));
      expect(roots).toEqual([screen.getByRole('list')]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says an empty system prompt has no content, and shows absent values as a dash', () => {
    renderDetail(detail({ system: [], params: { model: 'm', temperature: null, top_k: 40 } }));
    expect(screen.getByText('No content')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('40').tagName).toBe('DD');
    expect(screen.queryByText('null')).toBeNull();
  });

  it('renders the model’s markdown, not the user’s, with its source one click away', async () => {
    renderDetail(
      detail({
        messages: [
          { role: 'user', content: '# Not a heading' },
          { role: 'assistant', content: [{ type: 'text', text: '# Title\n\n- one\n- two' }] },
        ],
      }),
    );
    const [assistant, user] = messages() as [HTMLElement, HTMLElement];
    expect(
      await within(assistant).findByRole('heading', { level: 5, name: 'Title' }),
    ).toBeInTheDocument();
    expect(within(assistant).getAllByRole('listitem')).toHaveLength(2);
    expect(within(user).queryByRole('heading')).toBeNull();
    expect(user).toHaveTextContent('# Not a heading');

    fireEvent.click(screen.getByRole('radio', { name: 'Source' }));
    const [source] = messages() as [HTMLElement];
    expect(within(source).queryByRole('heading')).toBeNull();
    expect(source.querySelector('p')?.textContent).toBe('# Title\n\n- one\n- two');
    expect(JSON.parse(localStorage.getItem('glassbox.detail') ?? '{}')).toMatchObject({
      markdown: 'source',
    });
  });

  it('scrolls a long system block in place, not the chain around it', () => {
    renderDetail(detail({ system: ['Block one'] }));
    expect(screen.getByText('Block one').closest('[data-scroll-region]')).not.toBeNull();
  });

  it('offers Rendered / Source only when there is a reply to render', () => {
    renderDetail(detail({ messages: [{ role: 'user', content: '# hi' }] }));
    expect(screen.queryByRole('radio', { name: 'Source' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Newest first' })).toBeInTheDocument();
  });

  it('says what was not recorded, and speaks Chinese', () => {
    renderDetail(detail({ params: { model: 'grok' } }), 'zh');
    expect(screen.getAllByText('未记录')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: '消息' })).toBeInTheDocument();
  });
});

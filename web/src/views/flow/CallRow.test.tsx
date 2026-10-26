import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import type { ModelRequest, ToolCall } from '../../../../src/core/model.js';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { CallRow } from './CallRow';

function renderRow(
  requestId: string,
  blocks?: ModelRequest['blocks'],
  change: { req?: Partial<ModelRequest>; tool?: Partial<ToolCall> } = {},
  locale: 'en' | 'zh' = 'en',
) {
  const open = demoOpen();
  const found = open.requests.get(requestId);
  if (!found) throw new Error('fixture');
  const req = { ...found, ...(blocks ? { blocks } : {}), ...change.req };
  const tools = req.toolCallIds
    .map((id) => open.toolCalls.get(id))
    .filter((t): t is ToolCall => t !== undefined)
    .map((t) => ({ ...t, ...change.tool }));
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <CallRow
        req={req}
        tools={tools}
        open={open}
        focused={false}
        selected={null}
        onSelect={() => {}}
        onEnterAgent={() => {}}
      />
    </I18nContext.Provider>,
  );
  return screen.getByRole('article');
}

/** The arrow that leads to `el`, when the two travel together in one wrapper. */
const leadingArrow = (el: Element) =>
  el.parentElement?.children.length === 2 && el.previousElementSibling?.tagName === 'svg';

describe('CallRow strip', () => {
  // The strip wraps instead of scrolling: an arrow left at the end of a line would point at
  // nothing, so each one moves to the next line with its card.
  it('keeps each arrow with the card it leads to', () => {
    const row = renderRow('req_m2');
    const [request, ...rest] = within(row).getAllByRole('group');
    expect(request?.previousElementSibling).toBeNull();
    expect(rest.map((card) => card.getAttribute('aria-label'))).toEqual([
      'Response',
      'Read',
      'Edit',
      'Read',
      'Edit',
      'Edit',
      'Write',
      'MultiEdit',
      'NotebookEdit',
      'Read',
      'Read',
    ]);
    for (const card of rest) expect(leadingArrow(card)).toBe(true);
  });

  it('keeps the arrow to the final reply with it', () => {
    const row = renderRow('req_m3');
    expect(leadingArrow(within(row).getByText('Final reply'))).toBe(true);
  });
});

describe('CallRow readings', () => {
  const readings = (row: HTMLElement) =>
    row.querySelector('[title^="in "], [title^="输入 "]') as HTMLElement;

  it('leads with the context, what was new to the cache and the output, compact', () => {
    const row = renderRow('req_m1');
    const line = readings(row);
    expect(line).toHaveTextContent(/^context 31\.3K\s*new 31K\s*out 820 \(610 thinking\)$/);
    expect(line).toHaveAttribute(
      'title',
      'in 31,250 · uncached 6 · cache hit 244 · cache write 31,000 · out 820 (610 thinking)',
    );
    // Each figure is mono; the words that name them are not.
    expect([...line.querySelectorAll('.figure')].map((f) => f.textContent)).toEqual([
      '31.3K',
      '31K',
      '820',
      '610',
    ]);
  });

  it('leaves out "new" when nothing came from or went to the cache: it would repeat the context', () => {
    const row = renderRow('req_m1', undefined, {
      req: {
        usage: {
          input: 1_200,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 90,
          thinking: 0,
          webSearch: 0,
          webFetch: 0,
        },
      },
    });
    const line = readings(row);
    expect(line).toHaveTextContent(/^context 1\.2K\s*out 90$/);
    expect(line).toHaveAttribute('title', 'in 1,200 · out 90');
  });

  // I3: zh compact counts end in 万; the unit leaves the mono face, the digits stay in it.
  it('keeps a Chinese unit out of the mono face', () => {
    const row = renderRow('req_m1', undefined, {}, 'zh');
    const line = readings(row);
    expect(line).toHaveTextContent(/^上下文 3\.13万\s*新输入 3\.1万\s*输出 820 \(思考 610\)$/);
    for (const f of line.querySelectorAll('.figure')) expect(f.textContent).not.toMatch(/万/);
    expect(line).toHaveAttribute(
      'title',
      '输入 31,250 · 未缓存 6 · 缓存命中 244 · 缓存写入 31,000 · 输出 820 (思考 610)',
    );
  });
});

describe('CallRow why line', () => {
  const why = (row: HTMLElement) => row.querySelector('p');

  it('says, under the call line, why the call did what it did', () => {
    const row = renderRow('req_m3');
    expect(
      within(row).getByText('Fixed: busy sessions now sort first, then by most recent update.', {
        selector: 'p',
      }),
    ).toBeInTheDocument();
  });

  it('says nothing for a call that only ran tools, and leaves the cards’ summaries as they were', () => {
    const row = renderRow('req_m2', []);
    expect(why(row)).toBeNull();
    expect(within(row).getAllByRole('group', { name: 'Read' })[0]).toHaveTextContent('store.ts');
  });

  // A call in flight with nothing said: req_m2 has one tool of its own, a Read.
  const inFlight = (tool: Partial<ToolCall>) =>
    renderRow('req_m2', [], {
      req: { status: 'in-flight', endedAt: null },
      tool: { endedAt: null, durationMs: null, ...tool },
    });

  it('counts the thinking while the call waits on the model', () => {
    const row = inFlight({ status: 'complete', endedAt: '2026-10-23T09:00:01.000Z' });
    expect(why(row)).toHaveTextContent(/^Thinking · /);
  });

  it('says nothing while one of its own tools runs: the tool card counts that time', () => {
    const row = inFlight({ status: 'running' });
    expect(why(row)).toBeNull();
    expect(within(row).getByRole('group', { name: 'Response' })).not.toHaveTextContent('Thinking');
  });

  // I3: zh says "已 0:12"; the 已 stays in the UI face, only the clock is a figure.
  it('keeps the in-flight clock’s Chinese words out of the mono face', () => {
    const row = renderRow(
      'req_m2',
      [],
      { req: { status: 'in-flight', endedAt: null }, tool: { status: 'running', endedAt: null } },
      'zh',
    );
    const figures = [...row.querySelectorAll('.figure')].map((f) => f.textContent ?? '');
    for (const f of figures) expect(f, f).not.toMatch(/[\u3000-\u9fff]/);
    expect(row).toHaveTextContent(/已 ?\d+:\d\d/);
  });

  // I3b F3: the context chip in zh ("上下文 3.5万"): the digits a figure, 万 out of mono.
  it('keeps the context chip’s Chinese unit out of its figure', () => {
    const row = renderRow('req_m2', undefined, {}, 'zh');
    const chip = within(within(row).getByRole('group', { name: '请求' })).getByText(/上下文/);
    expect(chip).toHaveTextContent(/^上下文 [\d.]+万$/);
    const figure = chip.querySelector('.figure');
    expect(figure?.textContent).toMatch(/^[\d.]+$/);
  });

  it('falls back to what the call thought', () => {
    const row = renderRow('req_m2', [
      {
        kind: 'thinking',
        text: 'The sort is in store.ts. Read it first.',
        durationMs: 900,
        at: '2026-10-23T09:00:00.000Z',
      },
    ]);
    expect(
      within(row).getByText('The sort is in store.ts.', { selector: 'p' }),
    ).toBeInTheDocument();
  });
});

describe('CallRow styles', () => {
  const sheet = postcss.parse(
    readFileSync(join(import.meta.dirname, 'CallRow.module.css'), 'utf8'),
  );
  const decls = (selector: string) => {
    const out: Record<string, string> = {};
    sheet.walkRules((rule: Rule) => {
      if (!rule.selectors.includes(selector)) return;
      rule.walkDecls((d) => {
        out[d.prop] = d.value;
      });
    });
    return out;
  };

  // D1 P6: separators are a muted middle dot with spaces, never a pipe or a bordered span.
  it('separates the call line with muted middle dots, which screen readers skip', () => {
    sheet.walkDecls(/^border-(left|right)$/, (d) => {
      throw new Error(`a bordered separator: ${d.toString()}`);
    });
    for (const selector of ['.meta::before', '.readings::before', '.reading + .reading::before'])
      expect(decls(selector), selector).toMatchObject({
        content: '"·" / ""',
        color: 'var(--muted)',
      });
  });
});

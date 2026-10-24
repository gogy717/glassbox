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
    <I18nContext.Provider value={makeI18n('en')}>
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
    ]);
    for (const card of rest) expect(leadingArrow(card)).toBe(true);
  });

  it('keeps the arrow to the final reply with it', () => {
    const row = renderRow('req_m3');
    expect(leadingArrow(within(row).getByText('Final reply'))).toBe(true);
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
    expect(within(row).getByRole('group', { name: 'Read' })).toHaveTextContent('store.ts');
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

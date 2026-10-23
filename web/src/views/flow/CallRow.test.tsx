import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../../src/core/model.js';
import { I18nContext, makeI18n } from '../../i18n';
import { demoOpen } from '../../test/demo';
import { CallRow } from './CallRow';

function renderRow(requestId: string) {
  const open = demoOpen();
  const req = open.requests.get(requestId);
  if (!req) throw new Error('fixture');
  const tools = req.toolCallIds
    .map((id) => open.toolCalls.get(id))
    .filter((t): t is ToolCall => t !== undefined);
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

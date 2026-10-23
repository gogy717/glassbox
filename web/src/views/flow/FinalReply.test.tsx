import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest } from '../../../../src/core/model.js';
import type { OpenSession } from '../../data/store';
import { I18nContext, type Locale, makeI18n } from '../../i18n';
import type { Route } from '../../router';
import { demoOpen } from '../../test/demo';
import { useFakeLayout } from '../../test/layout';
import { UiContext } from '../../ui';
import { FlowView } from './FlowView';

/** Turn 1 of the demo: call #3 ends it with a reply and no tools. */
function renderTurn1(open: OpenSession = demoOpen(), locale: Locale = 'en') {
  const route: Route = {
    sessionId: open.id,
    agentId: 'main',
    tab: 'flow',
    turnId: 'turn_m1',
    requestId: null,
  };
  const setFollow = vi.fn();
  render(
    <I18nContext.Provider value={makeI18n(locale)}>
      <UiContext.Provider value={{ follow: false, setFollow }}>
        <FlowView open={open} agentId="main" route={route} navigate={vi.fn()} />
      </UiContext.Provider>
    </I18nContext.Provider>,
  );
  return { setFollow };
}

const row = (n: number) => screen.getByRole('article', { name: `Model call #${n}` });
const pill = () => within(row(3)).getByRole('button', { name: /^Final reply/ });
const responseCard = () => within(row(3)).getByRole('button', { name: /^Response/ });
const responsePanel = () => within(row(3)).queryByRole('region', { name: 'Response details' });

describe('Final reply', () => {
  useFakeLayout();
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens and closes the call’s Response panel, which holds the reply', () => {
    const { setFollow } = renderTurn1();
    expect(pill()).toHaveAttribute('aria-expanded', 'false');
    expect(pill()).not.toHaveAttribute('aria-controls');
    expect(pill()).toHaveAttribute('title', 'Show final reply');
    expect(responsePanel()).toBeNull();

    fireEvent.click(pill());
    const panel = responsePanel();
    expect(panel).toHaveTextContent('Fixed: busy sessions now sort first');
    expect(pill()).toHaveAttribute('aria-expanded', 'true');
    expect(pill()).toHaveAttribute('title', 'Hide final reply');
    const controlled = document.getElementById(pill().getAttribute('aria-controls') ?? '');
    expect(controlled?.contains(panel)).toBe(true);
    // Opened like the card: follow pauses, so new calls do not scroll it away.
    expect(setFollow).toHaveBeenCalledWith(false);

    fireEvent.click(pill());
    expect(responsePanel()).toBeNull();
    expect(pill()).toHaveAttribute('aria-expanded', 'false');
  });

  it('is one thing with the Response card: each shows what the other opened', () => {
    renderTurn1();
    fireEvent.click(responseCard());
    expect(responseCard()).toHaveAttribute('aria-pressed', 'true');
    expect(pill()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(pill());
    expect(responseCard()).toHaveAttribute('aria-pressed', 'false');
    expect(responsePanel()).toBeNull();
  });

  it('takes over from a panel open elsewhere, and gives way to another card', () => {
    renderTurn1();
    fireEvent.click(within(row(1)).getByRole('button', { name: /^Request/ }));
    fireEvent.click(pill());
    expect(within(row(1)).queryByRole('region')).toBeNull();
    expect(responsePanel()).toBeInTheDocument();

    fireEvent.click(within(row(3)).getByRole('button', { name: /^Request/ }));
    expect(pill()).toHaveAttribute('aria-expanded', 'false');
  });

  it('stays a label, saying why, when the call left no reply text', () => {
    const open = demoOpen();
    const req = open.requests.get('req_m3') as ModelRequest;
    open.requests = new Map(open.requests).set('req_m3', {
      ...req,
      blocks: req.blocks.filter((b) => b.kind !== 'text'),
    });
    renderTurn1(open);
    expect(within(row(3)).queryByRole('button', { name: /^Final reply/ })).toBeNull();
    expect(within(row(3)).getByText('Final reply').closest('[title]')).toHaveAttribute(
      'title',
      'This call ended without reply text',
    );
  });

  it('speaks Chinese', () => {
    renderTurn1(demoOpen(), 'zh');
    const zhPill = within(screen.getByRole('article', { name: '模型调用 #3' })).getByRole(
      'button',
      { name: /^最终回复/ },
    );
    expect(zhPill).toHaveAttribute('title', '显示最终回复');
    fireEvent.click(zhPill);
    expect(zhPill).toHaveAttribute('title', '收起最终回复');
  });
});

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LivePartial } from '../../../../src/shared/runs.js';
import { I18nContext, makeI18n } from '../../i18n';
import { LiveOverlay } from './LiveOverlay';

const partial: LivePartial = {
  messageId: 'msg_1',
  startedAt: '2026-10-23T10:00:00.000Z',
  thinking: 'Checking the sort order',
  thinkingTokens: null,
  text: 'Let me look at',
  toolUses: [{ id: 'tu_1', name: 'Bash', inputJson: '{"command":"rg sort' }],
};

const renderOverlay = (p: LivePartial | null) =>
  render(
    <I18nContext.Provider value={makeI18n('en')}>
      <LiveOverlay partial={p} />
    </I18nContext.Provider>,
  );

describe('LiveOverlay', () => {
  afterEach(() => vi.useRealTimers());

  it('while thinking, shows elapsed time and the growing token estimate instead of empty text', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:05.000Z'));
    renderOverlay({ ...partial, thinking: '', text: '', toolUses: [], thinkingTokens: 1_234 });
    const live = screen.getByRole('status', { name: 'Replying live' });
    expect(live).toHaveTextContent('Thinking · 0:05 · ~1,234 tokens');
    expect(live.querySelectorAll('p')).toHaveLength(0);
    // The figures are set as figures (mono, tabular); the words stay in the UI face.
    expect([...live.querySelectorAll('.figure')].map((f) => f.textContent)).toEqual([
      '0:05',
      '1,234',
    ]);
  });

  it('streams thinking, text and tool input as they arrive', () => {
    renderOverlay(partial);
    const live = screen.getByRole('status', { name: 'Replying live' });
    expect(live).toHaveTextContent('Checking the sort order');
    expect(live).toHaveTextContent('Let me look at');
    expect(live).toHaveTextContent('Bash');
    expect(live).toHaveTextContent('{"command":"rg sort');
  });

  it('keeps the time and thinking tokens visible once the answer streams', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:07.000Z'));
    renderOverlay({ ...partial, thinking: '', thinkingTokens: 480 });
    const live = screen.getByRole('status', { name: 'Replying live' });
    expect(live).toHaveTextContent('0:07 · ~480 thinking tokens');
    expect(live).toHaveTextContent('Let me look at');
  });

  it('renders nothing when nothing is streaming', () => {
    const { container } = renderOverlay(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows only what has arrived so far', () => {
    renderOverlay({ ...partial, thinking: '', text: '', toolUses: [], thinkingTokens: null });
    const live = screen.getByRole('status', { name: 'Replying live' });
    expect(live.querySelectorAll('p')).toHaveLength(0);
  });
});

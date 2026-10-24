import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Turn } from '../../../../src/core/model.js';
import type { UiStatus } from '../../components/Status';
import { I18nContext, type Locale, makeI18n } from '../../i18n';
import { formatClock } from '../../lib/format';
import { FollowPausedBar } from './FollowPausedBar';
import { TurnHeader } from './TurnHeader';
import headerCss from './TurnHeader.module.css';
import type { TurnItem } from './TurnList';

const STARTED = '2026-10-24T01:01:05.000Z';

function item(n: number, status: UiStatus = 'complete', prompt = `Research ${n}`): TurnItem {
  const turn = {
    id: `turn_${n}`,
    agentId: 'main',
    index: n,
    origin: 'human',
    prompt,
    startedAt: STARTED,
    endedAt: status === 'running' ? null : '2026-10-24T01:02:00.000Z',
    status: status === 'running' ? 'running' : 'complete',
    requestIds: [],
  } as Turn;
  return {
    turn,
    label: `Conversation ${n}`,
    title: prompt,
    prompt,
    calls: 2,
    tools: 2,
    status,
    command: false,
  };
}

const wrap = (node: React.ReactNode, locale: Locale = 'en') =>
  render(<I18nContext.Provider value={makeI18n(locale)}>{node}</I18nContext.Provider>);

/** The header around the h2: not a named group, so its name is said once, by the heading. */
const header = () =>
  screen.getByRole('heading', { level: 2 }).closest(`.${headerCss.header}`) as HTMLElement;

describe('TurnHeader', () => {
  it('labels the conversation, then its clock, duration, counts and status', () => {
    wrap(<TurnHeader item={item(2)} />);
    const head = header();
    expect(within(head).getByText(formatClock(STARTED))).toHaveClass('figure');
    expect(within(head).getByText('55s')).toHaveClass('figure');
    expect(head).toHaveTextContent('2 model calls · 2 tools');
    expect(within(head).getByText('Complete')).toBeInTheDocument();
  });

  // The visible label is a section label; the heading itself names the conversation once.
  it('heads with the prompt alone on screen, the conversation named for screen readers', () => {
    wrap(<TurnHeader item={item(2, 'complete', 'Research how a live viewer works')} />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveAccessibleName('Conversation 2: Research how a live viewer works');
    expect(heading.querySelector('.visually-hidden')).toHaveTextContent('Conversation 2:');
    expect(screen.getByText('Conversation 2', { selector: '.section-label' })).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    // Said once: no group around it repeats the name.
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('does not name a conversation twice when its heading is the label', () => {
    const it2 = { ...item(3, 'complete', ''), prompt: 'Conversation 3' };
    wrap(<TurnHeader item={it2} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName('Conversation 3');
  });

  it('takes what a view shows under the prompt (the Steps view’s phase shares)', () => {
    wrap(
      <TurnHeader item={item(2)}>
        <div data-testid="shares" />
      </TurnHeader>,
    );
    expect(within(header()).getByTestId('shares')).toBeInTheDocument();
  });

  it('speaks Chinese', () => {
    wrap(<TurnHeader item={{ ...item(2), label: '第 2 轮' }} />, 'zh');
    expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName('第 2 轮: Research 2');
    expect(header()).toHaveTextContent('2 次调用 · 2 个工具');
  });
});

describe('FollowPausedBar', () => {
  it('says following is paused, and which conversation is still running', () => {
    wrap(<FollowPausedBar newest={item(5, 'running')} onBack={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Following paused · Conversation 5 is running',
    );
  });

  it('says when the newest conversation waits for you', () => {
    wrap(<FollowPausedBar newest={item(5, 'approval')} onBack={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Following paused · Conversation 5 is waiting for you',
    );
  });

  it.each([
    ['complete', item(5)],
    ['missing', undefined],
  ])('says only that following is paused when the newest is %s', (_, newest) => {
    wrap(<FollowPausedBar newest={newest} onBack={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Following paused$/);
  });

  it('goes back to the latest', () => {
    const onBack = vi.fn();
    wrap(<FollowPausedBar newest={item(5, 'running')} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to latest' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('speaks Chinese', () => {
    wrap(
      <FollowPausedBar newest={{ ...item(5, 'running'), label: '第 5 轮' }} onBack={() => {}} />,
      'zh',
    );
    expect(screen.getByRole('status')).toHaveTextContent('已暂停跟随 · 第 5 轮正在运行');
    expect(screen.getByRole('button', { name: '回到最新' })).toBeInTheDocument();
  });
});

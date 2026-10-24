import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLTIP_DELAY_MS, Tooltip } from './Tooltip';

describe('Tooltip', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const renderTip = () =>
    render(
      <Tooltip label="/home/user/dev/glassbox">
        <button type="button">glassbox</button>
      </Tooltip>,
    );

  it('describes its anchor, and shows only after the pointer rests for 400 ms', () => {
    renderTip();
    const button = screen.getByRole('button', { name: 'glassbox' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(button).toHaveAccessibleDescription('/home/user/dev/glassbox');
    expect(tip).not.toBeVisible();
    fireEvent.pointerEnter(button);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1));
    expect(tip).not.toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(tip).toBeVisible();
    fireEvent.pointerLeave(button);
    expect(tip).not.toBeVisible();
  });

  it('shows on focus and hides on Escape without letting it close a dialog around it', () => {
    const onKeyDown = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: a stand-in for a dialog's Escape handler
      <div onKeyDown={onKeyDown}>
        <Tooltip label="Why">
          <button type="button">Thing</button>
        </Tooltip>
      </div>,
    );
    const button = screen.getByRole('button', { name: 'Thing' });
    fireEvent.focus(button);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    expect(screen.getByRole('tooltip')).toBeVisible();
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible();
    expect(onKeyDown).not.toHaveBeenCalled();
    // Once hidden, Escape belongs to the dialog again.
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('adds itself to a description the anchor already has', () => {
    render(
      <>
        <span id="own">Unavailable right now</span>
        <Tooltip label="/home/user/dev">
          <button type="button" aria-describedby="own">
            dev
          </button>
        </Tooltip>
      </>,
    );
    expect(screen.getByRole('button', { name: 'dev' })).toHaveAccessibleDescription(
      'Unavailable right now /home/user/dev',
    );
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useOnePopover, usePopoverDismiss } from './popover';

/** A popover as the app's are built: a trigger and a panel inside one wrapper. */
function Popover({
  name = 'a',
  onClose = () => {},
  returnFocus = true,
}: {
  name?: string;
  onClose?(): void;
  returnFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    onClose();
    setOpen(false);
  };
  usePopoverDismiss(ref, open, close, returnFocus ? trigger : undefined);
  useOnePopover(name, open, () => setOpen(false));
  return (
    <div ref={ref}>
      <button ref={trigger} type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {name}
      </button>
      {open && (
        <div role="dialog" aria-label={name}>
          <button type="button">inside {name}</button>
        </div>
      )}
    </div>
  );
}

// Final review M9: the five popovers' dismissal, written once.
describe('usePopoverDismiss', () => {
  it('closes on a pointer down outside, not inside', () => {
    render(
      <>
        <Popover />
        <p>elsewhere</p>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'inside a' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape wherever focus is, and hands focus back to the trigger', () => {
    render(<Popover />);
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    screen.getByRole('button', { name: 'inside a' }).focus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'a' })).toHaveFocus();
  });

  it('leaves focus alone without a trigger to return it to', () => {
    render(<Popover returnFocus={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    const inside = screen.getByRole('button', { name: 'inside a' });
    inside.focus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'a' })).not.toHaveFocus();
  });

  it('listens only while open, and ignores other keys', () => {
    const onClose = vi.fn();
    render(<Popover onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps one popover open at a time alongside useOnePopover', () => {
    render(
      <>
        <Popover name="a" />
        <Popover name="b" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    // Opened from the keyboard: no pointer down to close the other.
    fireEvent.click(screen.getByRole('button', { name: 'b' }));
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-label'))).toEqual(['b']);
  });
});

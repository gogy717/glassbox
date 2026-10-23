import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Switch, type SwitchOption } from './Switch';

type Mode = 'continue' | 'copy' | 'fresh';
const OPTIONS: SwitchOption<Mode>[] = [
  { value: 'continue', label: 'Continue', disabled: true, title: 'Open in a terminal right now' },
  { value: 'copy', label: 'Continue in a copy' },
  { value: 'fresh', label: 'New' },
];

function Controlled({ onChange }: { onChange(v: Mode): void }) {
  const [value, setValue] = useState<Mode>('copy');
  return (
    <Switch<Mode>
      label="Mode"
      value={value}
      options={OPTIONS}
      onChange={(v) => {
        onChange(v);
        setValue(v);
      }}
    />
  );
}

describe('Switch', () => {
  it('is a named radio group with one tab stop, on the chosen word', () => {
    render(
      <Switch
        label="View"
        value="json"
        options={[
          { value: 'readable', label: 'Readable' },
          { value: 'json', label: 'JSON' },
        ]}
        onChange={vi.fn()}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'View' });
    const [readable, json] = screen.getAllByRole('radio');
    expect(group).toContainElement(readable as HTMLElement);
    expect(json).toHaveAttribute('aria-checked', 'true');
    expect(readable).toHaveAttribute('aria-checked', 'false');
    expect([readable?.tabIndex, json?.tabIndex]).toEqual([-1, 0]);
  });

  it('reports a different word only', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Continue in a copy' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'New' }));
    expect(onChange).toHaveBeenCalledWith('fresh');
  });

  it('moves the choice and focus with the arrow keys, Home and End, skipping disabled words', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const copy = screen.getByRole('radio', { name: 'Continue in a copy' });
    copy.focus();
    fireEvent.keyDown(copy, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('fresh');
    const fresh = screen.getByRole('radio', { name: 'New' });
    expect(fresh).toHaveFocus();
    expect(fresh).toHaveAttribute('aria-checked', 'true');
    // Wraps around, past the disabled first word.
    fireEvent.keyDown(fresh, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('copy');
    fireEvent.keyDown(copy, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('fresh');
    fireEvent.keyDown(fresh, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('copy');
    expect(onChange).not.toHaveBeenCalledWith('continue');
  });

  it('shows an unavailable word disabled, with its reason', () => {
    render(<Controlled onChange={vi.fn()} />);
    const unavailable = screen.getByRole('radio', { name: 'Continue' });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveAttribute('title', 'Open in a terminal right now');
    expect(unavailable.tabIndex).toBe(-1);
  });
});

/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import postcss from 'postcss';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { moduleCssValue } from '../test/module-css';
import { Switch, type SwitchOption } from './Switch';
import classes from './Switch.module.css';

type Mode = 'continue' | 'copy' | 'fresh';
const OPTIONS: SwitchOption<Mode>[] = [
  { value: 'continue', label: 'Continue', disabled: true, title: 'Open in a terminal right now' },
  { value: 'copy', label: 'Continue in a copy' },
  { value: 'fresh', label: 'New' },
];

function Controlled({ onChange, initial = 'copy' }: { onChange(v: Mode): void; initial?: Mode }) {
  const [value, setValue] = useState<Mode>(initial);
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

const CSS_FILE = join(import.meta.dirname, 'Switch.module.css');
const cssValue = (el: Element, prop: string) => moduleCssValue(CSS_FILE, classes, el, prop);

/** The drawn strike of an unavailable word (a ::after line; jsdom matches no pseudo-elements). */
function strike(): Record<string, string> {
  const out: Record<string, string> = {};
  postcss.parse(readFileSync(CSS_FILE, 'utf8')).walkRules((rule) => {
    if (rule.selector !== '.word[aria-disabled="true"]::after') return;
    rule.walkDecls((d) => {
      out[d.prop] = d.value;
    });
  });
  return out;
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

  it('reports a different, enabled word only', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Continue in a copy' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Continue' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'New' }));
    expect(onChange).toHaveBeenCalledWith('fresh');
  });

  it('moves the focus with the arrow keys, Home and End, choosing only enabled words', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const [unavailable, copy, fresh] = screen.getAllByRole('radio') as HTMLElement[];
    copy?.focus();
    fireEvent.keyDown(copy as HTMLElement, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('fresh');
    expect(fresh).toHaveFocus();
    expect(fresh).toHaveAttribute('aria-checked', 'true');
    // Wraps to the disabled first word: focus only, so its reason is read; the choice stays.
    fireEvent.keyDown(fresh as HTMLElement, { key: 'ArrowRight' });
    expect(unavailable).toHaveFocus();
    expect(fresh).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(unavailable as HTMLElement, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('copy');
    expect(copy).toHaveFocus();
    fireEvent.keyDown(copy as HTMLElement, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('fresh');
    fireEvent.keyDown(fresh as HTMLElement, { key: 'Home' });
    expect(unavailable).toHaveFocus();
    fireEvent.keyDown(unavailable as HTMLElement, { key: 'ArrowLeft' });
    expect(fresh).toHaveFocus();
    expect(onChange).not.toHaveBeenCalledWith('continue');
  });

  it('keeps an unavailable word reachable, with its reason, but never chosen', () => {
    render(<Controlled onChange={vi.fn()} />);
    const unavailable = screen.getByRole('radio', { name: 'Continue' });
    // aria-disabled, not disabled: a disabled button cannot take focus, and its title would
    // then reach no keyboard or screen reader user.
    expect(unavailable).not.toBeDisabled();
    expect(unavailable).toHaveAttribute('aria-disabled', 'true');
    expect(unavailable).toHaveAttribute('title', 'Open in a terminal right now');
    expect(unavailable).toHaveAccessibleDescription('Open in a terminal right now');
    expect(unavailable.tabIndex).toBe(-1);
    // Struck through by a drawn line, past both ends: a line-through vanishes into CJK strokes.
    expect(cssValue(unavailable, 'position')).toBe('relative');
    expect(strike()).toMatchObject({
      content: '""',
      height: '1px',
      left: '-2px',
      right: '-2px',
      background: 'currentColor',
    });
    expect(cssValue(unavailable, 'color')).toBe('var(--faint)');
  });

  it('with no enabled word chosen, ArrowLeft goes to the last word', () => {
    const onChange = vi.fn();
    render(
      <Switch
        label="Order"
        value={'none' as string}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C' },
        ]}
        onChange={onChange}
      />,
    );
    // Nothing is chosen, so the first word holds the tab stop.
    const [a, , c] = screen.getAllByRole('radio') as HTMLElement[];
    expect(a?.tabIndex).toBe(0);
    a?.focus();
    fireEvent.keyDown(a as HTMLElement, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    expect(c).toHaveFocus();
  });

  it('shows a chosen word that became unavailable as still chosen, struck through', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} initial="continue" />);
    const unavailable = screen.getByRole('radio', { name: 'Continue' });
    expect(unavailable).toHaveAttribute('aria-checked', 'true');
    expect(unavailable.tabIndex).toBe(0);
    // The ink underline stays, under the drawn strike.
    expect(cssValue(unavailable, 'text-decoration')).toBe('underline');
    expect(cssValue(unavailable, 'position')).toBe('relative');
    expect(cssValue(unavailable, 'text-decoration-color')).toBe('var(--ink)');
    expect(cssValue(unavailable, 'font-weight')).toBe('500');
    // From it, ArrowLeft wraps to the last word and chooses it.
    unavailable.focus();
    fireEvent.keyDown(unavailable, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('fresh');
  });
});

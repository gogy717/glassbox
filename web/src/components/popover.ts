import { type RefObject, useEffect } from 'react';

const EVENT = 'glassbox:popover';

/**
 * One top-bar popover open at a time: opening one tells the others to close. A click elsewhere
 * closes them already; a popover opened from the keyboard fires no pointerdown, so this does.
 */
export function useOnePopover(name: string, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== name) close();
    };
    document.addEventListener(EVENT, onOther);
    document.dispatchEvent(new CustomEvent(EVENT, { detail: name }));
    return () => document.removeEventListener(EVENT, onOther);
  }, [open, name, close]);
}

/**
 * A popover's dismissal: a pointer down outside `ref` (its trigger and panel) closes it, and so
 * does Escape wherever focus is, handing focus back to `returnFocusTo`, its trigger, so a
 * keyboard user is where they were. Listens only while open.
 */
export function usePopoverDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
  returnFocusTo?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      returnFocusTo?.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close, returnFocusTo]);
}

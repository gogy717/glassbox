import { useEffect } from 'react';

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

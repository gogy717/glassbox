import type { KeyboardEvent } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab and Shift+Tab inside `container`: from the last focusable element Tab wraps to the
 * first, and the other way round. Call from the container's onKeyDown.
 */
export function trapTab(e: KeyboardEvent<HTMLElement>, container: HTMLElement | null): void {
  if (e.key !== 'Tab' || !container) return;
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    e.preventDefault();
    return;
  }
  const active = document.activeElement;
  const outside = !container.contains(active);
  if (e.shiftKey && (active === first || active === container || outside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || outside)) {
    e.preventDefault();
    first.focus();
  }
}

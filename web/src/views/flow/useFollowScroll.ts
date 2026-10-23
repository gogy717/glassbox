import { type RefObject, useEffect, useRef } from 'react';

/** Wheel targets that scroll themselves (JSON trees, code) keep the wheel. */
const OWN_SCROLL = '[data-scroll-region]';

/**
 * Follow-mode plumbing for a scrolling list (execution chain, steps): scrolling up — by wheel,
 * scrollbar, keys or touch — is the reader's signal to stop following. The wheel is also routed
 * to the list so horizontal card strips do not swallow vertical scrolling, as in the DSH
 * workflow plugin. While following, the list stays at the bottom when its viewport changes
 * size (the turn's prompt expanded above it, the window resized).
 * The scroller must exist from the first render, so the listeners attach once.
 */
export function useFollowScroll(
  ref: RefObject<HTMLElement | null>,
  follow: boolean,
  onAway: () => void,
): void {
  const followRef = useRef(follow);
  followRef.current = follow;
  const awayRef = useRef(onAway);
  awayRef.current = onAway;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let userUntil = 0;
    const markUser = () => {
      userUntil = Date.now() + 600;
    };
    const onWheel = (e: WheelEvent) => {
      markUser();
      if (e.deltaY < 0 && followRef.current) awayRef.current();
      const target = e.target as Element | null;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || target?.closest(OWN_SCROLL)) return;
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      el.scrollTop += e.deltaY * scale;
      e.preventDefault();
    };
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (!atBottom && followRef.current && Date.now() < userUntil) awayRef.current();
    };
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    el.addEventListener('pointerdown', markUser);
    el.addEventListener('keydown', markUser);
    el.addEventListener('touchmove', markUser, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (followRef.current) el.scrollTop = el.scrollHeight;
          });
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      el.removeEventListener('wheel', onWheel, { capture: true });
      el.removeEventListener('pointerdown', markUser);
      el.removeEventListener('keydown', markUser);
      el.removeEventListener('touchmove', markUser);
      el.removeEventListener('scroll', onScroll);
    };
  }, [ref]);
}

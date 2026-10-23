import { type RefObject, useEffect, useState } from 'react';

/** Tracks an element's content width; `fallback` until measured (and in environments without layout). */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback = 640): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

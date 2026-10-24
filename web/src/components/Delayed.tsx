import { type ReactNode, useEffect, useState } from 'react';

/**
 * How long a wait lasts before it says so. A local load is usually done sooner, and a
 * "Loading…" that flashes for a frame or two reads as a glitch.
 */
export const WAIT_MS = 200;

/** Its children once `WAIT_MS` has passed: a wait that ends sooner shows nothing. */
export function Delayed({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShown(true), WAIT_MS);
    return () => clearTimeout(id);
  }, []);
  return shown ? children : null;
}

import type { LiveState } from '../core/model.js';

/** busy and waiting both mean someone is mid-task in that session right now. */
export function isActive(live: LiveState): boolean {
  return live === 'busy' || live === 'waiting';
}

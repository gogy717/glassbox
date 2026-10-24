/** Reading `/api/week` (contract in `src/shared/week.ts`): the NDJSON stream to its result. */
import {
  type WeekLine,
  type WeekResult,
  type WeekWindowKind,
  weekPath,
} from '../../../src/shared/week.js';

/** `/api/week` read to its result, `onProgress` told how far it got on the way. */
export async function readWeek(
  kind: WeekWindowKind,
  refresh: boolean,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<WeekResult> {
  const res = await fetch(weekPath(kind, refresh), { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: WeekResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const text = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      // A blank line (a keep-alive, or a proxy's) says nothing.
      if (!text) continue;
      const line = JSON.parse(text) as WeekLine;
      if (line.type === 'progress') onProgress(line.done, line.total);
      else if (line.type === 'result') result = line.result;
      else throw new Error(line.error);
    }
    if (done) break;
  }
  if (!result) throw new Error('no result');
  return result;
}

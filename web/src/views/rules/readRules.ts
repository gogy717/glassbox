/** Reading `/api/rules` (contract in `src/shared/permissions.ts`): the NDJSON stream to its result. */
import {
  type RulesLine,
  type RulesResult,
  type RulesWindowKind,
  rulesPath,
} from '../../../../src/shared/permissions.js';

export type ReadRules = (
  kind: RulesWindowKind,
  refresh: boolean,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
) => Promise<RulesResult>;

/** `/api/rules` read to its result, `onProgress` told how far it got on the way. */
export const readRules: ReadRules = async (kind, refresh, onProgress, signal) => {
  const res = await fetch(rulesPath(kind, refresh), { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: RulesResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const text = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!text) continue;
      const line = JSON.parse(text) as RulesLine;
      if (line.type === 'progress') onProgress(line.done, line.total);
      else if (line.type === 'result') result = line.result;
      else throw new Error(line.error);
    }
    if (done) break;
  }
  if (!result) throw new Error('no result');
  return result;
};

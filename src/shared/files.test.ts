import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../core/model.js';
import { buildFiles } from './files.js';

const CWD = '/w/app';

let serial = 0;
/** A finished call of the main agent, a second after the one before it. */
function call(name: string, input: unknown, over: Partial<ToolCall> = {}): ToolCall {
  serial++;
  const at = new Date(Date.UTC(2026, 9, 23, 9, 0, serial)).toISOString();
  return {
    id: `t_${serial}`,
    agentId: 'main',
    requestId: 'r1',
    name,
    input,
    status: 'complete',
    startedAt: at,
    endedAt: at,
    durationMs: 10,
    resultPreview: null,
    hasFullResult: false,
    spawned: null,
    ...over,
  };
}

const source = (calls: ToolCall[]) => ({
  session: { cwd: CWD },
  toolCalls: new Map(calls.map((c) => [c.id, c])),
});

describe('buildFiles (shared)', () => {
  it('reads any session source by id, not only the web store: each file once a verb', () => {
    const files = buildFiles(
      source([
        call('Edit', { file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' }),
        call('Edit', { file_path: 'src/a.ts', old_string: 'b', new_string: 'c' }),
        call('Write', { file_path: `${CWD}/src/b.ts`, content: 'x' }),
        call('Delete', { path: `${CWD}/old.ts` }),
        // A failed edit and a running one are counted apart, not as edits.
        call('Edit', { file_path: `${CWD}/src/c.ts` }, { status: 'error' }),
        call('Edit', { file_path: `${CWD}/src/d.ts` }, { status: 'running', endedAt: null }),
        // Another agent's call is not asked about.
        call('Write', { file_path: `${CWD}/src/e.ts`, content: 'x' }, { agentId: 'sub' }),
      ]),
      new Set(['main']),
    );
    expect(files.summary).toEqual({
      files: 5,
      edited: 1,
      created: 1,
      deleted: 1,
      read: 0,
      searched: 0,
    });
  });
});

/** Feeds a parser the way the server will: one role at a time, jsonl lines or a whole json value. */
import type { SessionSource, SourceFile } from '../../../core/adapter.js';
import type { LiveState } from '../../../core/model.js';
import { GrokSessionParser } from '../parser.js';
import { at, CWD, SESSION_ID } from './builders.js';

export const SESSION_DIR = `/home/u/.grok/sessions/${SESSION_ID}`;

export function makeSource(live: LiveState = 'busy'): SessionSource {
  return {
    agent: 'grok',
    nativeId: SESSION_ID,
    location: SESSION_DIR,
    summary: {
      id: `grok:${SESSION_ID}`,
      agent: 'grok',
      nativeId: SESSION_ID,
      title: null,
      cwd: CWD,
      project: 'garden',
      startedAt: at(0),
      updatedAt: at(0),
      live,
      version: '1.0.67',
      model: null,
      usage: null,
      counts: null,
    },
  };
}

export function file(role: string, name: string): SourceFile {
  return {
    path: `${SESSION_DIR}/${name}`,
    format: name.endsWith('.jsonl') ? 'jsonl' : 'json',
    role,
    agentId: null,
    workflowRunId: null,
  };
}

export const eventsFile = file('events', 'events.jsonl');
export const updatesFile = file('updates', 'updates.jsonl');
export const chatFile = file('chat-history', 'chat_history.jsonl');
export const summaryFile = file('summary', 'summary.json');
export const usageFile = file('usage', 'usage.json');
export const toolsFile = file('tool-definitions', 'tool_definitions.json');

export interface Feed {
  events?: string[];
  updates?: string[];
  chat?: string[];
  summary?: unknown;
  usage?: unknown;
  tools?: unknown;
}

/** Alphabetical role order, which is how paths sort before the server learns grok roles. */
const SERVER_ORDER = ['chat', 'events', 'summary', 'tools', 'updates', 'usage'] as const;
export type FeedRole = (typeof SERVER_ORDER)[number];

export function feed(
  spec: Feed,
  live: LiveState = 'busy',
  order: readonly FeedRole[] = SERVER_ORDER,
): GrokSessionParser {
  const parser = new GrokSessionParser(makeSource(live));
  for (const role of order) {
    if (role === 'events' && spec.events) parser.ingestLines(eventsFile, spec.events);
    if (role === 'updates' && spec.updates) parser.ingestLines(updatesFile, spec.updates);
    if (role === 'chat' && spec.chat) parser.ingestLines(chatFile, spec.chat);
    if (role === 'summary' && spec.summary !== undefined)
      parser.ingestJson(summaryFile, spec.summary);
    if (role === 'usage' && spec.usage !== undefined) parser.ingestJson(usageFile, spec.usage);
    if (role === 'tools' && spec.tools !== undefined) parser.ingestJson(toolsFile, spec.tools);
  }
  return parser;
}

export type ReplayStep =
  | { file: SourceFile; lines: string[] }
  | { file: SourceFile; json: unknown }
  | { live: LiveState };

const KINDS = ['agents', 'turns', 'requests', 'toolCalls', 'workflows'] as const;

/**
 * Feeds `steps` one line at a time, applies every `patch()` to a client-side store the way the
 * UI does, and after each step compares that store with a fresh `snapshot()`. Returns every
 * difference: an entity whose view changed but that no change set reported.
 */
export function replayChecked(
  steps: ReplayStep[],
  live: LiveState = 'busy',
): { parser: GrokSessionParser; problems: string[] } {
  const parser = new GrokSessionParser(makeSource(live));
  const first = parser.snapshot();
  const store = Object.fromEntries(
    KINDS.map((k) => [k, new Map<string, unknown>(first[k].map((e) => [e.id, e]))]),
  ) as Record<(typeof KINDS)[number], Map<string, unknown>>;
  let session: unknown = first.session;
  let diagnostics: unknown = first.diagnostics;
  const problems: string[] = [];
  const atoms = steps.flatMap((s): ReplayStep[] =>
    'lines' in s ? s.lines.map((line) => ({ file: s.file, lines: [line] })) : [s],
  );
  atoms.forEach((step, i) => {
    const ch =
      'live' in step
        ? parser.setLive(step.live)
        : 'json' in step
          ? parser.ingestJson(step.file, step.json)
          : parser.ingestLines(step.file, step.lines);
    const patch = parser.patch(ch);
    session = patch.session;
    if (patch.diagnostics) diagnostics = patch.diagnostics;
    for (const k of KINDS) {
      for (const e of patch[k]) store[k].set(e.id, e);
      for (const id of patch.removed?.[k] ?? []) store[k].delete(id);
    }
    const fresh = parser.snapshot();
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(session, fresh.session)) problems.push(`step ${i}: session stale`);
    if (!same(diagnostics, fresh.diagnostics)) problems.push(`step ${i}: diagnostics stale`);
    for (const k of KINDS) {
      const ids = new Set(fresh[k].map((e) => e.id));
      for (const e of fresh[k])
        if (!same(store[k].get(e.id), e)) problems.push(`step ${i}: ${k} ${e.id} stale`);
      for (const id of store[k].keys())
        if (!ids.has(id)) problems.push(`step ${i}: ${k} ${id} should be removed`);
    }
  });
  return { parser, problems };
}

/**
 * "How the agent worked": each model request is one step (thought → said → did → outcome), and
 * consecutive steps doing the same kind of work form a phase (explore, edit, run, delegate…).
 */
import type { ModelRequest, ToolCall } from '../../../src/core/model.js';
import { totalTokens } from '../../../src/core/usage.js';
import type { Approvals } from '../data/approvals';
import type { OpenSession } from '../data/store';
import { findTurn, requestsOf, startUnknown, toolStatus, toolsOf } from '../views/flow/flow-model';
import { middleEllipsis } from './format';
import { summarizeInput, type ToolCategory, toolCategory } from './tool-category';

/**
 * A tool's summary fitted to `n` characters: a path is cut in the middle, so its root and its
 * file name stay readable ("src/…/server/store.ts"); anything else (a command, a pattern) is
 * left for the line's own end-ellipsis.
 */
export function fitSummary(summary: string, n: number): string {
  return /^[^\s]*[/\\][^\s]*$/.test(summary) ? middleEllipsis(summary, n) : summary;
}

/**
 * Web lookups count as exploring: like reading files, they gather context without changing
 * anything. A step with no tools is the model answering.
 */
export type PhaseCategory = Exclude<ToolCategory, 'web'> | 'answer';

export interface StepAction {
  toolCallId: string;
  name: string;
  category: ToolCategory;
  summary: string;
  /** 'approval': running but blocked on the person answering a permission prompt. */
  status: ToolCall['status'] | 'approval';
  /** How long the tool took; null while it runs, or when its end was not recorded. */
  durationMs: number | null;
}

export interface Step {
  requestId: string;
  index: number;
  category: PhaseCategory;
  startedAt: string | null;
  /** From the request's start to its last tool's end (to `now` while running). */
  durationMs: number | null;
  tokens: number;
  /** `hidden`: the model thought (there are thinking blocks) but none of them has text. */
  thought: { text: string | null; durationMs: number | null; tokens: number; hidden: boolean };
  said: string | null;
  did: StepAction[];
  outcome: 'ok' | 'error' | 'running' | 'interrupted' | 'approval';
  /** The API error that ended the request, if any. */
  error: string | null;
}

export interface Phase {
  category: PhaseCategory;
  steps: Step[];
  startedAt: string | null;
  /** Sum of the steps' known durations; null when none of them is known. */
  durationMs: number | null;
  tokens: number;
}

/** When a step mixes kinds equally, the more consequential kind names it. */
const PRIORITY: PhaseCategory[] = [
  'delegate',
  'edit',
  'git',
  'run',
  'ask',
  'plan',
  'mcp',
  'explore',
  'other',
];

const phaseOf = (c: ToolCategory): PhaseCategory => (c === 'web' ? 'explore' : c);

function dominant(actions: StepAction[]): PhaseCategory {
  if (actions.length === 0) return 'answer';
  const counts = new Map<PhaseCategory, number>();
  for (const a of actions)
    counts.set(phaseOf(a.category), (counts.get(phaseOf(a.category)) ?? 0) + 1);
  let best: PhaseCategory = 'other';
  let bestCount = -1;
  for (const c of PRIORITY) {
    const n = counts.get(c) ?? 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

function stepOf(req: ModelRequest, tools: ToolCall[], now: number, approvals?: Approvals): Step {
  const did = tools.map((t) => ({
    toolCallId: t.id,
    name: t.name,
    category: toolCategory(t.name, t.input),
    summary: summarizeInput(t),
    status: toolStatus(t, approvals) === 'approval' ? ('approval' as const) : t.status,
    durationMs: t.durationMs,
  }));
  const thinking = req.blocks.filter((b) => b.kind === 'thinking');
  const texts = thinking.map((b) => b.text).filter((t): t is string => !!t);
  const durations = thinking.map((b) => b.durationMs).filter((d): d is number => d !== null);
  const said = req.blocks
    .filter((b) => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n');

  const outcome: Step['outcome'] =
    req.status === 'error' || tools.some((t) => t.status === 'error')
      ? 'error'
      : did.some((a) => a.status === 'approval')
        ? 'approval'
        : req.status === 'in-flight' || tools.some((t) => t.status === 'running')
          ? 'running'
          : req.status === 'interrupted'
            ? 'interrupted'
            : 'ok';
  let durationMs: number | null = null;
  if (req.startedAt && !startUnknown(req)) {
    const ends = [req.endedAt, ...tools.map((t) => t.endedAt)]
      .filter((e): e is string => !!e)
      .map((e) => Date.parse(e));
    const end =
      outcome === 'running' || outcome === 'approval'
        ? now
        : ends.length
          ? Math.max(...ends)
          : null;
    if (end !== null) durationMs = Math.max(0, end - Date.parse(req.startedAt));
  }

  return {
    requestId: req.id,
    index: req.index,
    category: dominant(did),
    startedAt: req.startedAt,
    durationMs,
    tokens: req.usage ? totalTokens(req.usage) : 0,
    thought: {
      text: texts.length ? texts.join('\n\n') : null,
      durationMs: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
      tokens: req.usage?.thinking ?? 0,
      hidden: thinking.length > 0 && texts.length === 0,
    },
    said: said || null,
    did,
    outcome,
    error: req.error?.message ?? null,
  };
}

export function buildSteps(
  open: OpenSession,
  agentId: string,
  turnId: string,
  now: number,
  approvals?: Approvals,
): Phase[] {
  const turn = findTurn(open, agentId, turnId);
  if (!turn) return [];
  const phases: Phase[] = [];
  for (const req of requestsOf(open, turn)) {
    const step = stepOf(req, toolsOf(open, req), now, approvals);
    const last = phases.at(-1);
    const phase =
      last && last.category === step.category
        ? last
        : phases[
            phases.push({
              category: step.category,
              steps: [],
              startedAt: step.startedAt,
              durationMs: null,
              tokens: 0,
            }) - 1
          ];
    if (!phase) continue;
    phase.steps.push(step);
    if (step.durationMs !== null) phase.durationMs = (phase.durationMs ?? 0) + step.durationMs;
    phase.tokens += step.tokens;
  }
  return phases;
}

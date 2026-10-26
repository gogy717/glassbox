/** A prompt as Markdown, for "Copy as Markdown": what was asked, the answer, and what was done. */
import type { Turn } from '../../../../src/core/model.js';
import type { OpenSession } from '../../data/store';
import type { T } from '../../i18n';
import { formatDuration } from '../../lib/format';
import { summarizeInput } from '../../lib/tool-category';
import { requestsOf, toolsOf } from './flow-model';

/**
 * The prompt as a quote; its final reply as written (the text of its last call, once that call
 * has ended without running a tool, as the Final reply pill has it); then a line a call: "-
 * `Bash` git status · 1.2s", a sub-agent as itself ("- Agent `general-purpose` · 12 calls").
 * Each call as its card summarizes it, so no path the page does not show: a file is its name.
 */
export function turnMarkdown(open: OpenSession, turn: Turn, t: T): string {
  const quote = turn.prompt
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  const calls = requestsOf(open, turn);
  const last = calls.at(-1);
  const reply =
    last && last.status !== 'in-flight' && toolsOf(open, last).length === 0
      ? last.blocks
          .flatMap((b) => (b.kind === 'text' ? [b.text] : []))
          .join('\n\n')
          .trim()
      : '';
  const tools = calls
    .flatMap((r) => toolsOf(open, r))
    .map((tool) => {
      const agent =
        tool.spawned?.kind === 'agent' ? open.agents.get(tool.spawned.agentId) : undefined;
      if (agent)
        return `- ${t('flow.mdAgent', { type: agent.agentType ?? agent.label, n: agent.counts.requests })}`;
      const summary = summarizeInput(tool);
      const time = tool.durationMs === null ? '' : ` · ${formatDuration(tool.durationMs)}`;
      return `- \`${tool.name}\`${summary ? ` ${summary}` : ''}${time}`;
    });
  return [quote, reply, tools.join('\n')].filter(Boolean).join('\n\n');
}

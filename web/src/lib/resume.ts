/** How to pick a session up again in its own CLI, as a line to paste into a terminal. */
import type { AgentKind, SessionSummary } from '../../../src/core/model.js';

/**
 * Each CLI's own command for one of its sessions, by the id glassbox reads it under, as the CLI
 * prints it when a session ends or documents it in its help: Claude Code's "resume with: claude
 * --resume <id>", Codex's "To continue this session, run: codex resume <id>", Grok's `--resume
 * <ID>`, OpenCode's "Continue  opencode -s <id>". None for a CLI glassbox has not seen say its
 * own (oh-my-pi): better no command than a wrong one.
 */
const COMMANDS: Partial<Record<AgentKind, (id: string) => string>> = {
  'claude-code': (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  grok: (id) => `grok --resume ${id}`,
  opencode: (id) => `opencode -s ${id}`,
};

/** `s` as one word of a POSIX shell: as it is when nothing in it is special, else quoted whole. */
export const shellQuote = (s: string): string =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The line that resumes `s` in its CLI, from its directory: Claude Code finds a session only from
 * the directory it ran in, and the others then work where it did. Null when glassbox does not
 * know the CLI's command.
 */
export function resumeCommand(
  s: Pick<SessionSummary, 'agent' | 'nativeId' | 'cwd'>,
): string | null {
  const command = COMMANDS[s.agent];
  if (!command) return null;
  const run = command(shellQuote(s.nativeId));
  return s.cwd ? `cd ${shellQuote(s.cwd)} && ${run}` : run;
}

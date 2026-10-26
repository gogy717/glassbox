/** What the palette (⌘K) lists besides its actions: sessions, the open session's prompts, pages. */
import { MAIN_AGENT_ID, type SessionSummary, type Turn } from '../../../src/core/model.js';
import type { PaletteItem } from '../components/Palette';
import type { OpenSession } from '../data/store';
import type { T } from '../i18n';
import { agentName } from '../lib/agent-names';
import { isListed } from '../lib/sessions';
import { TABS, type Tab } from '../router';
import { isLocalCommand, truncatePrompt } from './flow/flow-model';

/** Those that need you first, then the running ones, then the most recently active. */
const urgency = (s: SessionSummary) => (s.live === 'waiting' ? 0 : s.live === 'busy' ? 1 : 2);

/** The sessions listed, as Home's rows name them ("project / title"), with their state's dot. */
export function sessionItems(
  sessions: readonly SessionSummary[],
  showProbes: boolean,
  t: T,
  open: (sessionId: string) => void,
): PaletteItem[] {
  return sessions
    .filter((s) => isListed(s, showProbes))
    .sort((a, b) => urgency(a) - urgency(b) || b.updatedAt.localeCompare(a.updatedAt))
    .map((s) => {
      const title = s.title ?? t('sidebar.untitled');
      return {
        id: `session:${s.id}`,
        kind: 'session',
        label: s.project ? `${s.project} / ${title}` : title,
        keywords: agentName(s.agent),
        live: s.live,
        run: () => open(s.id),
      };
    });
}

/** What a turn asked, as the prompt list says it. */
function asked(turn: Turn, t: T): string {
  if (turn.origin === 'task-notification') return t('flow.taskNotification');
  if (turn.origin === 'auto-continuation') return t('flow.autoContinuation');
  return turn.prompt.trim();
}

/**
 * The open session's prompts to its main agent, newest first, worded as its prompt list words
 * them ("Prompt 12 · Run the tests…"), found by all they asked. Local commands, which the list
 * does not number, are left out.
 */
export function promptItems(
  open: OpenSession | null,
  t: T,
  select: (turnId: string) => void,
): PaletteItem[] {
  if (!open) return [];
  return [...open.turns.values()]
    .filter(
      (turn) =>
        turn.agentId === MAIN_AGENT_ID &&
        !isLocalCommand(
          turn,
          turn.requestIds.length,
          turn.status === 'running' ? 'running' : 'complete',
          open.session.agent,
        ),
    )
    .sort((a, b) => b.index - a.index)
    .map((turn) => {
      const words = asked(turn, t);
      return {
        id: `prompt:${turn.id}`,
        kind: 'prompt',
        label: t('palette.prompt', { n: turn.index, text: truncatePrompt(words) }),
        keywords: words.slice(0, 2_000),
        run: () => select(turn.id),
      };
    });
}

/**
 * Home, Stats, the Inbox and Rules, then the session page's tabs when there is a session to show
 * them (`tab`).
 */
export function pageItems(
  t: T,
  go: {
    home(): void;
    stats(): void;
    inbox(): void;
    rules(): void;
    tab: ((tab: Tab) => void) | null;
  },
): PaletteItem[] {
  const pages: PaletteItem[] = [
    { id: 'page:home', kind: 'page', label: t('nav.home'), run: go.home },
    { id: 'page:stats', kind: 'page', label: t('nav.stats'), run: go.stats },
    { id: 'page:inbox', kind: 'page', label: t('nav.inbox'), run: go.inbox },
    { id: 'page:rules', kind: 'page', label: t('nav.rules'), run: go.rules },
  ];
  const { tab } = go;
  if (!tab) return pages;
  return [
    ...pages,
    ...TABS.map(
      (x): PaletteItem => ({
        id: `tab:${x}`,
        kind: 'tab',
        label: t(`tab.${x}`),
        run: () => tab(x),
      }),
    ),
  ];
}

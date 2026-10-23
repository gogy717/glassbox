/** The agent behind the open session, for text such as "Grok wants to use Bash". */
import { createContext, useContext } from 'react';
import type { AgentKind } from '../../../src/core/model.js';
import { agentName } from '../lib/agent-names';

export const SessionAgentContext = createContext<AgentKind>('claude-code');

export const useSessionAgentKind = () => useContext(SessionAgentContext);

/** Its display name, e.g. "Claude Code". */
export const useSessionAgent = () => agentName(useContext(SessionAgentContext));

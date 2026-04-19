'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useAgentStream } from './use-agent-stream';

type AgentStreamReturn = ReturnType<typeof useAgentStream>;

const AgentStreamContext = createContext<AgentStreamReturn | null>(null);

interface AgentStreamProviderProps {
  projectSlug: string;
  children: ReactNode;
}

/** Wraps useAgentStream in a context so the WS connection and state
 *  survive navigation between project sub-pages (Issues, Board, Agent). */
export function AgentStreamProvider({ projectSlug, children }: AgentStreamProviderProps) {
  const stream = useAgentStream({ projectSlug });
  return (
    <AgentStreamContext.Provider value={stream}>
      {children}
    </AgentStreamContext.Provider>
  );
}

export function useAgentStreamContext(): AgentStreamReturn {
  const ctx = useContext(AgentStreamContext);
  if (!ctx) throw new Error('useAgentStreamContext must be used within AgentStreamProvider');
  return ctx;
}

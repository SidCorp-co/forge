import { createContext, useContext, type ReactNode } from 'react';
import { useAgentStream } from './use-agent-stream';

type AgentStreamReturn = ReturnType<typeof useAgentStream>;

const AgentStreamContext = createContext<AgentStreamReturn | null>(null);

interface AgentStreamProviderProps {
  projectSlug: string;
  children: ReactNode;
}

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

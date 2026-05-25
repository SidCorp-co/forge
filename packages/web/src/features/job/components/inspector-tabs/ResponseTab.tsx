'use client';

import { useAgentSession } from '@/features/agent/hooks/use-agents';
import { EmptyState } from './EmptyState';

interface ResponseTabProps {
  agentSessionId: string | null | undefined;
}

interface AgentMessageLite {
  role?: string;
  content?: string;
  ts?: string;
}

export function ResponseTab({ agentSessionId }: ResponseTabProps) {
  const sessionQuery = useAgentSession(agentSessionId ?? null);

  if (!agentSessionId) {
    return (
      <EmptyState
        title="No agent session attached"
        body="This job's runner did not register an agent session."
      />
    );
  }

  if (sessionQuery.isLoading) {
    return <div className="px-4 py-6 text-xs text-on-surface-variant">Loading messages…</div>;
  }

  if (sessionQuery.isError) {
    return (
      <EmptyState
        title="Failed to load session"
        body={sessionQuery.error instanceof Error ? sessionQuery.error.message : 'Unknown error'}
      />
    );
  }

  const messages = (sessionQuery.data?.messages ?? []) as AgentMessageLite[];
  const assistantMessages = messages.filter((m) => m.role === 'assistant');

  if (assistantMessages.length === 0) {
    return (
      <EmptyState
        title="No assistant turns"
        body="The agent session has not produced any assistant messages yet."
      />
    );
  }

  return (
    <ol className="space-y-3 px-4 py-3">
      {assistantMessages.map((m, i) => (
        <li
          key={i}
          className="rounded-sm border border-outline-variant/20 bg-surface-container-low p-3"
        >
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-widest text-outline">
            <span>assistant</span>
            {m.ts && <time dateTime={m.ts}>{new Date(m.ts).toLocaleString()}</time>}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-on-surface">
            {m.content ?? ''}
          </pre>
        </li>
      ))}
    </ol>
  );
}

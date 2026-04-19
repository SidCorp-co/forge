'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useCallback, useEffect } from 'react';
import { Monitor, MonitorOff } from 'lucide-react';
import { useProject } from '@/features/project/hooks/use-projects';
import { agentApi, type Agent } from '@/features/agent/api';
import { useAgents, useUpdateAgent, usePoSessions } from '@/features/agent/hooks/use-agents';
import { AgentCard } from '@/features/agent/components/agent-card';
import { useAgentRunLog } from '@/features/agent/hooks/use-agent-run-log';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { useToast } from '@/hooks/use-toast';
import { ToastContainer } from '@/components/ui/toast-container';

export default function AgentsPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { data, isLoading } = useProject(slug);
  const project = data?.data;
  const { desktopConnected } = useAgentStreamContext();
  const { toasts, addToast } = useToast();

  const { data: agents = [], isLoading: agentsLoading } = useAgents(slug);
  const updateAgent = useUpdateAgent(slug);
  const { data: recentSessions = [] } = usePoSessions(slug);

  const [poLoading, setPoLoading] = useState<'review' | 'reindex' | null>(null);
  const runLog = useAgentRunLog();

  // Clear loading spinner when run finishes
  useEffect(() => {
    if (!runLog.isRunning && poLoading) setPoLoading(null);
  }, [runLog.isRunning, poLoading]);

  const handleSaveConfig = useCallback(async (id: string, data: Partial<Agent>) => {
    updateAgent.mutate({ id, data }, {
      onSuccess: () => addToast('Configuration saved'),
      onError: () => addToast('Failed to save configuration'),
    });
  }, [updateAgent, addToast]);

  const handlePoAction = useCallback(async (action: 'review' | 'reindex', agentType?: string, agentDocumentId?: string) => {
    setPoLoading(action);
    const label = action === 'review' ? 'Running review...' : 'Refreshing knowledge...';
    runLog.startRun('', label, agentDocumentId ?? ''); // clear log, show status
    try {
      if (!agentType) throw new Error('Agent type is required');
      const type = agentType;
      const res = action === 'review'
        ? await agentApi.startAgentReview(slug, type)
        : await agentApi.startAgentReindex(slug, type);
      runLog.startRun(res.data.documentId, label, agentDocumentId ?? ''); // subscribe to actual session
    } catch {
      addToast(`Agent ${action} failed`);
      runLog.clear();
      setPoLoading(null);
    }
  }, [slug, addToast, runLog]);

  if (isLoading || agentsLoading) return <p className="text-sm text-primary-fixed">Loading...</p>;
  if (!project) return <p className="text-sm text-primary-fixed">Project not found.</p>;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h2 className="mb-1 text-xl font-bold text-on-surface">Agents</h2>
        <p className="text-sm text-primary-fixed">AI agents that automate project workflows.</p>
      </div>

      {/* Desktop status */}
      <div className="mb-6 flex items-center gap-2 text-sm">
        {desktopConnected ? (
          <>
            <Monitor className="h-4 w-4 text-success" />
            <span className="text-success">Desktop connected</span>
          </>
        ) : (
          <>
            <MonitorOff className="h-4 w-4 text-outline" />
            <span className="text-primary-fixed">Desktop offline — agents require the desktop app</span>
          </>
        )}
      </div>

      {agents.map((agent) => (
        <AgentCard
          key={agent.documentId}
          agent={agent}
          slug={slug}
          desktopConnected={desktopConnected}
          recentSessions={recentSessions}
          onSave={handleSaveConfig}
          onPoAction={handlePoAction}
          onSessionClick={(id) => router.push(`/projects/${slug}/agent?session=${id}`)}
          poLoading={poLoading}
          saving={updateAgent.isPending}
          runLog={runLog}
        />
      ))}

      <ToastContainer toasts={toasts} />
    </div>
  );
}

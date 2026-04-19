'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils/cn';
import type { Agent, AgentSessionSummary } from '../../api';
import type { AgentRunLog } from '../../hooks/use-agent-run-log';
import { AgentActions } from './agent-actions';
import { AgentConfigPanel } from './agent-config-panel';
import { AgentRunLog as AgentRunLogPanel } from './agent-run-log';
import { AgentRecentSessions } from './agent-recent-sessions';

interface AgentCardProps {
  agent: Agent;
  slug: string;
  desktopConnected: boolean;
  recentSessions: AgentSessionSummary[];
  onSave: (id: string, data: Partial<Agent>) => Promise<void>;
  onPoAction: (action: 'review' | 'reindex', agentType?: string, agentDocumentId?: string) => void;
  onSessionClick: (sessionId: string) => void;
  poLoading: 'review' | 'reindex' | null;
  saving: boolean;
  runLog?: AgentRunLog;
}

export function AgentCard({
  agent,
  slug,
  desktopConnected,
  recentSessions,
  onSave,
  onPoAction,
  onSessionClick,
  poLoading,
  saving,
  runLog,
}: AgentCardProps) {
  const [showConfig, setShowConfig] = useState(false);
  const [draft, setDraft] = useState<Partial<Agent>>({});

  const openConfig = useCallback(() => {
    setShowConfig(true);
    setDraft({
      enabled: agent.enabled,
      focusAreas: [...agent.focusAreas],
      customInstructions: agent.customInstructions || '',
      schedule: agent.schedule,
      approvalMode: agent.approvalMode,
      maxProposals: agent.maxProposals,
      promptTemplate: agent.promptTemplate || '',
      reindexPromptTemplate: agent.reindexPromptTemplate || '',
    });
  }, [agent]);

  const handleSave = useCallback(async () => {
    await onSave(agent.documentId, draft);
    setShowConfig(false);
  }, [agent.documentId, draft, onSave]);

  const hasReviewPrompt = agent.promptTemplate || agent.definition?.promptTemplate;
  const hasReindexPrompt = agent.reindexPromptTemplate || agent.definition?.reindexPromptTemplate;

  const showRunLog =
    runLog &&
    runLog.activeAgentId === agent.documentId &&
    (runLog.status || runLog.log.length > 0);

  return (
    <div className="mb-4 rounded-lg border border-outline-variant/30 bg-surface-container-low">
      <div className="flex items-start justify-between p-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-on-surface">{agent.name}</h3>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                agent.enabled
                  ? 'bg-success-surface text-success'
                  : 'bg-surface-container-high text-primary-fixed',
              )}
            >
              {agent.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <span className="rounded-full bg-surface-variant px-2 py-0.5 text-[10px] font-medium text-tertiary">
              {agent.type}
            </span>
          </div>
          <p className="mt-1 text-sm text-primary-fixed">
            {agent.definition?.description || agent.type}
          </p>
        </div>
      </div>

      <AgentActions
        hasReviewPrompt={!!hasReviewPrompt}
        hasReindexPrompt={!!hasReindexPrompt}
        desktopConnected={desktopConnected}
        agentEnabled={agent.enabled}
        poLoading={poLoading}
        showConfig={showConfig}
        onReview={() => onPoAction('review', agent.type, agent.documentId)}
        onReindex={() => onPoAction('reindex', agent.type, agent.documentId)}
        onToggleConfig={() => (showConfig ? setShowConfig(false) : openConfig())}
      />

      {showRunLog && <AgentRunLogPanel runLog={runLog} />}

      {showConfig && (
        <AgentConfigPanel
          agent={agent}
          draft={draft}
          saving={saving}
          onDraftChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
          onSave={handleSave}
        />
      )}

      <AgentRecentSessions sessions={recentSessions} onSessionClick={onSessionClick} />
    </div>
  );
}

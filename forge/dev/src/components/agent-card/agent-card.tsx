import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateAgent } from "@/lib/api";
import type { Agent } from "@/lib/types";
import { StatusBadge } from "@/components/ui";
import { useAgentRun } from "./hooks";
import { AgentActions } from "./agent-actions";
import { AgentRunLog } from "./agent-run-log";
import { AgentConfigPanel } from "./agent-config-panel";

interface AgentCardProps {
  agent: Agent;
  slug: string;
}

export function AgentCard({ agent, slug }: AgentCardProps) {
  const queryClient = useQueryClient();
  const [showConfig, setShowConfig] = useState(false);
  const [draft, setDraft] = useState<Partial<Agent>>({});

  const { poLoading, runStatus, runLog, logEndRef, handlePoAction } = useAgentRun({ agent, slug });

  const mutation = useMutation({
    mutationFn: (data: Partial<Agent>) => updateAgent(agent.documentId, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents", slug] }),
  });

  const openConfig = useCallback(() => {
    setShowConfig(true);
    setDraft({
      enabled: agent.enabled,
      focusAreas: [...agent.focusAreas],
      customInstructions: agent.customInstructions || "",
      schedule: agent.schedule,
      approvalMode: agent.approvalMode,
      maxProposals: agent.maxProposals,
      promptTemplate: agent.promptTemplate || "",
      reindexPromptTemplate: agent.reindexPromptTemplate || "",
    });
  }, [agent]);

  const handleSave = useCallback(() => {
    mutation.mutate(draft, { onSuccess: () => setShowConfig(false) });
  }, [draft, mutation]);

  const hasReviewPrompt = !!(agent.promptTemplate || agent.definition?.promptTemplate);
  const hasReindexPrompt = !!(agent.reindexPromptTemplate || agent.definition?.reindexPromptTemplate);

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white">
      <div className="flex items-start justify-between p-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-gray-900">{agent.name}</h3>
            <StatusBadge status={agent.enabled ? "enabled" : "disabled"} />
            <span className="rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-medium text-purple-600">
              {agent.type}
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {agent.definition?.description || agent.type}
          </p>
        </div>
      </div>

      <AgentActions
        hasReviewPrompt={hasReviewPrompt}
        hasReindexPrompt={hasReindexPrompt}
        enabled={agent.enabled}
        poLoading={poLoading}
        showConfig={showConfig}
        onPoAction={handlePoAction}
        onToggleConfig={() => (showConfig ? setShowConfig(false) : openConfig())}
      />

      <AgentRunLog
        runStatus={runStatus}
        runLog={runLog}
        poLoading={poLoading}
        logEndRef={logEndRef}
      />

      {showConfig && (
        <AgentConfigPanel
          agent={agent}
          draft={draft}
          isSaving={mutation.isPending}
          onDraftChange={setDraft}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

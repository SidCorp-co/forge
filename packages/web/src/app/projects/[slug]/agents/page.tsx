'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus, Settings2, Trash2 } from 'lucide-react';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import {
  useAgents,
  useCreateAgent,
  useUpdateAgent,
  useDeleteAgent,
} from '@/features/agent/hooks/use-agents';
import { AgentConfigPanel } from '@/features/agent/components/agent-card/agent-config-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { formatApiError } from '@/lib/api/error';
import { cn } from '@/lib/utils/cn';
import type { Agent } from '@/features/agent/api';

export default function AgentsPage() {
  useSetPageTitle('Agents');
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  const { data: agents, isLoading, error } = useAgents(projectId);
  const createAgent = useCreateAgent(projectId);
  const updateAgent = useUpdateAgent(projectId);
  const deleteAgent = useDeleteAgent(projectId);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('');
  const [configOpenId, setConfigOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<Agent>>>({});

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !newName.trim() || !newType.trim()) return;
    createAgent.mutate(
      { name: newName.trim(), type: newType.trim(), enabled: false },
      {
        onSuccess: () => {
          setNewName('');
          setNewType('');
          setCreating(false);
        },
      },
    );
  }

  function openConfig(agent: Agent) {
    setConfigOpenId(agent.documentId);
    setDrafts((prev) => ({
      ...prev,
      [agent.documentId]: {
        enabled: agent.enabled,
        focusAreas: [...agent.focusAreas],
        customInstructions: agent.customInstructions ?? '',
        schedule: agent.schedule,
        approvalMode: agent.approvalMode,
        maxProposals: agent.maxProposals,
        promptTemplate: agent.promptTemplate ?? '',
        reindexPromptTemplate: agent.reindexPromptTemplate ?? '',
      },
    }));
  }

  async function handleSave(agent: Agent) {
    const draft = drafts[agent.documentId];
    if (!draft) return;
    await updateAgent.mutateAsync({ id: agent.documentId, data: draft });
    setConfigOpenId(null);
  }

  function handleDelete(agent: Agent) {
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    deleteAgent.mutate(agent.documentId);
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">Agents</h1>
          <p className="text-sm text-primary-fixed">
            Project agent definitions — review, reindex, and pipeline automation.
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={!projectId}
            className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/30 bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:bg-primary/90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            New agent
          </button>
        )}
      </div>

      {creating && projectId && (
        <form
          onSubmit={handleCreate}
          className="space-y-3 rounded-sm border border-primary/30 bg-surface-container-low p-4"
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Agent name"
              className="rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
              required
            />
            <input
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              placeholder="Agent type (e.g. PO, QA, dev)"
              className="rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
              required
            />
          </div>
          {createAgent.error && (
            <p className="text-[10px] uppercase tracking-widest text-error">
              {formatApiError(createAgent.error)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded px-3 py-1.5 text-xs text-primary-fixed hover:bg-surface-container-high"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createAgent.isPending}
              className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary hover:bg-primary/90 disabled:opacity-50"
            >
              {createAgent.isPending ? 'Creating…' : 'Create agent'}
            </button>
          </div>
        </form>
      )}

      {!projectId ? (
        <p className="text-sm text-primary-fixed">Loading project…</p>
      ) : isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : error ? (
        <p className="text-[10px] uppercase tracking-widest text-error">
          {formatApiError(error)}
        </p>
      ) : !agents || agents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-outline-variant/30 px-4 py-12 text-center">
          <p className="text-sm text-primary-fixed">No agents yet.</p>
          <p className="mt-1 text-xs text-outline">
            Create an agent to schedule reviews or run pipeline automation.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {agents.map((agent) => {
            const open = configOpenId === agent.documentId;
            return (
              <div
                key={agent.documentId}
                className="rounded-lg border border-outline-variant/30 bg-surface-container-low"
              >
                <div className="flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-on-surface">
                        {agent.name}
                      </h3>
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
                      <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-medium text-primary-fixed">
                        Schedule: {agent.schedule}
                      </span>
                    </div>
                    {agent.customInstructions && (
                      <p className="mt-2 line-clamp-2 text-xs text-outline">
                        {agent.customInstructions}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => (open ? setConfigOpenId(null) : openConfig(agent))}
                      className="inline-flex items-center gap-1 rounded border border-outline-variant/30 bg-surface px-2.5 py-1 text-[11px] text-on-surface hover:bg-surface-container"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      Configure
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(agent)}
                      className="rounded p-1.5 text-outline hover:bg-danger-surface hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {open && drafts[agent.documentId] && (
                  <>
                    <AgentConfigPanel
                      agent={agent}
                      draft={drafts[agent.documentId]!}
                      saving={updateAgent.isPending}
                      onDraftChange={(patch) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [agent.documentId]: {
                            ...prev[agent.documentId],
                            ...patch,
                          },
                        }))
                      }
                      onSave={() => handleSave(agent)}
                    />
                    {updateAgent.error && (
                      <p className="px-5 pb-3 text-[10px] uppercase tracking-widest text-error">
                        {formatApiError(updateAgent.error)}
                      </p>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

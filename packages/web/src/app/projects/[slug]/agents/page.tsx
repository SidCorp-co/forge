'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Monitor, MonitorOff, Plus, Search, Trash2 } from 'lucide-react';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import {
  useAgents,
  useAgentSessions,
  useCreateAgent,
  useUpdateAgent,
  useDeleteAgent,
} from '@/features/agent/hooks/use-agents';
import { useAgentRunLog } from '@/features/agent/hooks/use-agent-run-log';
import { agentApi, type Agent, type AgentSessionSummary } from '@/features/agent/api';
import { AgentCard } from '@/features/agent/components/agent-card/agent-card';
import { Skeleton } from '@/components/ui/skeleton';
import { ToastContainer } from '@/components/ui/toast-container';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useToast } from '@/hooks/use-toast';
import { formatApiError } from '@/lib/api/error';

const PO_ACTION_COOLDOWN_MS = 3000;
const RECENT_SESSIONS_PER_AGENT = 5;

export default function AgentsPage() {
  useSetPageTitle('Agents');
  const router = useRouter();
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  const { data: agents, isLoading, error } = useAgents(projectId);
  const { data: sessions } = useAgentSessions(projectId);
  const createAgent = useCreateAgent(projectId);
  const updateAgent = useUpdateAgent(projectId);
  const deleteAgent = useDeleteAgent(projectId);
  const runLog = useAgentRunLog(projectId);
  const { toasts, addToast } = useToast();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [desktopConnected, setDesktopConnected] = useState(false);
  const [poLoading, setPoLoading] = useState<{
    action: 'review' | 'reindex';
    agentId: string;
  } | null>(null);
  const lastActionAtRef = useRef<number>(0);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    agentApi
      .desktopStatus({ projectSlug: slug })
      .then((res) => {
        if (!cancelled) setDesktopConnected(res?.data?.connected ?? false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const sessionsByAgent = useMemo(() => {
    const map = new Map<string, AgentSessionSummary[]>();
    if (!agents || !sessions) return map;
    for (const agent of agents) {
      const matches = sessions
        .filter((s) => {
          const metaType = (s.metadata as { type?: string } | null)?.type;
          if (metaType) return metaType === agent.type || metaType === `${agent.type}-reindex`;
          // Fallback for older rows without metadata.type — match by title prefix.
          const prefix = agent.type.toUpperCase();
          return s.title.startsWith(`${prefix} `) || s.title.startsWith(prefix);
        })
        .slice(0, RECENT_SESSIONS_PER_AGENT);
      map.set(agent.documentId, matches);
    }
    return map;
  }, [agents, sessions]);

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => a.name.toLowerCase().includes(q));
  }, [agents, searchQuery]);

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
          addToast('Agent created');
        },
        onError: (err) => {
          addToast(`Create failed: ${formatApiError(err)}`);
        },
      },
    );
  }

  async function handleSave(id: string, data: Partial<Agent>): Promise<void> {
    try {
      await updateAgent.mutateAsync({ id, data });
      addToast('Configuration saved');
    } catch (err) {
      addToast(`Save failed: ${formatApiError(err)}`);
    }
  }

  function handleDelete(agent: Agent) {
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    deleteAgent.mutate(agent.documentId, {
      onError: (err) => addToast(`Delete failed: ${formatApiError(err)}`),
    });
  }

  async function handlePoAction(
    action: 'review' | 'reindex',
    agentType: string | undefined,
    agentDocumentId: string | undefined,
  ) {
    if (!agentType || !agentDocumentId || !slug) return;
    const now = Date.now();
    if (now - lastActionAtRef.current < PO_ACTION_COOLDOWN_MS) {
      addToast('Slow down — try again in a moment');
      return;
    }
    lastActionAtRef.current = now;
    setPoLoading({ action, agentId: agentDocumentId });
    try {
      const res =
        action === 'review'
          ? await agentApi.startAgentReview(slug, agentType)
          : await agentApi.startAgentReindex(slug, agentType);
      const sessionDocId = res?.data?.documentId;
      if (sessionDocId) {
        const label = action === 'review' ? 'Running review…' : 'Reindexing knowledge…';
        runLog.startRun(sessionDocId, label, agentDocumentId);
      } else {
        addToast(`${action === 'review' ? 'Review' : 'Reindex'} dispatched`);
      }
    } catch (err) {
      addToast(`${action === 'review' ? 'Review' : 'Reindex'} failed: ${formatApiError(err)}`);
    } finally {
      setPoLoading(null);
    }
  }

  function handleSessionClick(sessionId: string) {
    router.push(`/projects/${slug}/agent?session=${sessionId}`);
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">Agents</h1>
          <p className="text-sm text-primary-fixed">
            Project agent definitions — review, reindex, and pipeline automation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/30 bg-surface-container-low px-2.5 py-1 text-xs">
            {desktopConnected ? (
              <>
                <Monitor className="h-3.5 w-3.5 text-success" />
                <span className="text-success">Desktop connected</span>
              </>
            ) : (
              <>
                <MonitorOff className="h-3.5 w-3.5 text-primary-fixed" />
                <span className="text-primary-fixed">No desktop connected</span>
              </>
            )}
          </span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-outline" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search agents…"
              className="w-48 rounded-sm border border-outline-variant/30 bg-surface py-1.5 pl-7 pr-2 text-xs text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary"
            />
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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : error ? (
        <p className="text-[10px] uppercase tracking-widest text-error">{formatApiError(error)}</p>
      ) : !agents || agents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-outline-variant/30 px-4 py-12 text-center">
          <p className="text-sm text-primary-fixed">No agents yet.</p>
          <p className="mt-1 text-xs text-outline">
            Create an agent to schedule reviews or run pipeline automation.
          </p>
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-outline-variant/30 px-4 py-12 text-center">
          <p className="text-sm text-primary-fixed">No agents match “{searchQuery}”.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredAgents.map((agent) => (
            <div key={agent.documentId} className="relative">
              <button
                type="button"
                onClick={() => handleDelete(agent)}
                aria-label={`Delete ${agent.name}`}
                className="absolute right-3 top-3 z-10 rounded p-1.5 text-outline hover:bg-danger-surface hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <AgentCard
                agent={agent}
                slug={slug}
                desktopConnected={desktopConnected}
                recentSessions={sessionsByAgent.get(agent.documentId) ?? []}
                onSave={handleSave}
                onPoAction={handlePoAction}
                onSessionClick={handleSessionClick}
                poLoading={
                  poLoading?.agentId === agent.documentId ? poLoading.action : null
                }
                saving={updateAgent.isPending}
                runLog={runLog}
              />
            </div>
          ))}
        </div>
      )}
      <ToastContainer toasts={toasts} />
    </div>
  );
}

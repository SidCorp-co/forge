'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/layout/shell';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useAuth } from '@/providers/auth-provider';
import { projectApi } from '@/features/project/api/project-api';
import type { AntigravityRunner } from '@/features/project/types';
import { CountdownTimer } from '@/app/projects/[slug]/settings/components/antigravity-sub-components';
import { Loader2, RefreshCw, Upload, CheckCircle2, XCircle, Plus, Trash2, Server, Activity, Download, Ban, Play, FolderOpen, AlertTriangle, ChevronDown, ChevronRight, Timer, PauseCircle } from 'lucide-react';
import Link from 'next/link';

interface ModelQuota {
  model: string;
  refreshLabel: string;
  segments: number[];
  remaining: number;
  status: 'full' | 'warning' | 'empty';
}

interface QuotaCache {
  models: ModelQuota[];
  fetchedAt: string;
  error: string | null;
  perRunner?: Record<string, { models: ModelQuota[]; fetchedAt: string; error: string | null }>;
}

function timeAgo(iso: string): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function ProjectList({ runner, onDeleteAgProject }: { runner: AntigravityRunner; onDeleteAgProject: (projectId: string) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const projects = runner.projects ?? [];
  const orphanCount = projects.filter((p) => !p.forgeProject).length;

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 cursor-pointer"
      >
        <span className={`text-[10px] font-bold uppercase tracking-widest ${
          runner.projectCount! >= (runner.maxProjects ?? 10)
            ? 'text-danger'
            : runner.projectCount! >= (runner.maxProjects ?? 10) - 2
              ? 'text-warning'
              : 'text-on-surface-variant'
        }`}>
          {runner.projectCount} / {runner.maxProjects ?? 10} PROJECTS
        </span>
        {runner.projectCount! >= (runner.maxProjects ?? 10) && (
          <span className="text-[9px] font-bold text-danger uppercase bg-danger-surface border border-danger/20 px-1.5 py-0.5 rounded-sm">LIMIT REACHED</span>
        )}
        {orphanCount > 0 && (
          <span className="text-[9px] font-bold text-warning uppercase bg-warning/10 border border-warning/20 px-1.5 py-0.5 rounded-sm flex items-center gap-1">
            <AlertTriangle className="h-2.5 w-2.5" />
            {orphanCount} ORPHANED
          </span>
        )}
        {projects.length > 0 && (
          collapsed ? <ChevronRight className="h-3 w-3 text-outline" /> : <ChevronDown className="h-3 w-3 text-outline" />
        )}
      </button>
      {!collapsed && projects.length > 0 && (
        <div className="space-y-1 pl-1">
          {projects.map((p) => (
            <div key={p.projectId} className="flex items-center gap-2 text-xs">
              {p.forgeProject ? (
                <>
                  <FolderOpen className="h-3 w-3 text-on-surface-variant shrink-0" />
                  <Link
                    href={`/projects/${p.forgeProject.slug}/settings`}
                    className="text-primary hover:underline truncate"
                  >
                    {p.forgeProject.name}
                  </Link>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3 w-3 text-warning shrink-0" />
                  <span className="font-mono text-warning truncate">{p.projectId}</span>
                  <span className="text-[9px] font-bold text-warning uppercase bg-warning/10 border border-warning/20 px-1.5 py-0.5 rounded-sm shrink-0">ORPHANED</span>
                  <button
                    onClick={async (e) => { e.stopPropagation(); setDeleting(p.projectId); await onDeleteAgProject(p.projectId); setDeleting(null); }}
                    disabled={deleting === p.projectId}
                    className="rounded p-0.5 text-outline hover:bg-danger-surface hover:text-danger disabled:opacity-50 shrink-0"
                    title="Delete orphaned AG project"
                  >
                    {deleting === p.projectId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


function RunnerCard({
  runner,
  onDelete,
  onHealthCheck,
  onRefreshQuota,
  onRename,
  onToggleExclude,
  onDeleteAgProject,
  onClearPause,
}: {
  runner: AntigravityRunner;
  onDelete: (id: string) => void;
  onHealthCheck: (id: string) => void;
  onRefreshQuota: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onToggleExclude: (id: string, exclude: boolean) => void;
  onDeleteAgProject: (projectId: string) => void;
  onClearPause: (id: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(runner.name);
  const [toggling, setToggling] = useState(false);

  const statusColor = runner.status === 'online' ? 'bg-success' : runner.status === 'error' ? 'bg-warning' : 'bg-surface-variant';
  const statusLabel = runner.status.toUpperCase();

  return (
    <div className={`border border-outline-variant/30 bg-surface p-5 space-y-3${runner.excluded ? ' opacity-60' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
          {editing ? (
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => { if (editName.trim() && editName !== runner.name) onRename(runner.documentId, editName.trim()); setEditing(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } else if (e.key === 'Escape') { setEditName(runner.name); setEditing(false); } }}
              className="text-sm font-bold text-primary bg-transparent border-0 border-b border-primary/30 py-0 px-0 focus:outline-none focus:border-primary w-40"
            />
          ) : (
            <span className="text-sm font-bold text-primary cursor-pointer hover:underline" onClick={() => setEditing(true)}>{runner.name}</span>
          )}
          <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">{statusLabel}</span>
          {runner.excluded && (
            <span className="text-[9px] font-bold text-danger uppercase bg-danger-surface border border-danger/20 px-1.5 py-0.5 rounded-sm">EXCLUDED</span>
          )}
          {runner.disabledUntil && new Date(runner.disabledUntil).getTime() > Date.now() && (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold text-warning uppercase bg-warning-surface border border-warning/20 px-1.5 py-0.5 rounded-sm">
              <PauseCircle className="h-3 w-3" />
              PAUSED — resumes <CountdownTimer target={runner.disabledUntil} />
              <button
                onClick={() => onClearPause(runner.documentId)}
                className="ml-1 hover:text-on-surface"
                title="Clear pause"
              >
                <XCircle className="h-3 w-3" />
              </button>
            </span>
          )}
        </div>
        <button
          onClick={async () => { setDeleting(true); await onDelete(runner.documentId); setDeleting(false); }}
          disabled={deleting}
          className="rounded p-1.5 text-outline hover:bg-danger-surface hover:text-danger disabled:opacity-50"
          title="Delete Runner"
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </div>

      <div className="text-xs font-mono text-on-surface-variant truncate">
        {runner.agentId ? `Agent: ${runner.agentId}` : runner.endpoint || 'No agent ID'}
      </div>

      {/* Project list */}
      {runner.projectCount !== undefined && (
        <ProjectList runner={runner} onDeleteAgProject={onDeleteAgProject} />
      )}

      {runner.healthError && (
        <p className="text-xs text-danger">{runner.healthError}</p>
      )}

      <div className="flex items-center gap-2 text-[10px] text-outline">
        {runner.lastSeen && <span>Last seen: {timeAgo(runner.lastSeen)}</span>}
      </div>

      {/* Depleted models */}
      {runner.depletedModels && Object.entries(runner.depletedModels).some(([, t]) => new Date(t).getTime() > Date.now()) && (
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-outline-variant/20">
          {Object.entries(runner.depletedModels).map(([model, resetAt]) => {
            if (new Date(resetAt).getTime() <= Date.now()) return null;
            return (
              <span key={model} className="inline-flex items-center gap-1 rounded border border-warning/30 bg-warning-surface text-warning px-2 py-0.5 text-[10px]">
                <Timer className="h-3 w-3" />
                {model} — <CountdownTimer target={resetAt} />
              </span>
            );
          })}
          <button
            onClick={async () => { await projectApi.clearRunnerDepletedModels(runner.documentId); onRefreshQuota(runner.documentId); }}
            className="inline-flex items-center gap-1 rounded border border-outline-variant/20 px-2 py-0.5 text-[10px] text-on-surface-variant hover:bg-surface-container-low"
          >
            <XCircle className="h-3 w-3" /> Clear
          </button>
        </div>
      )}

      {/* Quota bars for this runner */}
      {runner.quota && runner.quota.models.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-outline-variant/20">
          {runner.quota.models.map((m) => {
            const barColor = m.status === 'full' ? 'bg-tertiary' : m.status === 'warning' ? 'bg-warning' : 'bg-outline-variant';
            return (
              <div key={m.model}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono font-bold text-on-surface-variant uppercase">{m.model}</span>
                  <div className="flex items-center gap-2">
                    {m.refreshLabel && <span className="text-[9px] font-mono text-outline">{m.refreshLabel}</span>}
                    {m.status === 'empty' && <span className="text-[9px] font-bold text-danger uppercase">DEPLETED</span>}
                  </div>
                </div>
                <div className="flex gap-1">
                  {m.segments.map((pct, i) => (
                    <div key={i} className="flex-1 h-1 rounded-sm bg-surface-container-low overflow-hidden">
                      <div className={`h-full rounded-sm ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={async () => { setChecking(true); await onHealthCheck(runner.documentId); setChecking(false); }}
          disabled={checking}
          className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50"
        >
          {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
          CHECK
        </button>
        <button
          onClick={async () => { setRefreshing(true); await onRefreshQuota(runner.documentId); setRefreshing(false); }}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded border border-outline-variant px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          QUOTA
        </button>
        <button
          onClick={async () => { setToggling(true); await onToggleExclude(runner.documentId, !runner.excluded); setToggling(false); }}
          disabled={toggling}
          className={`flex items-center gap-1.5 rounded border px-3 py-1 text-[10px] font-bold uppercase tracking-widest disabled:opacity-50 ${
            runner.excluded
              ? 'border-success/30 text-success hover:bg-success-surface'
              : 'border-danger/30 text-danger hover:bg-danger-surface'
          }`}
        >
          {toggling ? <Loader2 className="h-3 w-3 animate-spin" /> : runner.excluded ? <Play className="h-3 w-3" /> : <Ban className="h-3 w-3" />}
          {runner.excluded ? 'INCLUDE' : 'EXCLUDE'}
        </button>
      </div>
    </div>
  );
}

export default function AntigravityPage() {
  useSetPageTitle('Antigravity');
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !user?.isCEO) {
      router.replace('/dashboard');
    }
  }, [authLoading, user, router]);

  const [runners, setRunners] = useState<AntigravityRunner[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; results: Array<{ projectId: string; skillCount: number; error?: string }> } | null>(null);

  // Add runner form
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAgentId, setNewAgentId] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [syncingAgents, setSyncingAgents] = useState(false);

  const fetchRunners = useCallback(async () => {
    try {
      const res = await projectApi.getAntigravityRunners();
      setRunners(res.data);
    } catch {
      setRunners([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRunners();
  }, [fetchRunners]);

  const handleAddRunner = async () => {
    if (!newName.trim() || !newAgentId.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await projectApi.createAntigravityRunner({ name: newName.trim(), agentId: newAgentId.trim() });
      setNewName('');
      setNewAgentId('');
      setShowAdd(false);
      await fetchRunners();
    } catch (err: any) {
      setAddError(err.message || 'Failed to add runner');
    }
    setAdding(false);
  };

  const handleDelete = async (id: string) => {
    const confirmed = window.confirm('Delete this runner? It will be removed from all project pools.');
    if (!confirmed) return;
    try {
      await projectApi.deleteAntigravityRunner(id);
      await fetchRunners();
    } catch { /* ignore */ }
  };

  const handleRename = async (id: string, name: string) => {
    try {
      await projectApi.updateAntigravityRunner(id, { name });
      await fetchRunners();
    } catch { /* ignore */ }
  };

  const handleHealthCheck = async (id: string) => {
    try {
      await projectApi.antigravityRunnerHealthCheck(id);
      await fetchRunners();
    } catch { /* ignore */ }
  };

  const handleRefreshQuota = async (id: string) => {
    try {
      await projectApi.antigravityRunnerRefreshQuota(id);
      await fetchRunners();
    } catch { /* ignore */ }
  };

  const handleToggleExclude = async (id: string, exclude: boolean) => {
    try {
      if (exclude) {
        await projectApi.excludeAntigravityRunner(id);
      } else {
        await projectApi.includeAntigravityRunner(id);
      }
      await fetchRunners();
    } catch { /* ignore */ }
  };

  const handleDeleteAgProject = async (projectId: string) => {
    const confirmed = window.confirm(`Delete orphaned AG project ${projectId.slice(0, 8)}...?`);
    if (!confirmed) return;
    try {
      await projectApi.antigravityDeleteProject(projectId);
      await fetchRunners();
    } catch { /* ignore */ }
  };

  const handleSyncAgents = async () => {
    setSyncingAgents(true);
    try {
      await projectApi.antigravitySyncAgents();
      await fetchRunners();
    } catch { /* ignore */ }
    setSyncingAgents(false);
  };

  const handleSyncAllSkills = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await projectApi.antigravitySyncSkillsToAll();
      setSyncResult(res.data);
    } catch {
      setSyncResult({ ok: false, results: [{ projectId: '', skillCount: 0, error: 'Request failed' }] });
    }
    setSyncing(false);
  }, []);

  const onlineCount = runners.filter((r) => r.status === 'online').length;

  if (authLoading || !user?.isCEO) return null;

  return (
    <Shell>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
          <div className="flex items-center justify-between mb-8 border-b border-outline-variant/30 pb-4">
            <div>
              <h1 className="mb-1 text-xl font-bold sm:text-2xl text-primary tracking-tight">
                Antigravity
              </h1>
              <p className="text-[10px] uppercase font-mono tracking-widest text-outline mt-1">
                SERVER-SIDE AGENT EXECUTION RUNNERS <span className="text-outline/50">v2</span>
              </p>
            </div>
            {onlineCount > 0 && (
              <span className="inline-flex items-center gap-2 rounded-sm bg-success-surface border border-success/20 px-3 py-1.5 text-[10px] font-bold tracking-widest uppercase text-success">
                <span className="h-2 w-2 rounded-sm bg-success shadow-[0_0_8px_var(--color-success)]" />
                {onlineCount} ONLINE
              </span>
            )}
          </div>

          {/* Runner Cards */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">Runners</h3>
              <div className="flex items-center gap-2">
              <button
                onClick={handleSyncAgents}
                disabled={syncingAgents}
                className="flex items-center gap-1.5 rounded-sm border border-outline-variant/30 bg-surface px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all disabled:opacity-50"
              >
                {syncingAgents ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                SYNC AGENTS
              </button>
              <button
                onClick={() => setShowAdd(!showAdd)}
                className="flex items-center gap-1.5 rounded-sm border border-outline-variant/30 bg-surface px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all"
              >
                <Plus className="h-3 w-3" />
                ADD RUNNER
              </button>
              </div>
            </div>

            {showAdd && (
              <div className="border border-outline-variant/30 bg-surface-container-low p-4 mb-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Runner name (e.g. Runner 1)"
                    className="bg-transparent border-0 border-b border-outline/30 rounded-none py-2 text-sm text-on-surface font-mono placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0"
                  />
                  <input
                    type="text"
                    value={newAgentId}
                    onChange={(e) => setNewAgentId(e.target.value)}
                    placeholder="Agent ID (from proxy /agents)"
                    className="bg-transparent border-0 border-b border-outline/30 rounded-none py-2 text-sm text-on-surface font-mono placeholder:text-outline/40 focus:outline-none focus:border-b-primary focus:ring-0"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleAddRunner}
                    disabled={adding || !newName.trim() || !newAgentId.trim()}
                    className="flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-primary hover:bg-on-surface-variant disabled:opacity-50"
                  >
                    {adding && <Loader2 className="h-3 w-3 animate-spin" />}
                    REGISTER
                  </button>
                  <button
                    onClick={() => { setShowAdd(false); setAddError(null); }}
                    className="text-[10px] font-bold uppercase tracking-widest text-outline hover:text-on-surface"
                  >
                    CANCEL
                  </button>
                </div>
                {addError && <p className="text-xs text-danger">{addError}</p>}
              </div>
            )}

            {loading && (
              <div className="flex items-center justify-center gap-3 py-12">
                <Loader2 className="h-5 w-5 animate-spin text-outline-variant" />
                <span className="text-[10px] font-mono tracking-widest uppercase text-outline">LOADING_RUNNERS...</span>
              </div>
            )}

            {!loading && runners.length === 0 && (
              <div className="rounded-sm border border-outline-variant/20 bg-surface-container-low p-8 text-center">
                <Server className="mx-auto h-8 w-8 text-outline mb-4 opacity-50" />
                <p className="text-[12px] font-bold tracking-widest uppercase text-on-surface-variant">NO RUNNERS REGISTERED</p>
                <p className="text-[10px] font-mono tracking-widest text-outline mt-2 uppercase">
                  Add an Antigravity runner to get started.
                </p>
              </div>
            )}

            <div className="space-y-3">
              {runners.map((runner) => (
                <RunnerCard
                  key={runner.documentId}
                  runner={runner}
                  onDelete={handleDelete}
                  onHealthCheck={handleHealthCheck}
                  onRefreshQuota={handleRefreshQuota}
                  onRename={handleRename}
                  onToggleExclude={handleToggleExclude}
                  onDeleteAgProject={handleDeleteAgProject}
                  onClearPause={async (id) => { await projectApi.clearRunnerPause(id); fetchRunners(); }}
                />
              ))}
            </div>
          </section>

          {/* Sync Skills */}
          {runners.length > 0 && (
            <section className="rounded-sm border border-outline-variant/30 bg-surface overflow-hidden shadow-xl">
              <div className="flex items-center justify-between border-b border-outline-variant/30 bg-surface-container-low px-4 py-3 sm:px-6">
                <div>
                  <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">Sync Skills</h3>
                  <p className="text-[10px] font-mono tracking-widest text-outline-variant mt-1 uppercase">
                    PUSH LATEST SKILLS TO ALL ANTIGRAVITY PROJECTS
                  </p>
                </div>
                <button
                  onClick={handleSyncAllSkills}
                  disabled={syncing}
                  className="flex items-center gap-2 rounded-sm bg-primary border border-transparent px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-primary hover:bg-on-surface-variant disabled:opacity-50 transition-all shadow-sm"
                >
                  {syncing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Upload className="h-3 w-3" />
                  )}
                  SYNC ALL
                </button>
              </div>

              {syncResult && (
                <div className="px-4 py-4 sm:px-6 bg-background/50">
                  {syncResult.ok ? (
                    <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-success border border-success/20 bg-success-surface p-3 rounded-sm">
                      <CheckCircle2 className="h-4 w-4" />
                      <span>
                        SYNCED {syncResult.results.reduce((sum, r) => sum + r.skillCount, 0)} SKILLS TO {syncResult.results.length} PROJECT{syncResult.results.length !== 1 ? 'S' : ''}
                      </span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {syncResult.results.map((r, i) => (
                        <div key={i} className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest">
                          {r.error ? (
                            <div className="flex items-center gap-2 w-full border border-danger/20 bg-danger-surface p-2 rounded-sm">
                              <XCircle className="h-4 w-4 text-danger" />
                              <span className="text-danger">{r.error}</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 w-full border border-success/20 bg-success-surface p-2 rounded-sm">
                              <CheckCircle2 className="h-4 w-4 text-success" />
                              <span className="text-success">{r.skillCount} SKILLS SYNCED</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </Shell>
  );
}

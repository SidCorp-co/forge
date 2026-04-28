'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiClient } from '@/lib/api/client';
import { RefreshCw, Loader2, Trash2, Clock, AlertCircle, CheckCircle, XCircle, Activity, Zap, Database, Monitor, Server, Ban, RotateCcw, Pause, Play } from 'lucide-react';
import { getPokemonSprite, getPokemonChain, getPokemonName, PIPELINE_POKEMON, getActiveCountSprite } from '@/lib/constants/pipeline-pokemon';
import { PokemonSprite } from '@/components/ui/pokemon-sprite';
import { useProjects } from '@/features/project/hooks/use-projects';
import { type PipelineSession, STATUS_ICON, STATUS_CONFIG, timeAgo } from './pipeline-monitor-helpers';
import { QuotaCountdown } from './pipeline-monitor-quota-countdown';

// Forge/core flat shape returned by `GET /api/agent-sessions`.
interface CoreAgentSessionRow {
  id: string;
  projectId: string;
  title: string | null;
  status: PipelineSession['status'];
  createdAt: string;
  updatedAt: string;
  metadata: PipelineSession['metadata'];
}

export function PipelineMonitor() {
  const [sessions, setSessions] = useState<PipelineSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  // The global pipeline-pause control is not yet in packages/core. Default to
  // unpaused; togglePause is a no-op until the per-session pipeline-control
  // endpoint is consolidated into a global one.
  const paused = false;
  const pauseLoading = false;
  const togglePause = async () => {
    // TODO(pipeline-control): packages/core only exposes per-session
    // /:id/pipeline-control today. Wire a global pause endpoint or remove
    // this UI control. See pipeline-monitor rework follow-up.
  };

  // Hash projectId → enriched project info (joined client-side from
  // useProjects cache; replaces Strapi's populate[project][fields]).
  const { data: projectsList } = useProjects();
  const projectsById = useMemo(() => {
    const m = new Map<string, NonNullable<PipelineSession['project']>>();
    for (const p of projectsList ?? []) {
      m.set(p.id, { id: p.id, documentId: p.id, name: p.name, slug: p.slug });
    }
    return m;
  }, [projectsList]);

  const enrichSession = useCallback(
    (row: CoreAgentSessionRow): PipelineSession => ({
      id: row.id,
      documentId: row.id,
      title: row.title ?? '',
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      metadata: row.metadata,
      project: projectsById.get(row.projectId) ?? null,
      issues: [],
    }),
    [projectsById],
  );

  const fetchSessions = useCallback(async () => {
    try {
      const fetchOnce = async (status?: PipelineSession['status']) => {
        const params = new URLSearchParams({
          metadataType: 'pipeline',
          pageSize: '50',
        });
        if (status) params.set('status', status);
        return apiClient<CoreAgentSessionRow[]>(`/agent-sessions?${params.toString()}`);
      };

      // packages/core's status filter is single-valued; for the 'active' tab we
      // need queued + running, so issue two parallel fetches and merge by id.
      const rows = filter === 'active'
        ? (
            await Promise.all([fetchOnce('running'), fetchOnce('queued')])
          ).flat()
        : await fetchOnce();

      const dedupedById = Array.from(new Map(rows.map((r) => [r.id, r])).values());
      const enriched = dedupedById.map(enrichSession);

      // Sort: running first, then queued, then by createdAt desc.
      const statusOrder: Record<string, number> = { running: 0, queued: 1, failed: 2, completed: 3, idle: 4 };
      enriched.sort((a, b) => {
        const oa = statusOrder[a.status] ?? 9;
        const ob = statusOrder[b.status] ?? 9;
        if (oa !== ob) return oa - ob;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      setSessions(enriched);
    } catch (err) {
      console.error('Failed to fetch pipeline sessions:', err);
    } finally {
      setLoading(false);
    }
  }, [filter, enrichSession]);

  useEffect(() => {
    setLoading(true);
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => { fetchSessions(); }, 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchSessions]);

  const handleCancel = async (docId: string) => {
    setActionLoading(docId);
    try {
      await apiClient(`/agent-sessions/${docId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed' }),
      });
      await fetchSessions();
    } catch (err) {
      console.error('Failed to cancel session:', err);
    }
    setActionLoading(null);
  };

  const handleToggleNoResume = async (session: PipelineSession) => {
    setActionLoading(session.documentId);
    try {
      const current = session.metadata?.noResume ?? false;
      await apiClient(`/agent-sessions/${session.documentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ metadata: { ...session.metadata, noResume: !current } }),
      });
      await fetchSessions();
    } catch (err) {
      console.error('Failed to toggle noResume:', err);
    }
    setActionLoading(null);
  };

  const handleDelete = async (docId: string) => {
    if (!confirm('Delete this session?')) return;
    setActionLoading(docId);
    try {
      await apiClient(`/agent-sessions/${docId}`, { method: 'DELETE' });
      await fetchSessions();
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
    setActionLoading(null);
  };

  const queuedCount = sessions.filter(s => s.status === 'queued').length;
  const runningCount = sessions.filter(s => s.status === 'running').length;
  const completedCount = sessions.filter(s => s.status === 'completed').length;
  const failedCount = sessions.filter(s => s.status === 'failed').length;

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Hero Stats Header — sticky */}
      <div className="sticky top-0 z-10 bg-background px-4 sm:px-6 md:px-8 pt-3 sm:pt-4 md:pt-8 pb-3 sm:pb-4 md:pb-6 border-b border-outline-variant/20">
      <div className="flex items-center justify-between md:flex-col md:items-start lg:flex-row lg:items-end gap-2 md:gap-6">
        <div className="flex items-baseline gap-2 sm:gap-3 md:block md:space-y-2">
          <h1 className="flex items-center gap-2 sm:gap-3 md:gap-4 text-xl sm:text-2xl md:text-[3.5rem] font-black tracking-tighter leading-none text-primary">
            {(() => {
              const activeCount = runningCount + queuedCount;
              const { url, name } = getActiveCountSprite(activeCount);
              return (
                <img
                  src={url}
                  alt={name}
                  title={`${name} — ${activeCount} active`}
                  className="h-8 w-8 sm:h-10 sm:w-10 md:h-14 md:w-14 object-contain image-rendering-pixelated"
                />
              );
            })()}
            {runningCount + queuedCount}
            <span className="text-on-surface-variant text-xs sm:text-base md:text-xl font-normal tracking-tight">Active</span>
          </h1>
          <div className="hidden sm:flex items-center gap-3">
            <p className="flex text-on-surface-variant text-xs sm:text-sm items-center gap-2">
              {paused ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
                  Paused
                </>
              ) : runningCount > 0 ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                  Operational
                </>
              ) : runningCount === 0 && queuedCount === 0 ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-outline" />
                  Idle
                </>
              ) : null}
              <span className="text-outline">•</span>
              {runningCount} running, {queuedCount} queued
            </p>
            <button
              onClick={togglePause}
              disabled={pauseLoading}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-sm text-[10px] font-bold uppercase tracking-widest border transition-colors disabled:opacity-50 ${
                paused
                  ? 'border-success/50 text-success hover:bg-success/10'
                  : 'border-warning/50 text-warning hover:bg-warning/10'
              }`}
              title={paused ? 'Resume pipeline — dispatch queued sessions' : 'Pause pipeline — stop dispatching new sessions'}
            >
              {pauseLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : paused ? (
                <Play className="h-3 w-3" />
              ) : (
                <Pause className="h-3 w-3" />
              )}
              {paused ? 'Resume' : 'Pause'}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 sm:gap-4 md:grid md:grid-cols-3 md:gap-8 text-right">
          {/* Mobile pause button */}
          <button
            onClick={togglePause}
            disabled={pauseLoading}
            className={`sm:hidden p-2 rounded-sm border transition-colors disabled:opacity-50 ${
              paused
                ? 'border-success/50 text-success'
                : 'border-warning/50 text-warning'
            }`}
          >
            {pauseLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </button>
          <div className="flex items-center gap-1.5 md:block">
            <div className="text-[0.6875rem] uppercase tracking-widest text-on-surface-variant md:mb-1">Run</div>
            <div className="text-sm md:text-xl font-mono font-medium text-on-surface tabular-nums">{runningCount}</div>
          </div>
          <div className="flex items-center gap-1.5 md:block">
            <div className="text-[0.6875rem] uppercase tracking-widest text-on-surface-variant md:mb-1 hidden sm:block">Done</div>
            <div className="text-sm md:text-xl font-mono font-medium text-success tabular-nums">{completedCount}</div>
          </div>
          <div className="flex items-center gap-1.5 md:block">
            <div className="text-[0.6875rem] uppercase tracking-widest text-on-surface-variant md:mb-1 hidden sm:block">Fail</div>
            <div className="text-sm md:text-xl font-mono font-medium text-error tabular-nums">{failedCount}</div>
          </div>
        </div>
      </div>
      </div>

      {/* Bento Grid Layout — fills remaining space */}
      <div className="flex-1 min-h-0 grid grid-cols-12 gap-4 sm:gap-6 px-4 sm:px-6 md:px-8 py-4 sm:py-6">
        {/* Pipeline List — only this column scrolls */}
        <div className="col-span-12 lg:col-span-8 overflow-y-auto space-y-4">
          {/* List Header with Controls */}
          <div className="flex items-center justify-between mb-2 px-2">
            <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-on-surface-variant">
              Pipeline Runs
            </h2>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[10px] text-on-surface-variant uppercase tracking-widest cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={() => setAutoRefresh(!autoRefresh)}
                  className="h-3 w-3 rounded-sm border-outline-variant bg-transparent accent-white"
                />
                Live
              </label>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as 'active' | 'all')}
                className="bg-surface-container-high border-b border-outline rounded-none px-2 py-1 text-[10px] text-on-surface-variant uppercase tracking-widest focus:border-b-primary focus:outline-none"
              >
                <option value="active">Active</option>
                <option value="all">All</option>
              </select>
              <button
                onClick={() => { setLoading(true); fetchSessions(); }}
                disabled={loading}
                className="flex items-center gap-1.5 text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-50"
              >
                {loading
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <RefreshCw className="h-3.5 w-3.5" />
                }
              </button>
              {autoRefresh && (
                <span className="text-[10px] text-outline px-2 py-0.5 border border-outline-variant/30 rounded-sm font-mono">
                  LIVE_FEED
                </span>
              )}
            </div>
          </div>

          {/* Empty State */}
          {sessions.length === 0 && !loading && (
            <div className="bg-surface-container-lowest border border-outline-variant/30 rounded-sm p-12 text-center">
              <CheckCircle className="h-6 w-6 text-outline mx-auto mb-3" />
              <p className="text-[10px] font-bold tracking-widest uppercase text-on-surface-variant">
                No {filter === 'active' ? 'active' : ''} pipeline sessions
              </p>
              <p className="text-[10px] font-mono text-outline mt-1">
                All systems nominal
              </p>
            </div>
          )}

          {/* Loading State */}
          {loading && sessions.length === 0 && (
            <div className="bg-surface-container-low p-12 text-center">
              <Loader2 className="h-5 w-5 text-on-surface-variant mx-auto mb-3 animate-spin" />
              <p className="text-[10px] font-bold tracking-widest uppercase text-on-surface-variant">
                Loading pipelines...
              </p>
            </div>
          )}

          {/* Session List */}
          <div className="space-y-1">
            {sessions.map((session) => {
              const Icon = STATUS_ICON[session.status] || AlertCircle;
              const config = STATUS_CONFIG[session.status] || STATUS_CONFIG.failed;
              const meta = session.metadata || {};
              const isStale = session.status === 'running' &&
                Date.now() - new Date(session.updatedAt).getTime() > 10 * 60 * 1000;
              const isActive = session.status === 'running' || session.status === 'queued';

              return (
                <div
                  key={session.documentId}
                  className={`group relative flex items-center bg-surface-container-low p-4 border-l-2 ${
                    isStale ? 'border-l-error' : isActive ? config.borderClass : 'border-l-transparent'
                  } hover:bg-surface-container transition-colors`}
                >
                  <div className="flex-1 flex items-center gap-6 min-w-0">
                    {/* Status Icon Badge / Pokémon Sprite */}
                    {(() => {
                      const sprite = meta.skill ? getPokemonSprite(meta.skill) : null;
                      const chain = meta.skill ? getPokemonChain(meta.skill) : null;
                      const name = meta.skill ? getPokemonName(meta.skill) : null;
                      return sprite && chain && name ? (
                        <PokemonSprite
                          status={session.status}
                          sprite={sprite}
                          chain={chain}
                          name={name}
                          skill={meta.skill!}
                          className="h-10 w-10"
                        />
                      ) : (
                        <div className="w-10 h-10 flex items-center justify-center bg-surface-container-highest rounded-sm border border-outline-variant/20 shrink-0">
                          <Icon className={`h-4 w-4 ${config.textClass} ${session.status === 'running' ? 'animate-spin' : ''}`} />
                        </div>
                      );
                    })()}

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="text-primary font-semibold text-sm truncate">{session.title}</div>
                      <div className="text-[10px] text-on-surface-variant font-mono uppercase mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        {session.project && (
                          <span>Project: <span className="text-on-surface">{session.project.name}</span></span>
                        )}
                        {meta.skill && !PIPELINE_POKEMON[meta.skill] && (
                          <span className="text-tertiary">{meta.skill}</span>
                        )}
                        {(meta.deviceName || meta.antigravityRunnerName || meta.runner) && (
                          <span className="flex items-center gap-1">
                            {meta.deviceName ? <Monitor className="h-3 w-3" /> : meta.antigravityRunnerName ? <Server className="h-3 w-3" /> : null}
                            {meta.deviceName || meta.antigravityRunnerName || meta.runner}
                          </span>
                        )}
                        {meta.fromStatus && meta.toStatus && (
                          <span>{meta.fromStatus} → {meta.toStatus}</span>
                        )}
                        {session.issues?.length > 0 && session.issues.map((iss) => (
                          <span key={iss.documentId} className="flex items-center gap-1">
                            ISS-{iss.id}
                            <span className="bg-surface-container-highest px-1 rounded-sm text-[9px]">{iss.status}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Right side: Meta + Actions */}
                  <div className="flex items-center gap-3 sm:gap-8 shrink-0">
                    {/* Timing */}
                    <div className="hidden sm:block text-right">
                      <div className="text-[10px] text-on-surface-variant uppercase mb-0.5">
                        {session.status === 'queued' && meta.depletedModel ? 'Queued until' : session.status === 'queued' ? 'Waiting' : session.status === 'running' ? 'Elapsed' : 'Finished'}
                      </div>
                      <div className="text-xs text-on-surface font-mono tabular-nums">
                        {session.status === 'queued' && meta.quotaExhaustedAt
                          ? <QuotaCountdown exhaustedAt={meta.quotaExhaustedAt} />
                          : timeAgo(session.metadata?.startedAt || session.updatedAt)}
                      </div>
                    </div>

                    {/* Retry count */}
                    {meta.retryCount != null && meta.retryCount > 0 && (
                      <div className="hidden sm:block text-right">
                        <div className="text-[10px] text-on-surface-variant uppercase mb-0.5">Retry</div>
                        <div className="text-xs text-warning font-mono">#{meta.retryCount}</div>
                      </div>
                    )}

                    {/* Status indicator */}
                    <div className="w-24 text-right">
                      <div className="text-[10px] text-on-surface-variant uppercase mb-0.5">Status</div>
                      <div className="flex items-center justify-end gap-2">
                        <span className={`text-xs font-medium ${config.textClass}`}>{config.label}</span>
                        <div className={`w-1.5 h-1.5 rounded-full ${config.dotClass}`} />
                      </div>
                      {isStale && (
                        <div className="text-[9px] text-error font-mono mt-0.5">STALE</div>
                      )}
                      {meta.noResume && (
                        <div className="text-[9px] text-warning font-mono mt-0.5">NO RESUME</div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                      {(session.status === 'queued' || session.status === 'running') && (
                        <button
                          onClick={() => handleCancel(session.documentId)}
                          disabled={actionLoading === session.documentId}
                          className="p-1.5 text-on-surface-variant hover:text-warning transition-colors disabled:opacity-50"
                          title="Mark as failed"
                        >
                          {actionLoading === session.documentId
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <XCircle className="h-3.5 w-3.5" />
                          }
                        </button>
                      )}
                      {(session.status === 'failed' || session.status === 'completed') && (
                        <>
                        <button
                          onClick={() => handleToggleNoResume(session)}
                          disabled={actionLoading === session.documentId}
                          className={`p-1.5 transition-colors disabled:opacity-50 ${meta.noResume ? 'text-warning hover:text-on-surface' : 'text-on-surface-variant hover:text-warning'}`}
                          title={meta.noResume ? 'Allow resume' : 'Block resume'}
                        >
                          {actionLoading === session.documentId
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : meta.noResume ? <RotateCcw className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />
                          }
                        </button>
                        <button
                          onClick={() => handleDelete(session.documentId)}
                          disabled={actionLoading === session.documentId}
                          className="p-1.5 text-on-surface-variant hover:text-error transition-colors disabled:opacity-50"
                          title="Delete"
                        >
                          {actionLoading === session.documentId
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Trash2 className="h-3.5 w-3.5" />
                          }
                        </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Panel: System Status — scrolls independently */}
        <div className="col-span-12 lg:col-span-4 overflow-y-auto space-y-4 sm:space-y-6">
          {/* Status Terminal */}
          <div className="bg-surface-container-lowest border border-outline-variant/30 rounded-sm p-4 overflow-hidden">
            <div className="flex items-center justify-between mb-4">
              <div className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">System Status</div>
              <div className="flex gap-1.5">
                <span className="w-2 h-2 rounded-full bg-surface-container-highest" />
                <span className="w-2 h-2 rounded-full bg-surface-container-highest" />
              </div>
            </div>
            <div className="font-mono text-[10px] space-y-1.5 text-on-surface-variant/80">
              {paused && (
                <div className="flex gap-2"><span className="text-warning">[PAUSED]</span> <span>Pipeline paused — queued sessions held</span></div>
              )}
              {runningCount > 0 && (
                <div className="flex gap-2"><span className="text-info">[RUN]</span> <span>{runningCount} pipeline(s) executing</span></div>
              )}
              {queuedCount > 0 && (
                <div className="flex gap-2"><span className="text-warning">[WAIT]</span> <span>{queuedCount} pipeline(s) in queue</span></div>
              )}
              {completedCount > 0 && (
                <div className="flex gap-2"><span className="text-success">[OK]</span> <span>{completedCount} completed successfully</span></div>
              )}
              {failedCount > 0 && (
                <div className="flex gap-2"><span className="text-error">[FAIL]</span> <span>{failedCount} pipeline(s) failed</span></div>
              )}
              {sessions.length === 0 && !loading && (
                <div className="flex gap-2"><span className="text-on-surface-variant/40">[...]</span> <span>No pipeline activity</span></div>
              )}
              <div className="animate-pulse">_</div>
            </div>
          </div>

          {/* Pipeline Breakdown */}
          <div className="bg-surface-container-low p-3 sm:p-4 rounded-sm border border-outline-variant/10">
            <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] mb-2 sm:mb-4">Pipeline Breakdown</h3>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-1 sm:gap-0 sm:space-y-3">
              {[
                { label: 'Running', count: runningCount, icon: Activity, color: 'text-info', bg: 'bg-info/20 border-info/30' },
                { label: 'Queued', count: queuedCount, icon: Clock, color: 'text-warning', bg: 'bg-warning/20 border-warning/30' },
                { label: 'Completed', count: completedCount, icon: CheckCircle, color: 'text-success', bg: 'bg-success/20 border-success/30' },
                { label: 'Failed', count: failedCount, icon: XCircle, color: 'text-error', bg: 'bg-error/20 border-error/30' },
              ].map(({ label, count, icon: ItemIcon, color, bg }) => (
                <div key={label} className="flex flex-col items-center gap-1 sm:flex-row sm:justify-between sm:items-center sm:gap-3">
                  <div className="flex flex-col items-center gap-1 sm:flex-row sm:gap-3">
                    <div className={`w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-sm border ${bg}`}>
                      <ItemIcon className={`h-3 w-3 sm:h-3.5 sm:w-3.5 ${color}`} />
                    </div>
                    <span className="text-[9px] sm:text-[10px] text-on-surface-variant uppercase tracking-widest">{label}</span>
                  </div>
                  <span className="text-sm font-mono font-medium text-on-surface tabular-nums">{count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Activity */}
          {sessions.length > 0 && (
            <div className="bg-surface-container-low p-4 rounded-sm border border-outline-variant/10">
              <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] mb-4">Recent Activity</h3>
              <div className="space-y-2">
                {sessions.slice(0, 5).map((s) => {
                  const cfg = STATUS_CONFIG[s.status] || STATUS_CONFIG.failed;
                  return (
                    <div key={s.documentId} className="flex items-center gap-3">
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dotClass}`} />
                      <span className="text-[10px] text-on-surface-variant truncate flex-1">{s.title}</span>
                      <span className="text-[9px] font-mono text-outline shrink-0">{timeAgo(s.createdAt)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer Metric Bar — sticky */}
      <div className="sticky bottom-0 z-10 bg-background px-4 sm:px-6 md:px-8 py-4 border-t border-outline-variant/20 hidden md:flex flex-wrap gap-12">
        <div className="flex items-center gap-4">
          <Zap className="h-4 w-4 text-on-surface-variant" />
          <div>
            <div className="text-[10px] uppercase text-on-surface-variant tracking-widest font-bold">Total Sessions</div>
            <div className="text-sm font-semibold text-on-surface tabular-nums">{sessions.length}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Database className="h-4 w-4 text-on-surface-variant" />
          <div>
            <div className="text-[10px] uppercase text-on-surface-variant tracking-widest font-bold">Auto-Refresh</div>
            <div className="text-sm font-semibold text-on-surface">{autoRefresh ? 'Enabled (10s)' : 'Disabled'}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Activity className="h-4 w-4 text-on-surface-variant" />
          <div>
            <div className="text-[10px] uppercase text-on-surface-variant tracking-widest font-bold">View Filter</div>
            <div className="text-sm font-semibold text-on-surface">{filter === 'active' ? 'Active Only' : 'All Pipelines'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

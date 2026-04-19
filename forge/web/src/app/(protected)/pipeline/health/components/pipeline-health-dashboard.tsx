'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '@/lib/api/client';
import { WS_URL } from '@/lib/api/client';
import Link from 'next/link';
import {
  RefreshCw, Loader2, Activity, Shield, AlertTriangle,
  CheckCircle, XCircle, RotateCcw, Clock, Zap, FolderOpen, ExternalLink, Server, Play, Monitor,
} from 'lucide-react';
import { projectApi } from '@/features/project/api/project-api';
import { agentApi } from '@/features/agent/api';
import type { AntigravityRunner } from '@/features/project/types';
import { type PipelineHealthData, type RecoveryEvent, timeAgo, StatCard, Card } from './pipeline-health-helpers';

export function PipelineHealthDashboard() {
  const [data, setData] = useState<PipelineHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<RecoveryEvent[]>([]);
  const [window, setWindow] = useState('24');
  const [runners, setRunners] = useState<AntigravityRunner[]>([]);
  const [runnersLoading, setRunnersLoading] = useState(true);
  const [triggeringIds, setTriggeringIds] = useState<Set<string>>(new Set());

  const fetchHealth = useCallback(async () => {
    try {
      const result = await apiClient<PipelineHealthData>(`/agent-sessions/pipeline-health?window=${window}`);
      setData(result);
    } catch (err) {
      console.error('Failed to fetch pipeline health:', err);
    } finally {
      setLoading(false);
    }
  }, [window]);

  const fetchRunners = useCallback(async () => {
    try {
      const res = await projectApi.getAntigravityRunners();
      setRunners(res.data);
    } catch { /* ignore */ }
    setRunnersLoading(false);
  }, []);

  const handleTrigger = useCallback(async (issueDocumentId: string) => {
    setTriggeringIds((prev) => new Set(prev).add(issueDocumentId));
    try {
      await agentApi.triggerPipeline(issueDocumentId);
      // Refresh health data after trigger
      fetchHealth();
    } catch { /* ignore */ }
    setTriggeringIds((prev) => { const next = new Set(prev); next.delete(issueDocumentId); return next; });
  }, [fetchHealth]);

  useEffect(() => {
    fetchHealth();
    fetchRunners();
    const interval = setInterval(() => { fetchHealth(); fetchRunners(); }, 30_000);
    return () => clearInterval(interval);
  }, [fetchHealth, fetchRunners]);

  // WebSocket for live recovery events
  useEffect(() => {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(WS_URL);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.event === 'pipeline:recovery') {
            setEvents((prev) => [{ ...msg.data, timestamp: msg.timestamp }, ...prev].slice(0, 50));
          }
        } catch { /* ignore */ }
      };
    } catch { /* ignore */ }
    return () => { ws?.close(); };
  }, []);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  if (!data) return null;

  const recoveryRate = data.sessions.completedByVerification + data.recovery.failedAfterCheck > 0
    ? Math.round((data.recovery.recovered / (data.recovery.recovered + data.recovery.failedAfterCheck)) * 100)
    : 0;

  const totalStuck = data.stuck.staleSessions.length + data.stuck.orphanedInProgress.length
    + data.stuck.queuedOverOneHour.length;

  return (
    <div className="w-full max-w-full overflow-x-auto p-3 sm:p-6">
      <div className="max-w-6xl mx-auto space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-bold text-on-surface">Pipeline Health</h1>
            <p className="text-[10px] sm:text-xs text-on-surface-variant mt-0.5 truncate">Recovery &amp; stuck detection — {data.window} window</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select
              value={window}
              onChange={(e) => { setWindow(e.target.value); setLoading(true); }}
              className="bg-surface-container-low text-on-surface text-xs px-2 py-1.5 rounded-sm border border-outline-variant/20"
            >
              <option value="1">1h</option>
              <option value="6">6h</option>
              <option value="24">24h</option>
              <option value="72">3d</option>
              <option value="168">7d</option>
            </select>
            <button
              onClick={() => { setLoading(true); fetchHealth(); }}
              className="p-1.5 rounded-sm hover:bg-surface-container-high transition-colors"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-on-surface-variant ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Top Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3">
          <StatCard label="Sessions" value={data.sessions.total} icon={Activity} />
          <StatCard label="Recovered" value={data.recovery.recovered} icon={Shield} color="text-success" />
          <StatCard label="Rate" value={`${recoveryRate}%`} icon={CheckCircle} color={recoveryRate >= 80 ? 'text-success' : recoveryRate >= 50 ? 'text-warning' : 'text-error'} />
          <StatCard label="Stuck" value={totalStuck} icon={AlertTriangle} color={totalStuck > 0 ? 'text-error' : 'text-success'} />
        </div>

        {/* Runner & Device Status */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] flex items-center gap-1.5">
              <Server className="h-3 w-3 shrink-0" />
              Runner &amp; Device Status
            </h3>
            {!runnersLoading && (
              <span className="text-[10px] font-mono text-on-surface-variant">
                {runners.filter((r) => r.status === 'online').length + (data.desktopDevices?.filter((d) => d.status === 'online').length ?? 0)}/{runners.length + (data.desktopDevices?.length ?? 0)} online
              </span>
            )}
          </div>

          {/* Desktop Devices */}
          {data.desktopDevices && data.desktopDevices.length > 0 && (
            <div className="mb-3">
              <div className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <Monitor className="h-2.5 w-2.5" />
                Desktop
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {data.desktopDevices.map((device) => {
                  const online = device.status === 'online';
                  return (
                    <div key={device.deviceId} className="flex items-center gap-2 p-2 bg-surface-container-high/50 rounded-sm">
                      <span className={`h-2 w-2 rounded-full shrink-0 ${online ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-surface-variant'}`} />
                      <span className="text-xs font-medium text-on-surface truncate flex-1">{device.name}</span>
                      <span className={`text-[9px] font-bold uppercase tracking-wider ${online ? 'text-success' : 'text-outline'}`}>{device.status}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Antigravity Runners */}
          {runnersLoading ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2 className="h-3 w-3 animate-spin text-outline-variant" />
              <span className="text-[10px] text-outline-variant">Loading runners...</span>
            </div>
          ) : runners.length > 0 && (
            <div>
              <div className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <Server className="h-2.5 w-2.5" />
                Antigravity
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {runners.map((runner) => {
                  const statusColor = runner.status === 'online' ? 'bg-success' : runner.status === 'error' ? 'bg-warning' : 'bg-surface-variant';
                  const textColor = runner.status === 'online' ? 'text-success' : runner.status === 'error' ? 'text-warning' : 'text-outline';
                  return (
                    <div key={runner.documentId} className="flex items-center gap-2 p-2 bg-surface-container-high/50 rounded-sm">
                      <span className={`h-2 w-2 rounded-full shrink-0 ${statusColor} ${runner.status === 'online' ? 'shadow-[0_0_6px_var(--color-success)]' : ''}`} />
                      <span className="text-xs font-medium text-on-surface truncate flex-1">{runner.name}</span>
                      <span className={`text-[9px] font-bold uppercase tracking-wider ${textColor}`}>{runner.status}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* No runners or devices */}
          {!runnersLoading && runners.length === 0 && (!data.desktopDevices || data.desktopDevices.length === 0) && (
            <p className="text-[10px] text-outline-variant py-2">No runners or devices registered</p>
          )}

          {/* All offline warning */}
          {!runnersLoading && (runners.length > 0 || (data.desktopDevices?.length ?? 0) > 0) &&
            runners.every((r) => r.status !== 'online') &&
            (data.desktopDevices?.every((d) => d.status !== 'online') ?? true) && (
            <p className="text-[10px] text-warning mt-2 flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              All runners &amp; devices offline — pipeline cannot dispatch
            </p>
          )}
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
          {/* Left: Session breakdown + Recovery */}
          <div className="lg:col-span-2 space-y-4 min-w-0">
            {/* Session Status */}
            <Card>
              <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5">
                <Activity className="h-3 w-3 shrink-0" />
                Sessions
              </h3>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {[
                  { label: 'Done', value: data.sessions.completed, color: 'text-success' },
                  { label: 'Verified', value: data.sessions.completedByVerification, color: 'text-info' },
                  { label: 'Failed', value: data.sessions.failed, color: 'text-error' },
                  { label: 'Running', value: data.sessions.running, color: 'text-info' },
                  { label: 'Queued', value: data.sessions.queued, color: 'text-warning' },
                ].map((s) => (
                  <div key={s.label} className="min-w-0">
                    <div className="text-[9px] text-on-surface-variant uppercase mb-0.5 truncate">{s.label}</div>
                    <div className={`text-base font-mono font-medium tabular-nums ${s.color}`}>{s.value}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Recovery Breakdown */}
            <Card>
              <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5">
                <Shield className="h-3 w-3 shrink-0" />
                Recovery
              </h3>
              <div className="grid grid-cols-2 gap-2 mb-4">
                {[
                  { label: 'Recovered', value: data.recovery.recovered, color: 'text-success' },
                  { label: 'Failed', value: data.recovery.failedAfterCheck, color: 'text-error' },
                  { label: 'Retries', value: data.recovery.autoRetries, color: 'text-info' },
                  { label: 'Exhausted', value: data.recovery.retriesExhausted, color: 'text-warning' },
                ].map((r) => (
                  <div key={r.label} className="min-w-0">
                    <div className="text-[9px] text-on-surface-variant uppercase mb-0.5 truncate">{r.label}</div>
                    <div className={`text-base font-mono font-medium tabular-nums ${r.color}`}>{r.value}</div>
                  </div>
                ))}
              </div>

              {/* Recovery by tag */}
              {Object.keys(data.recovery.recoveredBy).length > 0 && (
                <div>
                  <div className="text-[10px] text-on-surface-variant uppercase mb-2">By Path</div>
                  <div className="space-y-1.5">
                    {Object.entries(data.recovery.recoveredBy)
                      .sort(([, a], [, b]) => b - a)
                      .map(([tag, count]) => (
                        <div key={tag} className="flex items-center justify-between">
                          <span className="text-xs font-mono text-on-surface-variant truncate mr-2">{tag}</span>
                          <span className="text-xs font-mono text-success tabular-nums shrink-0">{count}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </Card>

            {/* By Skill */}
            {Object.keys(data.bySkill).length > 0 && (
              <Card>
                <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5">
                  <Zap className="h-3 w-3 shrink-0" />
                  By Skill
                </h3>
                <div className="space-y-3">
                  {Object.entries(data.bySkill)
                    .sort(([, a], [, b]) => (b.completed + b.failed) - (a.completed + a.failed))
                    .map(([skill, stats]) => {
                      const total = stats.completed + stats.failed;
                      const successPct = total > 0 ? Math.round((stats.completed / total) * 100) : 0;
                      return (
                        <div key={skill} className="min-w-0">
                          <div className="flex items-center justify-between mb-1 gap-2">
                            <span className="text-[10px] sm:text-xs font-mono text-on-surface-variant truncate">{skill.replace('forge-', '')}</span>
                            <div className="flex items-center gap-2 text-[9px] sm:text-[10px] font-mono tabular-nums shrink-0">
                              <span className="text-success">{stats.completed}</span>
                              <span className="text-info">{stats.recovered}</span>
                              <span className="text-error">{stats.failed}</span>
                            </div>
                          </div>
                          <div className="w-full h-1 bg-surface-container-high rounded-full">
                            <div
                              className="h-full bg-success rounded-full"
                              style={{ width: `${Math.max(successPct, 2)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>
              </Card>
            )}
          </div>

          {/* Right sidebar */}
          <div className="space-y-4 min-w-0">
            {/* Stuck Alerts */}
            <div className={`p-3 rounded-sm border min-w-0 overflow-hidden ${totalStuck > 0 ? 'bg-error/5 border-error/20' : 'bg-surface-container-low border-outline-variant/10'}`}>
              <h3 className={`text-[10px] font-bold uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5 ${totalStuck > 0 ? 'text-error' : 'text-on-surface-variant'}`}>
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Stuck Detection
              </h3>
              {totalStuck === 0 ? (
                <p className="text-xs text-success flex items-center gap-1.5">
                  <CheckCircle className="h-3 w-3 shrink-0" /> All clear
                </p>
              ) : (
                <div className="space-y-3">
                  {data.stuck.staleSessions.length > 0 && (
                    <div>
                      <div className="text-[10px] text-error font-medium mb-1">Stale ({data.stuck.staleSessions.length})</div>
                      {data.stuck.staleSessions.map((s) => (
                        <div key={s.id} className="text-[10px] text-on-surface-variant truncate">
                          {s.title || s.id} — {timeAgo(s.updatedAt)}
                        </div>
                      ))}
                    </div>
                  )}
                  {data.stuck.orphanedInProgress.length > 0 && (
                    <div>
                      <div className="text-[10px] text-error font-medium mb-1">Orphaned ({data.stuck.orphanedInProgress.length})</div>
                      {data.stuck.orphanedInProgress.map((i) => (
                        <div key={i.documentId} className="text-[10px] text-on-surface-variant truncate">
                          ISS-{i.issueId} — {timeAgo(i.updatedAt)}
                        </div>
                      ))}
                    </div>
                  )}
                  {data.stuck.queuedOverOneHour.length > 0 && (
                    <div>
                      <div className="text-[10px] text-warning font-medium mb-1">Queue ({data.stuck.queuedOverOneHour.length})</div>
                      {data.stuck.queuedOverOneHour.map((s) => (
                        <div key={s.id} className="text-[10px] text-on-surface-variant truncate">
                          {s.title || s.id} — {timeAgo(s.createdAt)}
                        </div>
                      ))}
                    </div>
                  )}
                  {data.stuck.failedNoRetry > 0 && (
                    <div className="text-[10px] text-warning">
                      {data.stuck.failedNoRetry} failed, no retry
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Stale Watcher */}
            <Card>
              <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5">
                <Clock className="h-3 w-3 shrink-0" />
                Stale Watcher
              </h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-on-surface-variant">Last Run</span>
                  <span className="font-mono text-on-surface">{timeAgo(data.staleWatcher.lastRun)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-on-surface-variant">Runs</span>
                  <span className="font-mono text-on-surface tabular-nums">{data.staleWatcher.runs}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-on-surface-variant">Recovered</span>
                  <span className="font-mono text-success tabular-nums">{data.staleWatcher.sessionsRecovered}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-on-surface-variant">Failed</span>
                  <span className="font-mono text-error tabular-nums">{data.staleWatcher.sessionsFailed}</span>
                </div>
              </div>
            </Card>

            {/* Live Recovery Feed */}
            <Card>
              <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5">
                <RotateCcw className="h-3 w-3 shrink-0" />
                Live Feed
              </h3>
              {events.length === 0 ? (
                <p className="text-[10px] text-outline-variant text-center py-2">Waiting for events...</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {events.map((evt, i) => (
                    <div key={`${evt.sessionId}-${i}`} className="text-[10px] border-l-2 pl-2 py-0.5"
                      style={{ borderColor: evt.outcome === 'recovered' ? 'var(--color-success)' : 'var(--color-error)' }}>
                      <div className="flex items-center gap-1">
                        {evt.outcome === 'recovered'
                          ? <CheckCircle className="h-2.5 w-2.5 text-success shrink-0" />
                          : <XCircle className="h-2.5 w-2.5 text-error shrink-0" />}
                        <span className="font-mono text-on-surface truncate">{evt.skill}</span>
                        <span className="text-outline-variant shrink-0">via {evt.tag}</span>
                      </div>
                      {evt.issueId && (
                        <div className="text-outline-variant mt-0.5 truncate">ISS-{evt.issueId} — {timeAgo(evt.timestamp)}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>

        {/* Per-Project Missed Triggers */}
        {Object.keys(data.byProject).length > 0 && (() => {
          const projectEntries = Object.entries(data.byProject);
          const totalMissed = projectEntries.reduce((sum, [, p]) => sum + p.missedTriggers.length, 0);
          const projectsWithMissed = projectEntries.filter(([, p]) => p.missedTriggers.length > 0).length;

          return (
            <div className="space-y-3 min-w-0">
              {/* Summary cards */}
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-on-surface flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 shrink-0" />
                  <span className="truncate">Missed Triggers</span>
                </h2>
                {totalMissed > 0 && (
                  <span className="text-[10px] font-mono text-warning shrink-0">
                    {totalMissed} issue{totalMissed !== 1 ? 's' : ''} across {projectsWithMissed} project{projectsWithMissed !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {/* Per-project summary grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {projectEntries.map(([key, proj]) => {
                  const missed = proj.missedTriggers.length;
                  return (
                    <div
                      key={key}
                      className={`p-2.5 rounded-sm border min-w-0 overflow-hidden ${missed > 0 ? 'bg-warning/5 border-warning/20' : 'bg-surface-container-low border-outline-variant/10'}`}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[10px] font-medium text-on-surface truncate">{proj.name}</span>
                        <span className={`text-[8px] px-1 py-0.5 rounded-sm font-mono shrink-0 ${proj.pipelineEnabled ? 'bg-success/10 text-success' : 'bg-surface-container-high text-outline'}`}>
                          {proj.pipelineEnabled ? 'on' : 'off'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className={`text-lg font-mono font-medium tabular-nums ${missed > 0 ? 'text-warning' : 'text-success'}`}>
                          {missed}
                        </span>
                        <span className="text-[9px] text-on-surface-variant font-mono tabular-nums">
                          {proj.sessionsInWindow}s
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Detailed missed trigger list per project */}
              {projectEntries
                .filter(([, proj]) => proj.missedTriggers.length > 0)
                .map(([key, proj]) => (
                  <Card key={key} className="!bg-warning/5 !border-warning/20">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle className="h-3 w-3 text-warning shrink-0" />
                      <span className="text-xs font-medium text-on-surface truncate">{proj.name}</span>
                      <span className="text-[9px] text-warning font-mono shrink-0">{proj.missedTriggers.length} missed</span>
                    </div>
                    <div className="space-y-1.5">
                      {proj.missedTriggers.map((t) => (
                        <div key={t.documentId} className="flex items-center gap-2 text-[10px] p-1.5 -mx-1.5 rounded-sm hover:bg-surface-container-high transition-colors group min-w-0">
                          <Link
                            href={`/projects/${proj.slug}/issues/${t.documentId}`}
                            className="flex items-center gap-2 flex-1 min-w-0"
                          >
                            <ExternalLink className="h-2.5 w-2.5 text-outline-variant group-hover:text-primary shrink-0" />
                            <span className="font-mono text-primary-fixed shrink-0">ISS-{t.issueId}</span>
                            <span className="text-on-surface-variant truncate flex-1">{t.title}</span>
                            <span className="font-mono text-warning shrink-0">{t.status}</span>
                            <span className="text-outline-variant shrink-0">{timeAgo(t.updatedAt)}</span>
                          </Link>
                          <button
                            onClick={() => handleTrigger(t.documentId)}
                            disabled={triggeringIds.has(t.documentId)}
                            className="flex items-center gap-1 px-2 py-0.5 rounded-sm border border-primary/30 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50 shrink-0"
                            title={`Trigger ${t.expectedSkill}`}
                          >
                            {triggeringIds.has(t.documentId) ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            ) : (
                              <Play className="h-2.5 w-2.5" />
                            )}
                            <span className="text-[9px] font-bold uppercase">Trigger</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </Card>
                ))}

              {/* All clear message if no missed triggers */}
              {totalMissed === 0 && (
                <p className="text-[10px] text-success flex items-center gap-1.5 p-3">
                  <CheckCircle className="h-3 w-3 shrink-0" /> All auto-enabled steps running as expected
                </p>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

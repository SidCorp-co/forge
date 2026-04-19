'use client';

import { Shell } from '@/components/layout/shell';
import { useProjects } from '@/features/project/hooks/use-projects';
import { useIssues } from '@/features/issue/hooks/use-issues';
import Link from 'next/link';
import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { CreateProjectModal } from '@/features/project/components/create-project-modal';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { FolderOpen, ArrowUpRight, ArrowDownRight, CircleSlash, Radio, ArrowRight, Activity, Zap, Server, Monitor, PauseCircle, Ban } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { apiClient } from '@/lib/api/client';
import { projectApi } from '@/features/project/api/project-api';
import type { Device, AntigravityRunner } from '@/features/project/types';
import { CountdownTimer } from '@/app/projects/[slug]/settings/components/antigravity-sub-components';

type PipelineTelemetry = {
  recovered: number;
  failed: number;
  recoveredBy: Record<string, number>;
  autoRetries: number;
  retriesExhausted: number;
  staleWatcher: { runs: number; sessionsRecovered: number; sessionsFailed: number; lastRun: string | null };
};

export default function DashboardPage() {
  useSetPageTitle('Dashboard');
  const { data: projectsData, isLoading: loadingProjects } = useProjects();
  const { data: issuesData, isLoading: loadingIssues } = useIssues();

  const projects = projectsData?.data ?? [];
  const issues = issuesData?.data ?? [];

  const [showCreateProject, setShowCreateProject] = useState(false);

  const { data: telemetry, isLoading: loadingTelemetry } = useQuery({
    queryKey: ['pipeline-telemetry'],
    queryFn: () => apiClient<PipelineTelemetry>('/agent-sessions/pipeline-telemetry'),
    refetchInterval: 30000,
  });

  const { data: devicesData, isLoading: loadingDevices } = useQuery({
    queryKey: ['devices'],
    queryFn: () => projectApi.getDevices(),
    refetchInterval: 30000,
  });
  const devices = (devicesData?.data ?? []) as Device[];

  const { data: runnersData, isLoading: loadingRunners } = useQuery({
    queryKey: ['antigravity-runners'],
    queryFn: () => projectApi.getAntigravityRunners(),
    refetchInterval: 30000,
  });
  const runners = (runnersData?.data ?? []) as AntigravityRunner[];

  const totalIssues = issues.length;
  const openIssues = issues.filter((i) => ['open', 'reopen', 'approved', 'needs_info'].includes(i.status)).length;
  const inProgressIssues = issues.filter((i) => i.status === 'in_progress').length;
  const resolvedIssues = issues.filter((i) => i.status === 'released').length;
  const doneIssues = issues.filter((i) => i.status === 'closed').length;
  const criticalIssues = issues.filter((i) => i.priority === 'critical' && !['confirmed', 'closed'].includes(i.status)).length;
  const highIssues = issues.filter((i) => i.priority === 'high' && !['confirmed', 'closed'].includes(i.status)).length;

  const recentActivity = useMemo(() => {
    return [...issues]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 6);
  }, [issues]);

  return (
    <Shell>
      <div className="flex-1 overflow-y-auto bg-background text-on-surface">
        <div className="p-4 sm:p-8 max-w-[1600px] mx-auto font-['Inter']">
          
          {/* Stat Cards Section */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
            <div className="bg-surface-container-low border border-outline-variant/10 p-5 rounded-sm hover:border-outline-variant/40 transition-all group">
              <div className="flex justify-between items-start mb-4">
                <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase">Open</span>
                <CircleSlash className="text-on-surface-variant group-hover:text-on-surface h-[18px] w-[18px]" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-light tracking-tight">{openIssues}</span>
                <span className="text-[10px] text-error flex items-center gap-0.5 tabular-nums">/{totalIssues} <ArrowUpRight className="h-3 w-3" /></span>
              </div>
            </div>

            <div className="bg-surface-container-low border border-outline-variant/10 p-5 rounded-sm hover:border-outline-variant/40 transition-all group">
              <div className="flex justify-between items-start mb-4">
                <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase">In Progress</span>
                <Activity className="text-on-surface h-[18px] w-[18px]" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-light tracking-tight">{inProgressIssues}</span>
                <span className="text-[10px] text-on-surface-variant flex items-center gap-0.5">Active <ArrowRight className="h-3 w-3" /></span>
              </div>
            </div>

            <div className="bg-surface-container-low border border-outline-variant/10 p-5 rounded-sm hover:border-outline-variant/40 transition-all group">
              <div className="flex justify-between items-start mb-4">
                <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase">Released</span>
                <Radio className="text-on-surface-variant group-hover:text-on-surface h-[18px] w-[18px]" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-light tracking-tight">{resolvedIssues}</span>
                <span className="text-[10px] text-on-surface flex items-center gap-0.5">Ready <ArrowUpRight className="h-3 w-3" /></span>
              </div>
            </div>

            <div className="bg-surface-container-low border border-outline-variant/10 p-5 rounded-sm hover:border-outline-variant/40 transition-all group">
              <div className="flex justify-between items-start mb-4">
                <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase">Closed</span>
                <CircleSlash className="text-on-surface-variant group-hover:text-on-surface h-[18px] w-[18px]" />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-light tracking-tight">{doneIssues}</span>
                <span className="text-[10px] text-on-surface-variant flex items-center gap-0.5">Done <ArrowDownRight className="h-3 w-3" /></span>
              </div>
            </div>

            <div className={cn("bg-surface-container-low border border-outline-variant/10 p-5 rounded-sm transition-all group", criticalIssues + highIssues > 0 ? "border-l-2 border-l-error/40 hover:border-outline-variant/40" : "hover:border-outline-variant/40")}>
              <div className="flex justify-between items-start mb-4">
                <span className={cn("text-[10px] font-bold tracking-[0.2em] uppercase", criticalIssues + highIssues > 0 ? "text-error" : "text-on-surface-variant")}>Urgent</span>
                <Activity className={cn("h-[18px] w-[18px]", criticalIssues + highIssues > 0 ? "text-error" : "text-on-surface-variant")} />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-light tracking-tight tabular-nums">{(criticalIssues + highIssues).toString().padStart(2, '0')}</span>
                <span className="text-[10px] text-error flex items-center gap-0.5">Critical</span>
              </div>
            </div>
          </div>

          {/* Pipeline Telemetry Section */}
          <div className="mb-8">
            <h2 className="text-sm font-bold uppercase tracking-widest flex items-center gap-2 mb-4">
              <Zap className="h-4 w-4" />
              Pipeline Telemetry
            </h2>
            {loadingTelemetry ? (
              <Skeleton className="h-[120px] w-full bg-surface-container-low" />
            ) : telemetry ? (
              <div className="bg-surface-container-low border border-outline-variant/10 p-5 rounded-sm">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase block mb-2">Recovered</span>
                    <span className={cn("text-3xl font-light tracking-tight tabular-nums", telemetry.recovered > 0 && "text-success")}>{telemetry.recovered}</span>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase block mb-2">Failed</span>
                    <span className={cn("text-3xl font-light tracking-tight tabular-nums", telemetry.failed > 0 && "text-error")}>{telemetry.failed}</span>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase block mb-2">Auto Retries</span>
                    <span className="text-3xl font-light tracking-tight tabular-nums">{telemetry.autoRetries}</span>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase block mb-2">Retries Exhausted</span>
                    <span className={cn("text-3xl font-light tracking-tight tabular-nums", telemetry.retriesExhausted > 0 && "text-warning")}>{telemetry.retriesExhausted}</span>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t border-outline-variant/10">
                  <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase block mb-3">Stale Watcher</span>
                  <div className="flex items-center gap-6">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-lg font-light tabular-nums">{telemetry.staleWatcher.runs}</span>
                      <span className="text-[10px] text-on-surface-variant">Runs</span>
                    </div>
                    <div className="w-[1px] h-5 bg-outline-variant/30"></div>
                    <div className="flex items-baseline gap-1.5">
                      <span className={cn("text-lg font-light tabular-nums", telemetry.staleWatcher.sessionsRecovered > 0 && "text-success")}>{telemetry.staleWatcher.sessionsRecovered}</span>
                      <span className="text-[10px] text-on-surface-variant">Recovered</span>
                    </div>
                    <div className="w-[1px] h-5 bg-outline-variant/30"></div>
                    <div className="flex items-baseline gap-1.5">
                      <span className={cn("text-lg font-light tabular-nums", telemetry.staleWatcher.sessionsFailed > 0 && "text-error")}>{telemetry.staleWatcher.sessionsFailed}</span>
                      <span className="text-[10px] text-on-surface-variant">Failed</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-surface-container-low border border-outline-variant/10 p-5 rounded-sm">
                <span className="text-[11px] text-on-surface-variant">Telemetry data unavailable</span>
              </div>
            )}
          </div>

          {/* Infrastructure: Devices & AG Runners */}
          <div className="mb-8">
            <h2 className="text-sm font-bold uppercase tracking-widest flex items-center gap-2 mb-4">
              <Server className="h-4 w-4" />
              Infrastructure
            </h2>
            {(loadingDevices || loadingRunners) ? (
              <Skeleton className="h-[80px] w-full bg-surface-container-low" />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Devices */}
                <div className="bg-surface-container-low border border-outline-variant/10 p-5 rounded-sm">
                  <div className="flex items-center gap-2 mb-3">
                    <Monitor className="h-3.5 w-3.5 text-on-surface-variant" />
                    <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase">Devices ({devices.length})</span>
                  </div>
                  {devices.length === 0 ? (
                    <span className="text-[11px] text-on-surface-variant">No devices registered</span>
                  ) : (
                    <div className="space-y-2">
                      {devices.map((d) => {
                        const paused = d.disabledUntil && new Date(d.disabledUntil).getTime() > Date.now();
                        const online = d.lastSeen && (Date.now() - new Date(d.lastSeen).getTime()) < 5 * 60 * 1000;
                        return (
                          <div key={d.documentId} className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={cn("h-2 w-2 rounded-full shrink-0", paused ? "bg-warning" : online ? "bg-success" : "bg-outline-variant")} />
                              <span className="text-[11px] font-medium truncate">{d.name}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {paused && (
                                <span className="inline-flex items-center gap-1 text-[9px] font-bold text-warning uppercase bg-warning-surface border border-warning/20 px-1.5 py-0.5 rounded-sm">
                                  <PauseCircle className="h-3 w-3" />
                                  <CountdownTimer target={d.disabledUntil!} />
                                </span>
                              )}
                              {!paused && (
                                <span className={cn("text-[9px] font-bold uppercase", online ? "text-success" : "text-on-surface-variant/50")}>
                                  {online ? 'ONLINE' : 'OFFLINE'}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* AG Runners */}
                <div className="bg-surface-container-low border border-outline-variant/10 p-5 rounded-sm">
                  <div className="flex items-center gap-2 mb-3">
                    <Zap className="h-3.5 w-3.5 text-on-surface-variant" />
                    <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase">AG Runners ({runners.length})</span>
                    <Link href="/antigravity" className="ml-auto text-[9px] text-primary hover:underline">Manage</Link>
                  </div>
                  {runners.length === 0 ? (
                    <span className="text-[11px] text-on-surface-variant">No runners configured</span>
                  ) : (
                    <div className="space-y-2">
                      {runners.map((r) => {
                        const paused = r.disabledUntil && new Date(r.disabledUntil).getTime() > Date.now();
                        return (
                          <div key={r.documentId} className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={cn("h-2 w-2 rounded-full shrink-0", paused ? "bg-warning" : r.excluded ? "bg-outline-variant" : r.status === 'online' ? "bg-success" : r.status === 'error' ? "bg-warning" : "bg-outline-variant")} />
                              <span className={cn("text-[11px] font-medium truncate", r.excluded && "opacity-50")}>{r.name}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {paused && (
                                <span className="inline-flex items-center gap-1 text-[9px] font-bold text-warning uppercase bg-warning-surface border border-warning/20 px-1.5 py-0.5 rounded-sm">
                                  <PauseCircle className="h-3 w-3" />
                                  <CountdownTimer target={r.disabledUntil!} />
                                </span>
                              )}
                              {r.excluded && !paused && (
                                <span className="inline-flex items-center gap-1 text-[9px] font-bold text-danger uppercase">
                                  <Ban className="h-3 w-3" /> EXCLUDED
                                </span>
                              )}
                              {!paused && !r.excluded && (
                                <span className={cn("text-[9px] font-bold uppercase", r.status === 'online' ? "text-success" : r.status === 'error' ? "text-warning" : "text-on-surface-variant/50")}>
                                  {r.status.toUpperCase()}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-12 gap-8">
            {/* Project Cards List (Left Column) */}
            <div className="col-span-12 lg:col-span-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-sm font-bold uppercase tracking-widest flex items-center gap-2">
                  <span className="w-2 h-2 bg-primary"></span>
                  Active Projects
                </h2>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setShowCreateProject(true)}
                    className="bg-primary text-on-primary text-[10px] font-bold uppercase tracking-wider px-4 py-2 rounded-sm active:scale-95 transition-all"
                  >
                    New Project
                  </button>
                </div>
              </div>

              {loadingProjects ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-[200px] w-full bg-surface-container-low" />)}
                </div>
              ) : projects.length === 0 ? (
                <EmptyState title="No projects yet." description="Click 'New Project' to get started." />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {projects.map((p) => {
                    const projIssues = issues.filter((i) => i.project?.slug === p.slug);
                    const projOpen = projIssues.filter((i) => ['open', 'reopen', 'approved', 'needs_info'].includes(i.status)).length;
                    const projActive = projIssues.filter((i) => i.status === 'in_progress').length;
                    const projDone = projIssues.filter((i) => i.status === 'closed').length;
                    const completion = projIssues.length > 0 ? Math.round((projDone / projIssues.length) * 100) : 0;

                    return (
                      <Link
                        key={p.id}
                        href={`/projects/${p.slug}`}
                        className="bg-surface-container-low border border-outline-variant/10 p-6 rounded-sm hover:bg-surface-container-high transition-all cursor-pointer block"
                      >
                        <div className="flex justify-between items-start mb-6 w-full">
                          <div className="min-w-0 pr-4">
                            <h3 className="text-lg font-bold tracking-tight mb-1 truncate text-primary">{p.name}</h3>
                            <p className="text-[10px] text-on-surface-variant font-mono uppercase truncate">ID: PRJ-{String(p.id).substring(0, 8)}</p>
                          </div>
                          <div className="bg-surface-variant p-2 rounded-sm shrink-0">
                            <FolderOpen className="h-4 w-4 text-on-surface" />
                          </div>
                        </div>

                        <div className="flex items-center gap-6">
                          <div className="flex flex-col min-w-0">
                            <span className="text-[9px] uppercase tracking-widest text-on-surface-variant font-bold mb-1">Issues</span>
                            <span className="text-xl font-medium tracking-tight whitespace-nowrap"><span className="tabular-nums">{projActive}</span> Active</span>
                          </div>
                          <div className="w-[1px] h-8 bg-outline-variant/30"></div>
                          <div className="flex flex-col min-w-0">
                            <span className="text-[9px] uppercase tracking-widest text-on-surface-variant font-bold mb-1">Open</span>
                            <span className="text-xl font-medium tracking-tight whitespace-nowrap tabular-nums">{projOpen}</span>
                          </div>
                        </div>

                        <div className="mt-6 pt-6 border-t border-outline-variant/10 flex items-center justify-between">
                          <div className="flex -space-x-2">
                             {/* Mock contributors visual */}
                             <div className="w-6 h-6 rounded-full border border-background bg-surface-container-high flex items-center justify-center text-[8px]">+1</div>
                          </div>
                          <span className="text-[10px] text-on-surface-variant font-medium">{completion}% COMPLETE</span>
                        </div>
                      </Link>
                    )
                  })}
                  
                  {/* Create New Project empty-slate stylistic card */}
                  <button 
                    onClick={() => setShowCreateProject(true)}
                    className="bg-surface-container-low border-2 border-dashed border-outline-variant/30 p-6 rounded-sm hover:bg-surface-container-low/50 transition-all flex flex-col items-center justify-center text-center group h-full min-h-[220px]"
                  >
                    <FolderOpen className="h-8 w-8 text-on-surface-variant/40 group-hover:text-on-surface transition-colors mb-2" />
                    <p className="text-xs font-bold uppercase tracking-widest text-on-surface-variant/60">Initialize New Project</p>
                  </button>
                </div>
              )}
            </div>

            {/* Recent Activity Feed (Right Column) */}
            <div className="col-span-12 lg:col-span-4">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-sm font-bold uppercase tracking-widest flex items-center gap-2">
                  <Activity className="h-4 w-4" />
                  Recent Activity
                </h2>
              </div>

              {loadingIssues ? (
                <div className="bg-surface-container-low border border-outline-variant/10 rounded-sm overflow-hidden p-0 flex flex-col gap-[1px] bg-outline-variant/5">
                  {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[88px] w-full bg-surface-container-low rounded-none" />)}
                </div>
              ) : recentActivity.length === 0 ? (
                <EmptyState title="No recent activity." />
              ) : (
                <div className="bg-surface-container-low border border-outline-variant/10 rounded-sm overflow-hidden">
                  <div className="p-0">
                    {recentActivity.map((issue) => {
                      const isError = issue.priority === 'critical' || issue.priority === 'high';
                      const isComplete = issue.status === 'closed' || issue.status === 'released';
                      
                      const iconBg = isError ? 'bg-danger-surface' : isComplete ? 'bg-success-surface' : 'bg-info-surface-low';
                      const iconColor = isError ? 'text-danger' : isComplete ? 'text-success' : 'text-info';
                      const badgeBorder = isError ? 'border-danger/20' : isComplete ? 'border-success/20' : 'border-info/20';
                      
                      return (
                        <Link
                          key={issue.id}
                          href={issue.project ? `/projects/${issue.project.slug}/issues/${issue.documentId}` : '#'}
                          className="flex items-start gap-4 p-5 hover:bg-surface-container-high transition-all border-b border-outline-variant/5 w-full text-left"
                        >
                          <div className="mt-1 shrink-0">
                            <div className={cn("w-6 h-6 rounded-sm flex items-center justify-center", iconBg)}>
                              {isComplete ? (
                                <Radio className={cn("h-3.5 w-3.5", iconColor)} />
                              ) : isError ? (
                                <Activity className={cn("h-3.5 w-3.5", iconColor)} />
                              ) : (
                                <CircleSlash className={cn("h-3.5 w-3.5", iconColor)} />
                              )}
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-1 gap-2">
                              <span className="text-[11px] font-bold text-primary tracking-tight truncate">{issue.title}</span>
                              <span className={cn("text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-sm border shrink-0", iconBg, iconColor, badgeBorder)}>
                                {issue.status.replace('_', ' ')}
                              </span>
                            </div>
                            <p className="text-[10px] text-on-surface-variant line-clamp-1 mb-2">
                              {issue.project ? `Project: ${issue.project.name}` : 'Unknown Project'} • {issue.priority} Priority
                            </p>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-on-surface-variant/60 tabular-nums">
                                {new Date(issue.updatedAt).toLocaleDateString()}
                              </span>
                              <span className="text-[9px] text-on-surface-variant/60">•</span>
                              <span className="text-[9px] text-on-surface-variant/60 font-mono">ISS-{issue.id}</span>
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                  <Link href={`/projects`} className="block w-full text-center py-4 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high transition-all border-t border-outline-variant/10">
                    View All Projects
                  </Link>
                </div>
              )}

              {/* System Status Card */}
              <div className="mt-8 bg-background border border-outline-variant/30 p-4 rounded-sm">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">System Status</span>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-success"></span>
                    <span className="text-[10px] font-bold text-success uppercase">Operational</span>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-on-surface-variant">API Engine</span>
                    <span className="text-[11px] font-mono">24ms</span>
                  </div>
                  <div className="w-full bg-surface-container-high h-1 rounded-full overflow-hidden">
                    <div className="bg-primary h-full w-[94%]"></div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-on-surface-variant">Compute Load</span>
                    <span className="text-[11px] font-mono tabular-nums">32.4%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <CreateProjectModal open={showCreateProject} onClose={() => setShowCreateProject(false)} />
        </div>
      </div>
    </Shell>
  );
}

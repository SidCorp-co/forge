'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAllIssues } from '@/features/issue/hooks/use-issues';
import { useProjects } from '@/features/project/hooks/use-projects';
import { usePipelineTiming } from '@/features/issue/hooks/use-pipeline-timing';
import { useQueryClient } from '@tanstack/react-query';
import { PIPELINE_STAGES } from '../constants';
import { isBottlenecked } from '../utils';
import { StageColumn } from './stage-column';
import { PipelineStatsPanel } from './pipeline-stats-panel';
import { StepTimingPanel } from './step-timing-panel';
import { RefreshCw, Loader2, Activity } from 'lucide-react';

export function PipelineProgressDashboard() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const queryClient = useQueryClient();

  const { data: issuesResp, isLoading } = useAllIssues();
  const { data: projectsResp } = useProjects();
  const { data: timingData } = usePipelineTiming({ from: new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0], to: new Date().toISOString().split('T')[0] });
  const projects = projectsResp?.data ?? [];
  const stepStats = timingData?.steps;

  const allIssues = useMemo(() => {
    const issues = issuesResp?.data ?? [];
    return issues.filter((i) => i.status !== 'draft');
  }, [issuesResp]);

  const filteredIssues = useMemo(() => {
    if (projectFilter === 'all') return allIssues;
    return allIssues.filter((i) => i.project?.slug === projectFilter);
  }, [allIssues, projectFilter]);

  const refetch = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['issues', 'all'] });
  }, [queryClient]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(refetch, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, refetch]);

  const activeIssues = filteredIssues.filter(
    (i) => i.status !== 'released' && i.status !== 'closed'
  );
  const bottleneckedCount = activeIssues.filter((i) => isBottlenecked(i, PIPELINE_STAGES)).length;

  const now = Date.now();
  const completedToday = filteredIssues.filter(
    (i) => (i.status === 'released' || i.status === 'closed') && now - new Date(i.updatedAt).getTime() < 86400000
  ).length;

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Hero Stats Header */}
      <div className="sticky top-0 z-10 bg-background px-4 sm:px-6 md:px-8 pt-3 sm:pt-4 md:pt-8 pb-3 sm:pb-4 md:pb-6 border-b border-outline-variant/20">
        <div className="flex items-center justify-between md:flex-col md:items-start lg:flex-row lg:items-end gap-2 md:gap-6">
          <div className="flex items-baseline gap-2 sm:gap-3 md:block md:space-y-2">
            <h1 className="text-xl sm:text-2xl md:text-[3.5rem] font-black tracking-tighter leading-none text-primary">
              {activeIssues.length}
              <span className="text-on-surface-variant text-xs sm:text-base md:text-xl font-normal tracking-tight ml-1.5 sm:ml-2 md:ml-3">In Flight</span>
            </h1>
            <p className="hidden sm:flex text-on-surface-variant text-xs sm:text-sm items-center gap-2">
              {bottleneckedCount > 0 && (
                <>
                  <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
                  {bottleneckedCount} bottlenecked
                </>
              )}
              {bottleneckedCount === 0 && activeIssues.length > 0 && (
                <>
                  <span className="w-2 h-2 rounded-full bg-success" />
                  All flowing
                </>
              )}
              {activeIssues.length === 0 && (
                <>
                  <span className="w-2 h-2 rounded-full bg-outline" />
                  No active issues
                </>
              )}
              <span className="text-outline">•</span>
              {completedToday} completed today
            </p>
          </div>
          <div className="flex items-center gap-3 sm:gap-4 md:grid md:grid-cols-3 md:gap-8 text-right">
            <div className="flex items-center gap-1.5 md:block">
              <div className="text-[0.6875rem] uppercase tracking-widest text-on-surface-variant md:mb-1">Active</div>
              <div className="text-sm md:text-xl font-mono font-medium text-on-surface tabular-nums">{activeIssues.length}</div>
            </div>
            <div className="flex items-center gap-1.5 md:block">
              <div className="text-[0.6875rem] uppercase tracking-widest text-on-surface-variant md:mb-1 hidden sm:block">Stuck</div>
              <div className="text-sm md:text-xl font-mono font-medium text-warning tabular-nums">{bottleneckedCount}</div>
            </div>
            <div className="flex items-center gap-1.5 md:block">
              <div className="text-[0.6875rem] uppercase tracking-widest text-on-surface-variant md:mb-1 hidden sm:block">Done</div>
              <div className="text-sm md:text-xl font-mono font-medium text-success tabular-nums">{completedToday}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Bento Grid */}
      <div className="flex-1 min-h-0 grid grid-cols-12 gap-4 sm:gap-6 px-4 sm:px-6 md:px-8 py-4 sm:py-6">
        {/* Pipeline Columns */}
        <div className="col-span-12 lg:col-span-8 overflow-y-auto">
          {/* Controls */}
          <div className="flex items-center justify-between mb-3 px-1">
            <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-on-surface-variant">
              Pipeline Stages
            </h2>
            <div className="flex items-center gap-3">
              {projects.length > 1 && (
                <select
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  className="bg-surface-container-high border-b border-outline rounded-none px-2 py-1 text-[10px] text-on-surface-variant uppercase tracking-widest focus:border-b-primary focus:outline-none"
                >
                  <option value="all">All Projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.slug}>{p.name}</option>
                  ))}
                </select>
              )}
              <label className="flex items-center gap-1.5 text-[10px] text-on-surface-variant uppercase tracking-widest cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={() => setAutoRefresh(!autoRefresh)}
                  className="h-3 w-3 rounded-sm border-outline-variant bg-transparent accent-white"
                />
                Live
              </label>
              <button
                onClick={refetch}
                disabled={isLoading}
                className="flex items-center gap-1.5 text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-50"
              >
                {isLoading
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

          {/* Stage Grid */}
          {isLoading && filteredIssues.length === 0 ? (
            <div className="bg-surface-container-low p-12 text-center rounded-sm">
              <Loader2 className="h-5 w-5 text-on-surface-variant mx-auto mb-3 animate-spin" />
              <p className="text-[10px] font-bold tracking-widest uppercase text-on-surface-variant">Loading issues...</p>
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-4 lg:grid lg:grid-cols-4 lg:overflow-x-visible">
              {PIPELINE_STAGES.map((stage) => {
                const stageIssues = filteredIssues.filter((i) => stage.statuses.includes(i.status));
                return (
                  <StageColumn
                    key={stage.key}
                    stage={stage}
                    issues={stageIssues}
                    stepStats={stepStats}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Stats Panel */}
        <div className="col-span-12 lg:col-span-4 overflow-y-auto space-y-4">
          <PipelineStatsPanel issues={filteredIssues} />
          <StepTimingPanel />
        </div>
      </div>

      {/* Footer Metric Bar */}
      <div className="sticky bottom-0 z-10 bg-background px-4 sm:px-6 md:px-8 py-4 border-t border-outline-variant/20 hidden md:flex flex-wrap gap-12">
        <div className="flex items-center gap-4">
          <Activity className="h-4 w-4 text-on-surface-variant" />
          <div>
            <div className="text-[10px] uppercase text-on-surface-variant tracking-widest font-bold">Total Issues</div>
            <div className="text-sm font-semibold text-on-surface tabular-nums">{filteredIssues.length}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <RefreshCw className="h-4 w-4 text-on-surface-variant" />
          <div>
            <div className="text-[10px] uppercase text-on-surface-variant tracking-widest font-bold">Auto-Refresh</div>
            <div className="text-sm font-semibold text-on-surface">{autoRefresh ? 'Enabled (30s)' : 'Disabled'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

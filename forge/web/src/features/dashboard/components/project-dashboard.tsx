'use client';

import Link from 'next/link';
import { useAttentionQueue } from '../hooks/use-attention-queue';
import { usePipelineActivity } from '../hooks/use-pipeline-activity';
import { AttentionQueue } from './attention-queue';
import { PipelineFeed } from './pipeline-feed';
import { DashboardStats } from './dashboard-stats';
import { useProject } from '@/features/project/hooks/use-projects';
import { List, PlusCircle, Kanban, MessageSquare } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

interface ProjectDashboardProps {
  slug: string;
}

export function ProjectDashboard({ slug }: ProjectDashboardProps) {
  const { groups, totalCount, isLoading } = useAttentionQueue(slug);
  const { running, queued, recentCompleted } = usePipelineActivity(slug);
  const { data: projectData } = useProject(slug);
  const pd = projectData?.data?.previewDeploy;
  const testingUrls = pd?.testingUrls?.length ? pd.testingUrls : [
    ...(pd?.stagingUrl ? [{ label: 'Frontend', url: pd.stagingUrl }] : []),
    ...(pd?.stagingApiUrl ? [{ label: 'API', url: pd.stagingApiUrl }] : []),
  ];

  return (
    <div className="flex-1 w-full max-w-[1600px] mx-auto p-4 sm:p-8 font-['Inter'] antialiased">
      {/* Quick Actions */}
      <div className="flex flex-wrap gap-2 mb-8">
        <Link
          href={`/projects/${slug}/issues`}
          className="bg-surface-container-low hover:bg-surface-container-high text-[10px] font-bold uppercase tracking-[0.15em] px-4 py-2 flex items-center gap-2 border border-outline-variant/20 transition-all text-on-surface"
        >
          <List className="h-3.5 w-3.5" />
          View Issues
        </Link>
        <Link
          href={`/projects/${slug}/issues/new`}
          className="bg-surface-container-low hover:bg-surface-container-high text-[10px] font-bold uppercase tracking-[0.15em] px-4 py-2 flex items-center gap-2 border border-outline-variant/20 transition-all text-on-surface"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          New Issue
        </Link>
        <Link
          href={`/projects/${slug}/board`}
          className="bg-surface-container-low hover:bg-surface-container-high text-[10px] font-bold uppercase tracking-[0.15em] px-4 py-2 flex items-center gap-2 border border-outline-variant/20 transition-all text-on-surface"
        >
          <Kanban className="h-3.5 w-3.5" />
          Task Board
        </Link>
        <Link
          href={`/projects/${slug}/agent`}
          className="bg-primary text-on-primary hover:bg-tertiary text-[10px] font-bold uppercase tracking-[0.15em] px-4 py-2 flex items-center gap-2 transition-all shadow-sm"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Agent Chat
        </Link>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Left column — Attention Queue */}
        <div className="col-span-12 lg:col-span-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
              Needs Your Attention
            </h2>
            {totalCount > 0 && (
              <span className="text-[10px] font-mono text-outline">
                {totalCount} item{totalCount !== 1 ? 's' : ''} waiting
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (
            <AttentionQueue
              groups={groups}
              slug={slug}
              testingUrls={testingUrls}
            />
          )}
        </div>

        {/* Right column — Stats + Pipeline Feed */}
        <div className="col-span-12 lg:col-span-4 space-y-6">
          <div>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant mb-4">
              Quick Stats
            </h2>
            <DashboardStats projectSlug={slug} attentionCount={totalCount} />
          </div>

          <div>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant mb-4">
              Pipeline Activity
            </h2>
            <div className="border border-outline-variant/20 rounded-sm bg-surface-container-low">
              <PipelineFeed running={running} queued={queued} recentCompleted={recentCompleted} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

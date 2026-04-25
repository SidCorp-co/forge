'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/layout/shell';
import { UsageDashboard } from '@/features/usage/components/usage-dashboard/usage-dashboard';
import { useProjects } from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { Skeleton } from '@/components/ui/skeleton';

export default function UsagePage() {
  useSetPageTitle('Usage');
  const { data: projects, isLoading } = useProjects();
  const [projectId, setProjectId] = useState<string | undefined>();

  useEffect(() => {
    if (!projectId && projects && projects.length > 0) {
      setProjectId(projects[0]?.id);
    }
  }, [projects, projectId]);

  return (
    <Shell>
      <div className="flex h-full flex-col overflow-y-auto">
        <div className="border-b border-outline-variant/30 bg-surface-container-low px-6 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-on-surface">Usage</h1>
              <p className="text-xs text-primary-fixed">
                Token usage and cost across CLI and chat sessions.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-primary-fixed">Project</label>
              <select
                value={projectId ?? ''}
                onChange={(e) => setProjectId(e.target.value || undefined)}
                className="rounded border border-outline-variant/30 bg-surface px-3 py-1.5 text-xs"
              >
                <option value="">All projects</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="flex-1 p-6">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-32" />
              <Skeleton className="h-64" />
            </div>
          ) : (
            <UsageDashboard projectId={projectId} />
          )}
        </div>
      </div>
    </Shell>
  );
}

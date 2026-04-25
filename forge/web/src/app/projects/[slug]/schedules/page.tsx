'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import {
  useSchedules,
  useCreateSchedule,
} from '@/features/schedule/hooks';
import { ScheduleForm, ScheduleList } from '@/features/schedule/components';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { formatApiError } from '@/lib/api/error';

export default function SchedulesPage() {
  useSetPageTitle('Schedules');
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  const { data: schedules, isLoading, error } = useSchedules(projectId);
  const createSchedule = useCreateSchedule();
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">Schedules</h1>
          <p className="text-sm text-primary-fixed">Run agent prompts on a recurring cadence.</p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/30 bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New schedule
          </button>
        )}
      </div>

      {creating && projectId && (
        <div className="rounded-sm border border-primary/30 bg-surface-container-low p-4">
          <ScheduleForm
            projectId={projectId}
            onSubmit={(data) =>
              createSchedule.mutate(data, {
                onSuccess: () => setCreating(false),
              })
            }
            onCancel={() => setCreating(false)}
            loading={createSchedule.isPending}
          />
          {createSchedule.error && (
            <p className="mt-2 text-[10px] uppercase tracking-widest text-error">
              {formatApiError(createSchedule.error)}
            </p>
          )}
        </div>
      )}

      {!projectId ? (
        <p className="text-sm text-primary-fixed">Loading project…</p>
      ) : isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : error ? (
        <p className="text-[10px] uppercase tracking-widest text-error">
          {formatApiError(error)}
        </p>
      ) : (
        <ScheduleList schedules={schedules ?? []} projectId={projectId} />
      )}
    </div>
  );
}

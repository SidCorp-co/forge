'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus, Clock } from 'lucide-react';
import { useProject } from '@/features/project/hooks/use-projects';
import { useSchedules, useCreateSchedule } from '@/features/schedule/hooks';
import { ScheduleList } from '@/features/schedule/components/schedule-list';
import { ScheduleForm } from '@/features/schedule/components/schedule-form';
import type { ScheduleFormData } from '@/features/schedule/api';

export default function SchedulesPage() {
  const { slug } = useParams<{ slug: string }>();
  const { data: projectData } = useProject(slug);
  const { data: schedulesData, isLoading } = useSchedules(slug);
  const createSchedule = useCreateSchedule();
  const [showForm, setShowForm] = useState(false);

  const project = projectData?.data;
  const schedules = schedulesData?.data ?? [];

  const handleCreate = (data: ScheduleFormData) => {
    createSchedule.mutate(data, { onSuccess: () => setShowForm(false) });
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Clock className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-bold text-on-surface">Schedules</h1>
            <p className="text-xs text-on-surface-variant">Recurring agent tasks for this project</p>
          </div>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-sm bg-primary text-on-primary hover:bg-tertiary transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Create Schedule
          </button>
        )}
      </div>

      {showForm && project && (
        <div className="rounded-sm border border-primary/30 bg-surface-container-low p-4 mb-4">
          <h2 className="text-sm font-semibold text-on-surface mb-3">New Schedule</h2>
          <ScheduleForm
            projectDocumentId={project.documentId}
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
            loading={createSchedule.isPending}
          />
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        project && <ScheduleList schedules={schedules} projectDocumentId={project.documentId} />
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Play, Trash2, Pencil, Clock, Loader2 } from 'lucide-react';
import type { Schedule, ScheduleFormData } from '../api';
import { useUpdateSchedule, useDeleteSchedule, useRunSchedule } from '../hooks';
import { ScheduleForm } from './schedule-form';

const STATUS_COLORS: Record<string, string> = {
  success: 'bg-success/10 text-success',
  failed: 'bg-danger/10 text-danger',
  running: 'bg-primary/10 text-primary',
  skipped: 'bg-outline-variant/20 text-outline-variant',
};

function formatRelativeTime(date: string | null): string {
  if (!date) return 'Never';
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface ScheduleListProps {
  schedules: Schedule[];
  projectDocumentId: string;
}

export function ScheduleList({ schedules, projectDocumentId }: ScheduleListProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const runSchedule = useRunSchedule();

  const handleToggle = (schedule: Schedule) => {
    updateSchedule.mutate({ id: schedule.documentId, data: { enabled: !schedule.enabled } });
  };

  const handleDelete = (id: string) => {
    if (confirm('Delete this schedule?')) {
      deleteSchedule.mutate(id);
    }
  };

  const handleRun = (id: string) => {
    runSchedule.mutate(id);
  };

  const handleUpdate = (id: string, data: ScheduleFormData) => {
    updateSchedule.mutate({ id, data }, { onSuccess: () => setEditing(null) });
  };

  if (schedules.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Clock className="h-10 w-10 text-outline-variant/40 mb-3" />
        <p className="text-sm text-on-surface-variant">No schedules yet</p>
        <p className="text-xs text-outline-variant mt-1">Create a schedule to run agent tasks on a recurring basis.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {schedules.map((schedule) => (
        <div key={schedule.documentId}>
          {editing === schedule.documentId ? (
            <div className="rounded-sm border border-primary/30 bg-surface-container-low p-4">
              <ScheduleForm
                initial={schedule}
                projectDocumentId={projectDocumentId}
                onSubmit={(data) => handleUpdate(schedule.documentId, data)}
                onCancel={() => setEditing(null)}
                loading={updateSchedule.isPending}
              />
            </div>
          ) : (
            <div className="rounded-sm border border-outline-variant/20 bg-surface-container-low p-4 hover:border-outline-variant/40 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-on-surface truncate">{schedule.name}</h3>
                    {schedule.lastStatus && (
                      <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded-sm ${STATUS_COLORS[schedule.lastStatus] || ''}`}>
                        {schedule.lastStatus}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <code className="text-[11px] font-mono text-on-surface-variant bg-surface-container-high px-1.5 py-0.5 rounded-sm">
                      {schedule.cron}
                    </code>
                    <span className="text-[11px] text-outline-variant">{schedule.runner}</span>
                    {schedule.targetProjectSlug && (
                      <span className="text-[11px] text-outline-variant">
                        &rarr; {schedule.targetProjectSlug}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-variant mt-1.5 line-clamp-2">{schedule.prompt}</p>
                  <div className="flex items-center gap-3 mt-2 text-[10px] text-outline-variant">
                    <span>Last run: {formatRelativeTime(schedule.lastRunAt)}</span>
                    {schedule.nextRunAt && (
                      <span>Next: {new Date(schedule.nextRunAt).toLocaleString()}</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleToggle(schedule)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      schedule.enabled ? 'bg-primary' : 'bg-outline-variant/40'
                    }`}
                    title={schedule.enabled ? 'Disable' : 'Enable'}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                        schedule.enabled ? 'translate-x-4.5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                  <button
                    onClick={() => handleRun(schedule.documentId)}
                    disabled={runSchedule.isPending}
                    className="p-1.5 text-on-surface-variant hover:text-primary transition-colors"
                    title="Run now"
                  >
                    {runSchedule.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => setEditing(schedule.documentId)}
                    className="p-1.5 text-on-surface-variant hover:text-primary transition-colors"
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(schedule.documentId)}
                    className="p-1.5 text-on-surface-variant hover:text-danger transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

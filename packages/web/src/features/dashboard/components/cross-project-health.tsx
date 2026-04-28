'use client';

import { useProjectHealth } from '../hooks/use-project-health';
import type { ProjectHealth } from '../api';
import { AlertTriangle, TrendingUp, Clock, Layers } from 'lucide-react';

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-500',
  confirmed: 'bg-indigo-500',
  approved: 'bg-violet-500',
  in_progress: 'bg-amber-500',
  developed: 'bg-emerald-500',
  testing: 'bg-cyan-500',
  closed: 'bg-gray-400',
  reopen: 'bg-red-500',
  waiting: 'bg-yellow-500',
};

function StatusBar({ distribution }: { distribution: Record<string, number> }) {
  const total = Object.values(distribution).reduce((a, b) => a + b, 0);
  if (total === 0) return <div className="h-2 rounded-full bg-surface-variant" />;

  return (
    <div className="flex h-2 rounded-full overflow-hidden gap-px">
      {Object.entries(distribution).map(([status, count]) => (
        <div
          key={status}
          className={`${STATUS_COLORS[status] || 'bg-gray-300'}`}
          style={{ width: `${(count / total) * 100}%` }}
          title={`${status}: ${count}`}
        />
      ))}
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectHealth }) {
  const hasBlockers = project.blockers.length > 0;
  const hasEscalations = project.pendingEscalations > 0;

  return (
    <div className="rounded-lg border border-outline-variant bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-on-surface">{project.projectName}</h3>
        <div className="flex gap-1">
          {hasBlockers && (
            <span className="px-1.5 py-0.5 rounded text-xs bg-red-500/10 text-red-500 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {project.blockers.length}
            </span>
          )}
          {hasEscalations && (
            <span className="px-1.5 py-0.5 rounded text-xs bg-yellow-500/10 text-yellow-600">
              {project.pendingEscalations} escalation{project.pendingEscalations > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      <StatusBar distribution={project.statusDistribution} />

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="flex items-center justify-center gap-1 text-on-surface-variant text-xs">
            <TrendingUp className="h-3 w-3" />
            <span>Throughput</span>
          </div>
          <div className="text-lg font-semibold text-on-surface">{project.throughput}/wk</div>
        </div>
        <div>
          <div className="flex items-center justify-center gap-1 text-on-surface-variant text-xs">
            <Layers className="h-3 w-3" />
            <span>Active</span>
          </div>
          <div className="text-lg font-semibold text-on-surface">{project.totalActive}</div>
        </div>
        <div>
          <div className="flex items-center justify-center gap-1 text-on-surface-variant text-xs">
            <Clock className="h-3 w-3" />
            <span>Cycle</span>
          </div>
          <div className="text-lg font-semibold text-on-surface">{project.avgCycleTimeDays}d</div>
        </div>
      </div>

      {hasBlockers && (
        <div className="text-xs text-on-surface-variant">
          <span className="font-medium text-red-500">Blocked: </span>
          {project.blockers.map((b) => b.issueId).join(', ')}
        </div>
      )}
    </div>
  );
}

export function CrossProjectHealth() {
  const { data: projects, isLoading } = useProjectHealth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-on-surface-variant">
        Loading project health...
      </div>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-on-surface-variant">
        No projects found.
      </div>
    );
  }

  // Aggregate stats
  const totalThroughput = projects.reduce((sum, p) => sum + p.throughput, 0);
  const totalActive = projects.reduce((sum, p) => sum + p.totalActive, 0);
  const totalBlockers = projects.reduce((sum, p) => sum + p.blockers.length, 0);
  const totalEscalations = projects.reduce((sum, p) => sum + p.pendingEscalations, 0);

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-outline-variant bg-surface p-3 text-center">
          <div className="text-xs text-on-surface-variant">Projects</div>
          <div className="text-2xl font-bold text-on-surface">{projects.length}</div>
        </div>
        <div className="rounded-lg border border-outline-variant bg-surface p-3 text-center">
          <div className="text-xs text-on-surface-variant">Throughput</div>
          <div className="text-2xl font-bold text-on-surface">{totalThroughput}/wk</div>
        </div>
        <div className="rounded-lg border border-outline-variant bg-surface p-3 text-center">
          <div className="text-xs text-on-surface-variant">Active Issues</div>
          <div className="text-2xl font-bold text-on-surface">{totalActive}</div>
        </div>
        <div className="rounded-lg border border-outline-variant bg-surface p-3 text-center">
          <div className="text-xs text-on-surface-variant">Blockers</div>
          <div className={`text-2xl font-bold ${totalBlockers > 0 ? 'text-red-500' : 'text-on-surface'}`}>
            {totalBlockers}
          </div>
        </div>
      </div>

      {totalEscalations > 0 && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 flex items-center gap-2 text-sm text-yellow-600">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {totalEscalations} pending CTO escalation{totalEscalations > 1 ? 's' : ''} across projects
        </div>
      )}

      {/* Project cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <ProjectCard key={project.projectSlug} project={project} />
        ))}
      </div>
    </div>
  );
}

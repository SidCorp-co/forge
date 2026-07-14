// "Which project is overloaded" (ISS-665) — per-project top-N workload rows,
// replacing the single workspace-wide aggregate bar (which could only answer
// "how much work, workspace-wide" — never which project). Absorbs Spotlight's
// project-level signal (health dot + live-runs) into the same row, ranked
// needs-attention first then most in-flight work (`perProjectWorkload`).
import { Card, CardContent, HealthDot, Icon, ProjectMark } from '@/design';
import { projectGlyph, projectInitials } from '@/features/projects/glyph';
import type { ProjectWorkload } from '../derive';

function WorkloadRow({
  workload,
  onOpen,
}: {
  workload: ProjectWorkload;
  onOpen: (slug: string) => void;
}) {
  const { project, buckets, total } = workload;
  const g = projectGlyph(project.id);
  const active = buckets.filter((b) => b.count > 0);

  return (
    <button
      type="button"
      onClick={() => onOpen(project.slug)}
      className="flex w-full items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
    >
      <ProjectMark tint={g.tint} ink={g.ink} initials={projectInitials(project.name)} size={26} radius="var(--r-sm)" />
      <span className="min-w-0 flex-1">
        <span className="fg-body-sm flex items-center gap-2 truncate font-semibold text-fg">
          {project.name}
          {project.liveRuns > 0 && (
            <span className="inline-flex items-center gap-1 font-normal text-accent-text">
              <span className="forge-pulse inline-block size-[6px] rounded-pill bg-accent" aria-hidden />
              {project.liveRuns} live
            </span>
          )}
        </span>
        {total === 0 ? (
          <span className="fg-caption text-subtle">No in-flight work</span>
        ) : (
          <span className="mt-1 flex h-1.5 w-full max-w-[220px] overflow-hidden rounded-pill bg-[var(--paper-200)]">
            {active.map((b) => (
              <span
                key={b.key}
                className="h-full first:rounded-l-pill last:rounded-r-pill"
                style={{ width: `${(b.count / total) * 100}%`, background: b.color }}
                title={`${b.label}: ${b.count}`}
              />
            ))}
          </span>
        )}
      </span>
      <span className="font-mono text-[12.5px] font-semibold text-subtle">{total}</span>
      <HealthDot health={project.health} withLabel={false} />
      <Icon name="chevronRight" size={14} className="flex-none text-subtle" />
    </button>
  );
}

export function WorkDistribution({
  workloads,
  onOpen,
  onViewAll,
}: {
  workloads: ProjectWorkload[];
  onOpen: (slug: string) => void;
  onViewAll: () => void;
}) {
  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="board" size={16} className="text-subtle" />
          <h3 className="fg-h3">Work distribution</h3>
        </div>
        <button
          type="button"
          onClick={onViewAll}
          className="fg-caption inline-flex items-center gap-1 rounded-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          View all
          <Icon name="arrowRight" size={13} />
        </button>
      </div>

      <CardContent className="flex-1">
        {workloads.length === 0 ? (
          <p className="fg-body-sm py-6 text-center text-subtle">No projects to show yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {workloads.map((w) => (
              <WorkloadRow key={w.project.id} workload={w} onOpen={onOpen} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

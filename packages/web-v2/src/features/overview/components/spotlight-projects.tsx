// A ranked, capped subset of projects (attention-first, then recent activity) —
// NOT the flat list. Compact rows: health dot · mark · name · live runs · open
// issues · last activity. Header links to the full `/projects` console.
import { Card, CardContent, HealthDot, Icon, ProjectMark } from '@/design';
import { formatRelativeTime } from '@/features/projects/derive';
import { projectGlyph, projectInitials } from '@/features/projects/glyph';
import type { ProjectConsoleItem } from '@/features/projects/types';

function SpotlightRow({
  project,
  now,
  onOpen,
}: {
  project: ProjectConsoleItem;
  now: number;
  onOpen: (slug: string) => void;
}) {
  const g = projectGlyph(project.id);
  return (
    <button
      type="button"
      onClick={() => onOpen(project.slug)}
      className="flex w-full items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
    >
      <ProjectMark tint={g.tint} ink={g.ink} initials={projectInitials(project.name)} size={26} radius="var(--r-sm)" />
      <span className="min-w-0 flex-1">
        <span className="fg-body-sm block truncate font-semibold text-fg">{project.name}</span>
        <span className="fg-caption flex items-center gap-2 text-subtle">
          {project.liveRuns > 0 && (
            <span className="inline-flex items-center gap-1 text-accent-text">
              <span className="forge-pulse inline-block size-[6px] rounded-pill bg-accent" aria-hidden />
              {project.liveRuns} live
            </span>
          )}
          <span className="font-mono">{project.openIssues} active</span>
          <span className="font-mono">{formatRelativeTime(project.lastActivityAt, now)}</span>
        </span>
      </span>
      <HealthDot health={project.health} withLabel={false} />
      <Icon name="chevronRight" size={14} className="flex-none text-subtle" />
    </button>
  );
}

export function SpotlightProjects({
  projects,
  now,
  onOpen,
  onViewAll,
}: {
  projects: ProjectConsoleItem[];
  now: number;
  onOpen: (slug: string) => void;
  onViewAll: () => void;
}) {
  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="grid" size={16} className="text-subtle" />
          <h3 className="fg-h3">Spotlight projects</h3>
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
        {projects.length === 0 ? (
          <p className="fg-body-sm py-6 text-center text-subtle">No projects to spotlight.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {projects.map((p) => (
              <SpotlightRow key={p.id} project={p} now={now} onOpen={onOpen} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

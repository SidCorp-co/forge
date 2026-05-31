'use client';

// Single project card for the Cards view. The whole card links into the
// project; the pin star is an inline button that doesn't trigger navigation.
import Link from 'next/link';
import { HealthDot, Icon, ProjectMark, Stat } from '@/design';
import { cn } from '@/lib/utils/cn';
import { formatRelativeTime, formatSpend } from '../derive';
import { projectGlyph, projectInitials } from '../glyph';
import type { ProjectConsoleItem } from '../types';
import { LiveCount } from './live-count';
import { MemberStack } from './member-stack';

export interface ProjectCardProps {
  project: ProjectConsoleItem;
  now: number;
  onTogglePin: (id: string) => void;
}

export function ProjectCard({ project, now, onTogglePin }: ProjectCardProps) {
  const glyph = projectGlyph(project.id);
  return (
    <Link
      href={`/projects/${project.slug}`}
      className={cn(
        'group flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-sm',
        'transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-md',
      )}
    >
      <div className="flex items-start gap-3">
        <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={projectInitials(project.name)} size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[14px] font-semibold text-fg">{project.name}</span>
            <button
              type="button"
              aria-label={project.pinned ? 'Unpin project' : 'Pin project'}
              aria-pressed={project.pinned}
              className="flex-none rounded-sm p-0.5 text-subtle hover:text-amber"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onTogglePin(project.id);
              }}
            >
              <Icon
                name="star"
                size={13}
                className={project.pinned ? 'text-amber' : ''}
                style={project.pinned ? { fill: 'currentColor' } : undefined}
              />
            </button>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-subtle">
            <Icon name="github" size={12} />
            <span className="truncate font-mono text-[11.5px]">{project.repoPath ?? '—'}</span>
          </div>
        </div>
        <HealthDot health={project.health} withLabel={false} />
      </div>

      <p className="m-0 line-clamp-1 min-h-[19px] text-[13px] leading-snug text-muted">
        {project.description ?? ' '}
      </p>

      <div className="flex items-center gap-3.5 border-t border-line-subtle pt-3">
        <LiveCount n={project.liveRuns} />
        <Stat icon="inbox" title="In-flight issues (not closed)">
          {project.openIssues}
        </Stat>
        <Stat icon="server" title="Online runners">
          {project.runnerCount}
        </Stat>
        <Stat icon="dollar" title="Trailing 24h spend">
          {formatSpend(project.spend24hUsd)}
        </Stat>
        <span className="ml-auto flex items-center gap-2.5">
          <MemberStack members={project.members} total={project.memberCount} />
          <span className="font-mono text-[11px] text-subtle">
            {formatRelativeTime(project.lastActivityAt, now)}
          </span>
        </span>
      </div>
    </Link>
  );
}

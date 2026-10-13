'use client';

// List view — the design DataTable. Rows navigate into the project; the pin
// star is an inline button that doesn't trigger navigation. The console has
// already filtered and ordered the rows (the cards show the same ones), so the
// table only reports which header the user asked to sort by.
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { DataTable, type DataTableColumn, HealthDot, Icon, ProjectMark, Stat } from '@/design';
import { OPEN_WORK_LABEL } from '@forge/contracts/work-state';
import { FIRST_DESC, SORT_COLUMNS, toProjectSort } from '../columns';
import { formatRelativeTime, formatSpend } from '../derive';
import { projectGlyph, projectInitials } from '../glyph';
import type { ProjectConsoleItem, ProjectSort, ProjectSortState } from '../types';
import { LiveCount } from './live-count';
import { MemberStack } from './member-stack';
import { ReadFigure } from './read-figure';

export interface ProjectListProps {
  items: readonly ProjectConsoleItem[];
  now: number;
  onTogglePin: (id: string) => void;
  sort: ProjectSortState;
  onSortChange: (sort: ProjectSortState) => void;
}

function sortable(id: ProjectSort) {
  return { ...SORT_COLUMNS[id], firstSort: FIRST_DESC[id] ? ('desc' as const) : ('asc' as const) };
}

export function ProjectList({ items, now, onTogglePin, sort, onSortChange }: ProjectListProps) {
  const router = useRouter();
  const columns = useMemo<DataTableColumn<ProjectConsoleItem>[]>(
    () => [
      {
        ...sortable('name'),
        header: 'Project',
        sticky: true,
        cell: (p) => {
          const glyph = projectGlyph(p.id);
          return (
            <span className="flex items-center gap-2.5">
              <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={projectInitials(p.name)} size={28} radius="var(--r-sm)" />
              <span className="max-w-[9rem] truncate font-mono text-13-5 font-semibold text-fg sm:max-w-[16rem]">{p.name}</span>
              <button
                type="button"
                aria-label={p.pinned ? 'Unpin project' : 'Pin project'}
                aria-pressed={p.pinned}
                className="flex-none rounded-sm p-0.5 text-subtle hover:text-amber"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin(p.id);
                }}
              >
                <Icon
                  name="star"
                  size={12}
                  className={p.pinned ? 'text-amber' : ''}
                  style={p.pinned ? { fill: 'currentColor' } : undefined}
                />
              </button>
            </span>
          );
        },
      },
      {
        id: 'description',
        header: 'Description',
        cellClassName: 'max-w-[1px] truncate text-muted',
        cell: (p) =>
          p.healthRead === 'read' ? (
            (p.description ?? '—')
          ) : (
            <ReadFigure value={null} read={p.healthRead} subject="the description" />
          ),
      },
      {
        ...sortable('health'),
        header: 'Health',
        cell: (p) =>
          p.health ? (
            <HealthDot health={p.health} />
          ) : (
            <ReadFigure value={null} read={p.healthRead} subject="the project's health" />
          ),
      },
      { id: 'runs', header: 'Runs', cell: (p) => <LiveCount n={p.liveRuns} read={p.healthRead} /> },
      {
        id: 'issues',
        header: 'Issues',
        cell: (p) => (
          <Stat icon="inbox">
            <ReadFigure value={p.openIssues} read={p.healthRead} counts={`in ${OPEN_WORK_LABEL.toLowerCase()}`} />
          </Stat>
        ),
      },
      {
        id: 'runners',
        header: 'Runners',
        cell: (p) => (
          <Stat icon="server">
            <ReadFigure value={p.runnerCount} read={p.healthRead} counts="runners" />
          </Stat>
        ),
      },
      {
        id: 'spend',
        header: 'Spend',
        align: 'end',
        cellClassName: 'font-mono text-12 text-subtle',
        cell: (p) => (
          <ReadFigure value={p.spend24hUsd} read={p.healthRead} counts="dollars spent in 24h">
            {formatSpend}
          </ReadFigure>
        ),
      },
      {
        ...sortable('recent'),
        header: 'Active',
        align: 'end',
        cellClassName: 'font-mono text-12 text-subtle',
        cell: (p) =>
          p.healthRead === 'read' ? (
            formatRelativeTime(p.lastActivityAt, now)
          ) : (
            <ReadFigure value={null} read={p.healthRead} subject="the last activity" />
          ),
      },
      {
        id: 'team',
        header: 'Team',
        align: 'end',
        cell: (p) => (
          <span className="flex justify-end">
            {p.memberCount === null ? (
              <ReadFigure value={null} read={p.healthRead} subject="the team" />
            ) : (
              <MemberStack members={p.members} total={p.memberCount} size={22} />
            )}
          </span>
        ),
      },
    ],
    [now, onTogglePin],
  );

  return (
    <DataTable
      aria-label="Projects"
      rows={items}
      columns={columns}
      getRowId={(p) => p.id}
      sort={sort}
      onSortChange={(s) => onSortChange(toProjectSort(s))}
      manualSort
      manualFilter
      rowProps={(p) => ({ className: 'cursor-pointer', onClick: () => router.push(`/projects/${p.slug}`) })}
    />
  );
}

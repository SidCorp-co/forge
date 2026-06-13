'use client';

// Console toolbar: search · sort · Cards⇄List · New project.
// Org scope lives in the global org switcher (app chrome, ISS-469) — not here —
// so there is no standalone org filter or "Manage organizations" link; that
// would contradict the global active-org selection.
import { Button, Input, SegmentedControl, Select, type SegmentOption } from '@/design';
import type { ProjectSort, ProjectView } from '../types';

const SORT_OPTIONS = [
  { value: 'recent', label: 'Recently active', icon: 'clock' as const },
  { value: 'name', label: 'Name (A–Z)', icon: 'list' as const },
  { value: 'health', label: 'Health', icon: 'activity' as const },
];

const VIEW_OPTIONS: SegmentOption<ProjectView>[] = [
  { value: 'cards', icon: 'grid', label: 'Cards' },
  { value: 'list', icon: 'rows', label: 'List' },
];

export interface ProjectsToolbarProps {
  query: string;
  onQuery: (q: string) => void;
  sort: ProjectSort;
  onSort: (s: ProjectSort) => void;
  view: ProjectView;
  onView: (v: ProjectView) => void;
  onNewProject: () => void;
}

export function ProjectsToolbar({
  query,
  onQuery,
  sort,
  onSort,
  view,
  onView,
  onNewProject,
}: ProjectsToolbarProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2.5">
      <Input
        icon="search"
        className="min-w-[220px] max-w-[380px] flex-1"
        placeholder="Search projects…"
        aria-label="Search projects"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <Select
        className="w-[188px]"
        options={SORT_OPTIONS}
        value={sort}
        onChange={(v) => onSort(v as ProjectSort)}
        aria-label="Sort projects"
      />
      <SegmentedControl options={VIEW_OPTIONS} value={view} onChange={onView} />
      <Button variant="primary" icon="plus" className="ml-auto" onClick={onNewProject}>
        New project
      </Button>
    </div>
  );
}

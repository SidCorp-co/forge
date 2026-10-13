'use client';

// Console toolbar: search · sort · Cards⇄List · New project.
// Org scope lives in the global org switcher (app chrome, ISS-469) — not here —
// so there is no standalone org filter or "Manage organizations" link; that
// would contradict the global active-org selection.
import { Button, Input, SegmentedControl, Select, type SegmentOption } from '@/design';
import { FIRST_DESC } from '../columns';
import type { ProjectSort, ProjectSortState, ProjectView } from '../types';

// What each sort is called going each way, so the select always names the direction the list is in.
const SORT_LABELS: Record<ProjectSort, { asc: string; desc: string; icon: 'clock' | 'list' | 'activity' }> = {
  recent: { desc: 'Recently active', asc: 'Least recently active', icon: 'clock' },
  name: { asc: 'Name (A–Z)', desc: 'Name (Z–A)', icon: 'list' },
  health: { asc: 'Health (worst first)', desc: 'Health (best first)', icon: 'activity' },
};

/** The sort menu's rows: the chosen sort reads the way round the list is in, the others the way they would start. */
export function sortOptions(sort: ProjectSortState) {
  return (Object.keys(SORT_LABELS) as ProjectSort[]).map((id) => {
    const { asc, desc, icon } = SORT_LABELS[id];
    const isDesc = id === sort.id ? sort.desc : FIRST_DESC[id];
    return { value: id, label: isDesc ? desc : asc, icon };
  });
}

const VIEW_OPTIONS: SegmentOption<ProjectView>[] = [
  { value: 'cards', icon: 'grid', label: 'Cards' },
  { value: 'list', icon: 'rows', label: 'List' },
];

export interface ProjectsToolbarProps {
  query: string;
  onQuery: (q: string) => void;
  sort: ProjectSortState;
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
        options={sortOptions(sort)}
        value={sort.id}
        onChange={(v) => v !== sort.id && onSort(v as ProjectSort)}
        aria-label="Sort projects"
      />
      <SegmentedControl options={VIEW_OPTIONS} value={view} onChange={onView} />
      <Button variant="primary" icon="plus" className="ml-auto" onClick={onNewProject}>
        New project
      </Button>
    </div>
  );
}

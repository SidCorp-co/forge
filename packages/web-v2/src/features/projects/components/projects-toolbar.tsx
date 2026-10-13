'use client';

// Console toolbar: search · sort · Cards⇄List · New project.
// Org scope lives in the global org switcher (app chrome, ISS-469) — not here —
// so there is no standalone org filter or "Manage organizations" link; that
// would contradict the global active-org selection.
import { Button, Input, SegmentedControl, Select, type SegmentOption } from '@/design';
import { FIRST_DESC } from '../columns';
import type { ProjectSort, ProjectSortState, ProjectView } from '../types';

// What each sort is called going each way. Every sort is offered both ways, so a direction the list is
// not in is one choice away whichever header put it there.
const SORT_LABELS: Record<ProjectSort, { asc: string; desc: string; icon: 'clock' | 'list' | 'activity' }> = {
  recent: { desc: 'Recently active', asc: 'Least recently active', icon: 'clock' },
  name: { asc: 'Name (A–Z)', desc: 'Name (Z–A)', icon: 'list' },
  health: { asc: 'Health (worst first)', desc: 'Health (best first)', icon: 'activity' },
};

const SORT_ORDER: readonly ProjectSort[] = ['recent', 'name', 'health'];

const sortValue = (id: ProjectSort, desc: boolean) => `${id}:${desc ? 'desc' : 'asc'}`;

/** The sort menu's rows: each sort going each way, the way it starts first. */
export function sortOptions() {
  return SORT_ORDER.flatMap((id) => {
    const { asc, desc, icon } = SORT_LABELS[id];
    const rows = [
      { value: sortValue(id, true), label: desc, icon },
      { value: sortValue(id, false), label: asc, icon },
    ];
    return FIRST_DESC[id] ? rows : rows.reverse();
  });
}

/** The row of `sortOptions` that names the way round the list is in. */
export function sortSelectValue(sort: ProjectSortState): string {
  return sortValue(sort.id, sort.desc);
}

function parseSort(value: string): ProjectSortState {
  const [id, direction] = value.split(':');
  if (!SORT_ORDER.includes(id as ProjectSort) || (direction !== 'asc' && direction !== 'desc')) {
    throw new Error(`The sort menu offered "${value}", which is not a sort and a direction: expected recent, name or health, then asc or desc.`);
  }
  return { id: id as ProjectSort, desc: direction === 'desc' };
}

const VIEW_OPTIONS: SegmentOption<ProjectView>[] = [
  { value: 'cards', icon: 'grid', label: 'Cards' },
  { value: 'list', icon: 'rows', label: 'List' },
];

export interface ProjectsToolbarProps {
  query: string;
  onQuery: (q: string) => void;
  sort: ProjectSortState;
  onSort: (s: ProjectSortState) => void;
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
        options={sortOptions()}
        value={sortSelectValue(sort)}
        onChange={(v) => onSort(parseSort(v))}
        aria-label="Sort projects"
      />
      <SegmentedControl options={VIEW_OPTIONS} value={view} onChange={onView} />
      <Button variant="primary" icon="plus" className="ml-auto" onClick={onNewProject}>
        New project
      </Button>
    </div>
  );
}

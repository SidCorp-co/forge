// What the projects console sorts, searches and filters by; cards and table both read through it.
import type { DataTableModelColumn } from '@/design';
import { isAttention } from './derive';
import type { ProjectConsoleItem, ProjectSort, ProjectSortState } from './types';

// Worst health sorts first; a project whose health was not read has no key, so it is last either way round.
const HEALTH_RANK = { down: 0, attention: 1, healthy: 2, idle: 3 } as const;

function recency(item: ProjectConsoleItem): number | null {
  return item.healthRead === 'read' && item.lastActivityAt ? Date.parse(item.lastActivityAt) : null;
}

type Column = DataTableModelColumn<ProjectConsoleItem>;

/** The three sortable columns, by the id a `ProjectSort` names. */
export const SORT_COLUMNS: Record<ProjectSort, Column> = {
  name: { id: 'name', sortValue: (p) => p.name, searchText: (p) => p.name },
  health: {
    id: 'health',
    sortValue: (p) => (p.healthRead === 'read' && p.health ? [HEALTH_RANK[p.health], -(recency(p) ?? 0)] : null),
  },
  recent: { id: 'recent', sortValue: recency },
};

// The repository and description come from the health rollup: unread, they are not searched.
const SEARCH_COLUMNS: Column[] = [
  { id: 'org', searchText: (p) => p.orgName },
  { id: 'repo', searchText: (p) => (p.healthRead === 'read' ? p.repoPath : null) },
  { id: 'description', searchText: (p) => (p.healthRead === 'read' ? p.description : null) },
];

const ATTENTION_COLUMN: Column = { id: 'attention', filterValue: (p) => (isAttention(p) ? 'yes' : 'no') };

export const PROJECT_MODEL_COLUMNS: Column[] = [...Object.values(SORT_COLUMNS), ...SEARCH_COLUMNS, ATTENTION_COLUMN];

/** The direction each sort starts in: newest activity first, worst health first, names A to Z. */
export const FIRST_DESC: Record<ProjectSort, boolean> = { recent: true, health: false, name: false };

export const DEFAULT_PROJECT_SORT: ProjectSortState = { id: 'recent', desc: FIRST_DESC.recent };

export function isDefaultSort(sort: ProjectSortState): boolean {
  return sort.id === DEFAULT_PROJECT_SORT.id && sort.desc === DEFAULT_PROJECT_SORT.desc;
}

export function toProjectSort(sort: { id: string; desc: boolean }): ProjectSortState {
  if (sort.id !== 'recent' && sort.id !== 'name' && sort.id !== 'health') {
    throw new Error(`The projects console cannot sort by "${sort.id}": its sorts are recent, name and health.`);
  }
  return { id: sort.id, desc: sort.desc };
}

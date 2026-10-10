'use client';

// Console toolbar: search · sort · Cards⇄List · New project.
// Org scope lives in the global org switcher (app chrome, ISS-469) — not here —
// so there is no standalone org filter or "Manage organizations" link; that
// would contradict the global active-org selection.
import { Button, Input, SegmentedControl, Select, type SegmentOption } from '@/design';
import { useCopy } from '@/lib/i18n/interface-language';
import type { ProjectSort, ProjectView } from '../types';


interface ProjectsToolbarProps {
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
  const t = useCopy();
  const sortOptions = [
    { value: 'recent', label: t('projects.sort.recent'), icon: 'clock' as const },
    { value: 'name', label: t('projects.sort.name'), icon: 'list' as const },
    { value: 'health', label: t('projects.sort.health'), icon: 'activity' as const },
  ];
  const viewOptions: SegmentOption<ProjectView>[] = [
    { value: 'cards', icon: 'grid', label: t('projects.view.cards') },
    { value: 'list', icon: 'rows', label: t('projects.view.list') },
  ];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2.5">
      <Input
        icon="search"
        className="min-w-55 max-w-95 flex-1"
        placeholder={t('projects.searchPlaceholder')}
        aria-label={t('projects.search')}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <Select
        className="w-47"
        options={sortOptions}
        value={sort}
        onChange={(v) => onSort(v as ProjectSort)}
        aria-label={t('projects.sortLabel')}
      />
      <SegmentedControl options={viewOptions} value={view} onChange={onView} />
      <Button variant="primary" icon="plus" className="ml-auto" onClick={onNewProject}>
        {t('projects.new')}
      </Button>
    </div>
  );
}

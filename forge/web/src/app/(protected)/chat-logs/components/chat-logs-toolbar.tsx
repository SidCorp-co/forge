'use client';

import { Filter, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useProjects } from '@/features/project/hooks/use-projects';

const INTENT_OPTIONS = [
  { value: 'all', label: 'All Intents' },
  { value: 'SEARCH', label: 'Search' },
  { value: 'LOOKUP', label: 'Lookup' },
  { value: 'CREATE', label: 'Create' },
  { value: 'SUMMARY', label: 'Summary' },
  { value: 'ACTION', label: 'Action' },
  { value: 'CHAT', label: 'Chat' },
];

const SOURCE_OPTIONS = [
  { value: 'all', label: 'All Sources' },
  { value: 'web', label: 'Web' },
  { value: 'widget', label: 'Widget' },
  { value: 'api', label: 'API' },
];

const RATING_OPTIONS = [
  { value: 'all', label: 'All Ratings' },
  { value: 'good', label: 'Good' },
  { value: 'bad', label: 'Bad' },
  { value: 'flagged', label: 'Flagged' },
  { value: 'unrated', label: 'Unrated' },
];

interface ChatLogsToolbarProps {
  projectSlug: string;
  intent: string;
  source: string;
  qaRating: string;
  dateFrom: string;
  dateTo: string;
  activeFilterCount: number;
  onFilterChange: (key: string, value: string) => void;
  onClearFilters: () => void;
}

export function ChatLogsToolbar({
  projectSlug,
  intent,
  source,
  qaRating,
  dateFrom,
  dateTo,
  activeFilterCount,
  onFilterChange,
  onClearFilters,
}: ChatLogsToolbarProps) {
  const { data: projectsData } = useProjects();
  const projects = projectsData?.data ?? [];

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 text-xs text-primary-fixed">
        <Filter className="h-3.5 w-3.5" />
        <span>Filters</span>
      </div>

      <select
        value={projectSlug}
        onChange={(e) => onFilterChange('projectSlug', e.target.value)}
        className="rounded border border-outline-variant/30 bg-surface-container-low px-2.5 py-1.5 text-xs text-on-surface-variant focus:outline-none focus:ring-1 focus:ring-outline-variant"
      >
        <option value="all">All Projects</option>
        {projects.map((p) => (
          <option key={p.slug} value={p.slug}>{p.name}</option>
        ))}
      </select>

      <select
        value={intent}
        onChange={(e) => onFilterChange('intent', e.target.value)}
        className="rounded border border-outline-variant/30 bg-surface-container-low px-2.5 py-1.5 text-xs text-on-surface-variant focus:outline-none focus:ring-1 focus:ring-outline-variant"
      >
        {INTENT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      <select
        value={source}
        onChange={(e) => onFilterChange('source', e.target.value)}
        className="rounded border border-outline-variant/30 bg-surface-container-low px-2.5 py-1.5 text-xs text-on-surface-variant focus:outline-none focus:ring-1 focus:ring-outline-variant"
      >
        {SOURCE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      <select
        value={qaRating}
        onChange={(e) => onFilterChange('qaRating', e.target.value)}
        className="rounded border border-outline-variant/30 bg-surface-container-low px-2.5 py-1.5 text-xs text-on-surface-variant focus:outline-none focus:ring-1 focus:ring-outline-variant"
      >
        {RATING_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      <div className="flex items-center gap-1">
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => onFilterChange('dateFrom', e.target.value)}
          className="rounded border border-outline-variant/30 bg-surface-container-low px-2 py-1.5 text-xs text-on-surface-variant focus:outline-none focus:ring-1 focus:ring-outline-variant"
          placeholder="From"
        />
        <span className="text-xs text-outline">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => onFilterChange('dateTo', e.target.value)}
          className="rounded border border-outline-variant/30 bg-surface-container-low px-2 py-1.5 text-xs text-on-surface-variant focus:outline-none focus:ring-1 focus:ring-outline-variant"
          placeholder="To"
        />
      </div>

      {activeFilterCount > 0 && (
        <button
          onClick={onClearFilters}
          className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-primary-fixed hover:bg-surface-container-high hover:text-on-surface-variant"
        >
          <X className="h-3 w-3" />
          Clear ({activeFilterCount})
        </button>
      )}
    </div>
  );
}

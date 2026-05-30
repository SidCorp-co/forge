'use client';

// The /v2/projects workspace console. Orchestrates stats band, toolbar,
// attention banner, pinned + all-projects sections, the new-project tile, and
// the loading / empty / error states. All data flows through
// `useProjectsConsole`; all derivation lives in `derive.ts`.
import { useEffect, useMemo, useState } from 'react';
import {
  EmptyState,
  ErrorState,
  Icon,
  type IconName,
  Kicker,
  ProjectCardSkeleton,
} from '@/design';
import { formatApiError } from '@/lib/api/error';
import { useToast } from '@/providers/toast-provider';
import { filterProjects, isAttention, sortProjects } from '../derive';
import { useProjectsConsole } from '../hooks';
import type { ProjectConsoleItem, ProjectSort, ProjectView } from '../types';
import { AttentionBanner } from './attention-banner';
import { NewProjectTile } from './new-project-tile';
import { ProjectCard } from './project-card';
import { ProjectList } from './project-list';
import { ProjectsToolbar } from './projects-toolbar';
import { StatsBand } from './stats-band';

function SectionLabel({
  icon,
  iconClassName,
  count,
  children,
}: {
  icon: IconName;
  iconClassName?: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-0.5 mb-3 mt-1 flex items-center gap-2">
      <Icon name={icon} size={15} className={iconClassName ?? 'text-subtle'} />
      <Kicker>{children}</Kicker>
      {count != null && <span className="font-mono text-[11px] text-subtle">{count}</span>}
    </div>
  );
}

export function ProjectsConsole() {
  const { items, totals, isLoading, isError, error, refetch, toggle } = useProjectsConsole();
  const { toast } = useToast();

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [view, setView] = useState<ProjectView>('cards');
  const [attentionOnly, setAttentionOnly] = useState(false);

  // Relative timestamps: 0 on the server + first paint (renders "just now"),
  // then the real clock after mount — hydration-safe.
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Date.now()), []);

  const attentionCount = useMemo(() => items.filter(isAttention).length, [items]);

  const visible = useMemo(
    () => sortProjects(filterProjects(items, query, attentionOnly), sort),
    [items, query, attentionOnly, sort],
  );

  // When searching/filtering/sorting, collapse the pinned section into one flat
  // result list (so a pinned match isn't hidden from the "rest").
  const searching = query.trim() !== '' || attentionOnly || sort !== 'recent';
  const pinned = useMemo(() => visible.filter((p) => p.pinned), [visible]);
  const rest = useMemo(
    () => (searching ? visible : visible.filter((p) => !p.pinned)),
    [searching, visible],
  );

  const onNewProject = () =>
    toast({ title: 'New project', description: 'Coming soon.', tone: 'info' });

  function renderGroup(group: ProjectConsoleItem[]) {
    if (view === 'list') return <ProjectList items={group} now={now} onTogglePin={toggle} />;
    return (
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(326px,1fr))]">
        {group.map((p) => (
          <ProjectCard key={p.id} project={p} now={now} onTogglePin={toggle} />
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1240px] px-6 py-6">
      {isError ? (
        <ErrorState
          title="Couldn't load projects"
          message={formatApiError(error)}
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(326px,1fr))]">
          {Array.from({ length: 6 }).map((_, i) => (
            // eslint-disable-next-line react/no-array-index-key -- static skeletons
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No projects yet"
          message="Projects you own or are a member of will appear here."
        />
      ) : (
        <>
          <StatsBand totals={totals} />
          <ProjectsToolbar
            query={query}
            onQuery={setQuery}
            sort={sort}
            onSort={setSort}
            view={view}
            onView={setView}
            onNewProject={onNewProject}
          />
          <AttentionBanner
            count={attentionCount}
            attentionOnly={attentionOnly}
            onToggle={() => setAttentionOnly((a) => !a)}
          />

          {!searching && pinned.length > 0 && (
            <div className="mb-5">
              <SectionLabel icon="star" iconClassName="text-amber" count={pinned.length}>
                Pinned
              </SectionLabel>
              {renderGroup(pinned)}
            </div>
          )}

          {!searching && <SectionLabel icon="folder" count={rest.length}>All projects</SectionLabel>}

          {rest.length > 0 ? (
            renderGroup(rest)
          ) : (
            <div className="px-10 py-10 text-center text-[13.5px] text-subtle">
              No projects match your filters.
            </div>
          )}

          {view === 'cards' && !searching && (
            <div className="mt-3.5 grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(326px,1fr))]">
              <NewProjectTile onClick={onNewProject} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

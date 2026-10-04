'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  type IconName,
  Kicker,
  PageContainer,
  PageTitle,
  ProjectCardSkeleton,
  Stat,
} from '@/design';
import { useActiveOrg } from '@/features/orgs/active-org';
import { formatApiError } from '@/lib/api/error';
import { filterProjects, formatSpend, isAttention, sortProjects } from '../derive';
import { useProjectsConsole } from '../hooks';
import type { ProjectConsoleItem, ProjectSort, ProjectView, WorkspaceTotals } from '../types';
import { NewProjectDialog } from './new-project-dialog';
import { ProjectCard } from './project-card';
import { ProjectList } from './project-list';
import { ProjectsToolbar } from './projects-toolbar';

const GRID = 'grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(326px,1fr))]';
const SKELETONS = ['a', 'b', 'c', 'd', 'e', 'f'];

export function ProjectsConsole() {
  const { items, totals, isLoading, isError, error, refetch, toggle } = useProjectsConsole();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const onNewProject = () => setCreateOpen(true);

  // The rail switcher's "New project" deep-links here with `?new=1`. Honour it,
  // then strip the param so a refresh/back doesn't reopen the dialog. `/` is the
  // Overview dashboard (ISS-355), so replace to `/projects`.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setCreateOpen(true);
      router.replace('/projects');
    }
  }, [searchParams, router]);

  return (
    <PageContainer>
      {isError ? (
        <ErrorState title="Couldn't load projects" message={formatApiError(error)} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className={GRID}>
          {SKELETONS.map((k) => (
            <ProjectCardSkeleton key={k} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No projects yet"
          message="Projects you own or are a member of will appear here."
          action={{ label: 'New project', onClick: onNewProject }}
        />
      ) : (
        <ConsoleBody items={items} totals={totals} onTogglePin={toggle} onNewProject={onNewProject} />
      )}
      <NewProjectDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </PageContainer>
  );
}

function ConsoleBody({
  items,
  totals,
  onTogglePin,
  onNewProject,
}: {
  items: ProjectConsoleItem[];
  totals: WorkspaceTotals;
  onTogglePin: (id: string) => void;
  onNewProject: () => void;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [view, setView] = useState<ProjectView>('cards');
  const [attentionOnly, setAttentionOnly] = useState(false);
  // The console is HARD-SCOPED to the global active org (ISS-469/470), never a
  // local filter, so the chrome and the console cannot contradict. null only
  // while orgs load → show all for one tick (no flash of empty), then scope.
  const { activeOrg, activeOrgId } = useActiveOrg();
  const scopeLabel = activeOrg ? (activeOrg.isPersonal ? 'Personal' : activeOrg.name) : null;

  // Relative timestamps: 0 on the server + first paint (renders "just now"),
  // then the real clock after mount — hydration-safe.
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Date.now()), []);

  const attentionCount = useMemo(() => items.filter(isAttention).length, [items]);
  const visible = useMemo(
    () => sortProjects(filterProjects(items, query, attentionOnly, activeOrgId), sort),
    [items, query, attentionOnly, sort, activeOrgId],
  );

  return (
    <>
      <PageTitle>{scopeLabel ? `${scopeLabel} · projects` : 'Projects'}</PageTitle>
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
      {attentionCount > 0 && (
        <div className="mb-4">
          <Banner
            tone="attention"
            action={
              <Button variant="ghost" size="sm" onClick={() => setAttentionOnly((a) => !a)}>
                {attentionOnly ? 'Show all' : 'Show only these'}
              </Button>
            }
          >
            <strong className="font-semibold">
              {attentionCount} {attentionCount === 1 ? 'project' : 'projects'}
            </strong>{' '}
            need attention — blocked runs or offline runners.
          </Banner>
        </div>
      )}
      <ProjectSections
        visible={visible}
        // Org scope is the ambient workspace, not a search: it keeps the pinned section.
        searching={query.trim() !== '' || attentionOnly || sort !== 'recent'}
        view={view}
        now={now}
        onTogglePin={onTogglePin}
        scopeLabel={scopeLabel}
        onNewProject={onNewProject}
      />
    </>
  );
}

/** While searching, filtering or sorting, pinned rows join one flat result list,
 *  so a pinned match is never hidden from the rest. */
function ProjectSections({
  visible,
  searching,
  view,
  now,
  onTogglePin,
  scopeLabel,
  onNewProject,
}: {
  visible: ProjectConsoleItem[];
  searching: boolean;
  view: ProjectView;
  now: number;
  onTogglePin: (id: string) => void;
  scopeLabel: string | null;
  onNewProject: () => void;
}) {
  const pinned = visible.filter((p) => p.pinned);
  const rest = searching ? visible : visible.filter((p) => !p.pinned);
  const group = (rows: ProjectConsoleItem[]) =>
    view === 'list' ? (
      <ProjectList items={rows} now={now} onTogglePin={onTogglePin} />
    ) : (
      <div className={GRID}>
        {rows.map((p) => (
          <ProjectCard key={p.id} project={p} now={now} onTogglePin={onTogglePin} />
        ))}
      </div>
    );

  return (
    <>
      {!searching && pinned.length > 0 && (
        <div className="mb-5">
          <SectionLabel icon="star" iconClassName="text-amber" count={pinned.length}>
            Pinned
          </SectionLabel>
          {group(pinned)}
        </div>
      )}
      {!searching && (
        <SectionLabel icon="folder" count={rest.length}>
          All projects
        </SectionLabel>
      )}
      {rest.length > 0 ? (
        group(rest)
      ) : (
        <div className="px-10 py-10 text-center text-13-5 text-subtle">
          {searching ? 'No projects match your filters.' : `No projects in ${scopeLabel ?? 'this organization'} yet.`}
        </div>
      )}
      {view === 'cards' && !searching && (
        <div className={`mt-3.5 ${GRID}`}>
          <button
            type="button"
            onClick={onNewProject}
            className="group flex min-h-[156px] flex-col items-center justify-center gap-2.5 rounded-lg border-[1.5px] border-dashed border-line-strong text-muted transition-colors hover:border-accent hover:bg-accent-tint hover:text-accent-text"
          >
            <span className="flex size-[38px] items-center justify-center rounded-md bg-sunken transition-colors group-hover:bg-surface">
              <Icon name="plus" size={22} className="text-subtle group-hover:text-accent" />
            </span>
            <span className="text-sm font-semibold">New project</span>
          </button>
        </div>
      )}
    </>
  );
}

function SectionLabel({
  icon,
  iconClassName = 'text-subtle',
  count,
  children,
}: {
  icon: IconName;
  iconClassName?: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="mx-0.5 mb-3 mt-1 flex items-center gap-2">
      <Icon name={icon} size={15} className={iconClassName} />
      <Kicker>{children}</Kicker>
      <span className="font-mono text-11 text-subtle">{count}</span>
    </div>
  );
}

function StatsBand({ totals }: { totals: WorkspaceTotals }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-[18px] py-[13px] shadow-sm">
      <span className="text-13-5 font-bold text-fg">Workspace</span>
      <span className="h-4 w-px bg-line" aria-hidden />
      <Stat icon="folder">{totals.projects} projects</Stat>
      <span
        className="inline-flex items-center gap-1.5 font-mono text-12-5 text-accent-text"
        title="Pipeline runs currently running or paused"
      >
        <span className="forge-pulse inline-block size-[7px] rounded-pill bg-accent" aria-hidden />
        {totals.liveRuns} live runs
      </span>
      <Stat icon="inbox" title="In-flight issues (not closed)">
        {totals.openIssues} active
      </Stat>
      <Stat icon="server">{totals.runners} runners</Stat>
      <Stat icon="dollar" title="Trailing 24h spend">
        {formatSpend(totals.spend24hUsd)} / 24h
      </Stat>
    </div>
  );
}

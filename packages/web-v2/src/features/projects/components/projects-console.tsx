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
import { useCopy } from '@/lib/i18n/interface-language';
import { filterProjects, formatSpend, isAttention, sortProjects } from '../derive';
import { useProjectsConsole } from '../hooks';
import type { ProjectConsoleItem, ProjectSort, ProjectView, WorkspaceTotals } from '../types';
import { NewProjectDialog } from './new-project-dialog';
import { ProjectCard } from './project-card';
import { ProjectList } from './project-list';
import { ProjectsToolbar } from './projects-toolbar';

const GRID = 'grid gap-x-8 gap-y-4 [grid-template-columns:repeat(auto-fill,minmax(326px,1fr))]';
const SKELETONS = ['a', 'b', 'c', 'd', 'e', 'f'];

export function ProjectsConsole() {
  const t = useCopy();
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
        <ErrorState title={t('projects.loadFailed')} message={formatApiError(error)} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className={GRID}>
          {SKELETONS.map((k) => (
            <ProjectCardSkeleton key={k} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState message={t('projects.noProjects')} action={{ label: t('projects.new'), onClick: onNewProject }} />
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
  const t = useCopy();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [view, setView] = useState<ProjectView>('cards');
  const [attentionOnly, setAttentionOnly] = useState(false);
  // The console is HARD-SCOPED to the global active org (ISS-469/470), never a
  // local filter, so the chrome and the console cannot contradict. null only
  // while orgs load → show all for one tick (no flash of empty), then scope.
  const { activeOrg, activeOrgId } = useActiveOrg();
  const scopeLabel = activeOrg ? (activeOrg.isPersonal ? t('projects.form.personal') : activeOrg.name) : null;

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
      <PageTitle>{scopeLabel ? t('projects.titleIn', { scope: scopeLabel }) : t('projects.title')}</PageTitle>
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
                {attentionOnly ? t('projects.attention.showAll') : t('projects.attention.only')}
              </Button>
            }
          >
            {t('projects.attention.count', { n: attentionCount })}
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
  onNewProject,
}: {
  visible: ProjectConsoleItem[];
  searching: boolean;
  view: ProjectView;
  now: number;
  onTogglePin: (id: string) => void;
  onNewProject: () => void;
}) {
  const t = useCopy();
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
            {t('projects.pinned')}
          </SectionLabel>
          {group(pinned)}
        </div>
      )}
      {!searching && (
        <SectionLabel icon="folder" count={rest.length}>
          {t('projects.all')}
        </SectionLabel>
      )}
      {rest.length > 0 ? (
        group(rest)
      ) : (
        <div className="px-10 py-10 text-center text-13-5 text-subtle">
          {searching ? t('projects.noMatches') : t('projects.noProjects')}
        </div>
      )}
      {view === 'cards' && !searching && (
        <div className={`mt-3.5 ${GRID}`}>
          <button
            type="button"
            onClick={onNewProject}
            className="group flex min-h-[156px] flex-col items-center justify-center gap-2.5 border-t border-dashed border-line-strong text-muted transition-colors hover:border-accent hover:bg-accent-tint hover:text-accent-text"
          >
            <span className="flex size-[38px] items-center justify-center rounded-md bg-sunken transition-colors group-hover:bg-surface">
              <Icon name="plus" size={22} className="text-subtle group-hover:text-accent" />
            </span>
            <span className="text-sm font-semibold">{t('projects.new')}</span>
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
  const t = useCopy();
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line-subtle pb-3">
      <span className="text-13-5 font-bold text-fg">{t('projects.workspace')}</span>
      <span className="h-4 w-px bg-line" aria-hidden />
      <Stat icon="folder">{t('projects.count', { n: totals.projects })}</Stat>
      <span className="inline-flex items-center gap-1.5 font-mono text-12-5 text-accent-text">
        <span className="forge-pulse inline-block size-[7px] rounded-pill bg-accent" aria-hidden />
        {t('projects.liveRuns', { n: totals.liveRuns })}
      </span>
      <Stat icon="inbox" title={t('projects.openIssues')}>
        {t('projects.activeCount', { n: totals.openIssues })}
      </Stat>
      <Stat icon="server">{t('projects.runnersCount', { n: totals.runners })}</Stat>
      <Stat icon="dollar" title={t('projects.spend24h')}>
        {t('projects.spendPerDay', { spend: formatSpend(totals.spend24hUsd) })}
      </Stat>
    </div>
  );
}

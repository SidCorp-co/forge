'use client';

// cm:guard the five sections render in the issue's reading order — alive, where the work sits, what needs someone, the flow, the output — and that order IS the requirement: reordering them to suit a layout answers the questions in an order nobody asked for (ISS-988 criterion 25).
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, ErrorState, PageContainer, Skeleton } from '@/design';
import { useActiveOrg } from '@/features/orgs/active-org';
import { useProjectsConsole } from '@/features/projects/hooks';
import { formatApiError } from '@/lib/api/error';
import { usePulse } from '../hooks';
import { ActionQueue } from './action-queue';
import { FlowSection } from './flow-section';
import { LivenessBand } from './liveness-band';
import { QualitySection } from './quality-section';
import { WorkSitting } from './work-sitting';

export function OverviewScreen() {
  const router = useRouter();
  const { activeOrg, activeOrgId } = useActiveOrg();
  const pulse = usePulse(activeOrgId ?? undefined);
  // cm:why the pulse response counts projects but cannot say whether OTHER orgs hold any, which is what separates "welcome to Forge" from "this org is empty" — so the console list is read for that one distinction and nothing else
  const { items: allItems } = useProjectsConsole();

  // cm:guard `nowMs` stays 0 until after mount: every age on this screen is derived from it, and reading the real clock during render makes the server's HTML and the first client paint disagree on every figure (hydration mismatch).
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => setNowMs(Date.now()), []);

  const orgLabel = activeOrg ? (activeOrg.isPersonal ? 'Personal' : activeOrg.name) : null;
  const data = pulse.data;
  const hasProjects = useMemo(() => (data ? data.work.perProject.length > 0 : false), [data]);

  if (pulse.isError) {
    return (
      <PageContainer>
        <ErrorState
          title="Couldn't load your workspace"
          message={formatApiError(pulse.error)}
          onRetry={() => pulse.refetch()}
        />
      </PageContainer>
    );
  }

  if (pulse.isLoading || !data) {
    return (
      <PageContainer className="flex flex-col gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full rounded-lg" />
        ))}
      </PageContainer>
    );
  }

  if (!hasProjects) {
    const hasAnyProjects = allItems.length > 0;
    return (
      <PageContainer className="grid min-h-[60vh] place-items-center">
        <EmptyState
          title={
            hasAnyProjects
              ? `No projects in ${orgLabel ?? 'this organization'} yet`
              : 'Welcome to Forge'
          }
          message={
            hasAnyProjects
              ? 'Create a project in this organization, or switch organizations from the chrome to see others.'
              : 'Create your first project to start shipping issues through the pipeline. This dashboard fills in as work flows.'
          }
          action={{ label: 'New project', onClick: () => router.push('/projects?new=1') }}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-4">
      <header>
        <h1 className="fg-h2">Overview{orgLabel ? ` · ${orgLabel}` : ''}</h1>
        <p className="fg-body-sm mt-0.5 text-muted">
          What the control plane is doing across {orgLabel ?? 'your organization'}.
        </p>
      </header>

      <LivenessBand liveness={data.liveness} thresholds={data.thresholds} />
      <WorkSitting pulse={data} nowMs={nowMs} />
      <ActionQueue pulse={data} nowMs={nowMs} />
      <FlowSection flow={data.flow} />
      <QualitySection quality={data.quality} />
    </PageContainer>
  );
}

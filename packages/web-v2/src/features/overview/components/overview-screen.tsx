'use client';
import { PageTitle } from "@/design";

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, ErrorState, PageContainer, Skeleton } from '@/design';
import { useActiveOrg } from '@/features/orgs/active-org';
import { useOrgProjects } from '@/features/orgs/hooks';
import { workspaceName } from '@/features/orgs/workspace-name';
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
  const { items: allItems } = useProjectsConsole();

  const [nowMs, setNowMs] = useState(0);
  useEffect(() => setNowMs(Date.now()), []);

  const orgLabel = activeOrg ? workspaceName(activeOrg) : null;
  const data = pulse.data;
  const hasProjects = useMemo(() => (data ? data.work.perProject.length > 0 : false), [data]);
  // Read only where the reader sees none of its projects: what the organization holds is then the news.
  const orgProjects = useOrgProjects(
    data && !hasProjects && activeOrg && !activeOrg.isPersonal ? (activeOrgId ?? undefined) : undefined,
  );

  if (pulse.isError) {
    return (
      <PageContainer>
        <ErrorState
          level={1}
          title="Couldn't load your workspace"
          message={formatApiError(pulse.error)}
          onRetry={() => pulse.refetch()}
        />
      </PageContainer>
    );
  }

  if (pulse.isLoading || !data || orgProjects.isLoading) {
    return (
      <PageContainer className="flex flex-col gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full rounded-lg" />
        ))}
      </PageContainer>
    );
  }

  if (!hasProjects) {
    const said = noProjectSaid({
      orgLabel,
      seesProjectsElsewhere: allItems.length > 0,
      unseen: orgProjects.isError ? null : (orgProjects.data ?? []).filter((p) => p.archivedAt === null).length,
    });
    // Any member of an organization may start a project in it, so New project is never an act refused.
    return (
      <PageContainer className="grid min-h-[60vh] place-items-center">
        <EmptyState
          level={1}
          title={said.title}
          message={said.message}
          action={{ label: 'New project', onClick: () => router.push('/projects?new=1'), icon: 'plus' }}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-6">
      <header>
        <PageTitle className="fg-h2">Overview{orgLabel ? ` · ${orgLabel}` : ''}</PageTitle>
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

/** What the Overview says to a reader with no project here, never that the organization holds none (r38). */
export function noProjectSaid({
  orgLabel,
  seesProjectsElsewhere,
  unseen,
}: {
  orgLabel: string | null;
  seesProjectsElsewhere: boolean;
  /** The organization's unarchived projects; null where they could not be read. */
  unseen: number | null;
}): { title: string; message: string } {
  const org = orgLabel ?? 'this organization';
  if (unseen === null) {
    return {
      title: `No project in ${org} you can see`,
      message: 'An admin of a project can add you to it, or you can start a project of your own.',
    };
  }
  if (unseen > 0) {
    const held = unseen === 1 ? 'holds 1 project' : `holds ${unseen} projects`;
    return {
      title: `No project in ${org} you can see`,
      message: `${org} ${held}, and you hold a role on ${unseen === 1 ? 'none' : 'none of them'}. An admin of a project can add you to it, or you can start a project of your own.`,
    };
  }
  if (seesProjectsElsewhere) {
    return {
      title: `No projects in ${org} yet`,
      message: 'Create a project in this organization, or switch organizations from the chrome to see others.',
    };
  }
  return {
    title: 'Welcome to Forge',
    message:
      'Create your first project to start shipping issues through the pipeline. This dashboard fills in as work flows.',
  };
}

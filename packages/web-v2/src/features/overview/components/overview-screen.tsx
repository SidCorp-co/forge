'use client';
import { PageTitle } from "@/design";

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, ErrorState, PageContainer, Skeleton } from '@/design';
import { useActiveOrg } from '@/features/orgs/active-org';
import { useProjectsConsole } from '@/features/projects/hooks';
import { formatApiError } from '@/lib/api/error';
import { useCopy } from '@/lib/i18n/interface-language';
import { usePulse } from '../hooks';
import { ActionQueue } from './action-queue';
import { FlowFigures } from './flow-section';
import { LivenessBand } from './liveness-band';
import { QualityFigures } from './quality-section';
import { WorkSitting } from './work-sitting';

export function OverviewScreen() {
  const router = useRouter();
  const { activeOrg, activeOrgId } = useActiveOrg();
  const pulse = usePulse(activeOrgId ?? undefined);
  const { items: allItems } = useProjectsConsole();
  const t = useCopy();

  const [nowMs, setNowMs] = useState(0);
  useEffect(() => setNowMs(Date.now()), []);

  const orgLabel = activeOrg ? (activeOrg.isPersonal ? t('overview.personal') : activeOrg.name) : null;
  const data = pulse.data;
  const hasProjects = useMemo(() => (data ? data.work.perProject.length > 0 : false), [data]);

  if (pulse.isError) {
    return (
      <PageContainer>
        <ErrorState
          title={t('overview.loadFailed')}
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
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length placeholder list that never reorders
          <Skeleton key={i} className="h-40 w-full rounded-md" />
        ))}
      </PageContainer>
    );
  }

  if (!hasProjects) {
    const hasAnyProjects = allItems.length > 0;
    return (
      <PageContainer className="grid min-h-96 place-items-center">
        <EmptyState
          message={hasAnyProjects ? t('overview.noProjectsIn') : t('overview.welcome')}
          action={{ label: t('overview.newProject'), onClick: () => router.push('/projects?new=1') }}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-4">
      <PageTitle>
          {t('overview.title')}{orgLabel ? ` · ${orgLabel}` : ''}
      </PageTitle>

      <LivenessBand liveness={data.liveness} thresholds={data.thresholds} />
      <WorkSitting pulse={data} nowMs={nowMs} />
      <ActionQueue pulse={data} />
      <FlowFigures flow={data.flow} />
      <QualityFigures quality={data.quality} />
    </PageContainer>
  );
}

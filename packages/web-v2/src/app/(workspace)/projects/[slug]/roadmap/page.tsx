"use client";

import { ErrorState, PageContainer, PageTitle, ProjectLoader } from "@/design";
import { useEtaClock } from "@/features/forecast/hooks";
import { Roadmap } from "@/features/project-status/components/status-report";
import { useProjectStatus } from "@/features/project-status/hooks";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { formatApiError } from "@/lib/api/error";
import { formatDateTime } from "@/lib/i18n/format";
import { useCopy } from "@/lib/i18n/interface-language";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";

/** The roadmap (JU-10): Now, Next and Later, derived in core from each requirement's state; no field of its own. */
function RoadmapPage({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const clock = useEtaClock();
  const q = useProjectStatus(projectId);
  useRoom(projectRoom(projectId));
  if (q.isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title={t("roadmap.loadFailed")} message={formatApiError(q.error)} onRetry={() => q.refetch()} />
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label={t("roadmap.loading")} />
      </div>
    );
  }
  return (
    <PageContainer className="max-w-[1100px]">
      <div className="grid gap-6" data-testid="roadmap-page">
        <div className="grid gap-1">
          <PageTitle>{t("roadmap.title")}</PageTitle>
          <p className="text-12-5 text-muted">{t("status.readAt", { at: formatDateTime(q.data.roadmap.asOf, clock.lang, clock.timeZone) })}</p>
        </div>
        <Roadmap s={q.data} slug={slug} clock={clock} rules />
      </div>
    </PageContainer>
  );
}

export default function ProjectRoadmapPage() {
  const t = useCopy();
  return <ProjectRefGate label={t("roadmap.loading")}>{(p) => <RoadmapPage projectId={p.ref} slug={p.slug} />}</ProjectRefGate>;
}

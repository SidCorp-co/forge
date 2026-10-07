"use client";

import { ErrorState, PageContainer, ProjectLoader, useUrlChoice } from "@/design";
import { useEtaClock } from "@/features/forecast/hooks";
import { STATUS_WINDOWS, StatusReport } from "@/features/project-status/components/status-report";
import { useProjectStatus } from "@/features/project-status/hooks";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";

function Report({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const clock = useEtaClock();
  const [window, setWindow] = useUrlChoice("days", STATUS_WINDOWS, "7");
  const q = useProjectStatus(projectId, Number(window));
  useRoom(projectRoom(projectId));
  if (q.isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title={t("status.loadFailed")} message={formatApiError(q.error)} onRetry={() => q.refetch()} />
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label={t("status.loading")} />
      </div>
    );
  }
  return (
    <PageContainer className="max-w-[1100px]">
      <StatusReport s={q.data} slug={slug} clock={clock} window={window} onWindow={setWindow} />
    </PageContainer>
  );
}

export default function ProjectStatusPage() {
  const t = useCopy();
  return <ProjectRefGate label={t("status.loading")}>{(p) => <Report projectId={p.ref} slug={p.slug} />}</ProjectRefGate>;
}

"use client";

import { Button, ErrorState, PageContainer, ProjectLoader, Tabs, useUrlChoice } from "@/design";
import { useEtaClock } from "@/features/forecast/hooks";
import { StatusHistory } from "@/features/project-status/components/status-history";
import { STATUS_WINDOWS, StatusReport } from "@/features/project-status/components/status-report";
import { TemplateRun } from "@/features/project-status/components/template-run";
import { useProjectStatus, useSaveStatusReport } from "@/features/project-status/hooks";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { canManageProject } from "@/features/projects/write-access";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";

const STATUS_TABS = ["report", "templates", "history"] as const;

function SaveReport({ projectId, days }: { projectId: string; days: number }) {
  const t = useCopy();
  const [, setTab] = useUrlChoice("tab", STATUS_TABS, "report");
  const save = useSaveStatusReport(projectId);
  return (
    <Button
      onClick={() => save.mutate(days, { onSuccess: () => setTab("history") })}
      disabled={save.isPending}
      data-testid="status-save"
      title={save.isError ? `${t("status.saveFailed")}: ${formatApiError(save.error)}` : undefined}
    >
      {save.isError ? t("status.saveFailed") : t("status.save")}
    </Button>
  );
}

function Live({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const clock = useEtaClock();
  const [window, setWindow] = useUrlChoice("days", STATUS_WINDOWS, "7");
  const q = useProjectStatus(projectId, Number(window));
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
    <StatusReport
      s={q.data}
      slug={slug}
      clock={clock}
      window={window}
      onWindow={setWindow}
      actions={<SaveReport projectId={projectId} days={Number(window)} />}
    />
  );
}

function Report({ projectId, slug, isAdmin }: { projectId: string; slug: string; isAdmin: boolean }) {
  const t = useCopy();
  const clock = useEtaClock();
  const [tab, setTab] = useUrlChoice("tab", STATUS_TABS, "report");
  useRoom(projectRoom(projectId));
  return (
    <PageContainer className="grid max-w-[1100px] gap-6">
      <div className="print:hidden">
        <Tabs
          tabs={[
            { value: "report", label: t("status.tab.report") },
            { value: "templates", label: t("status.tab.templates") },
            { value: "history", label: t("status.tab.history") },
          ]}
          value={tab}
          onChange={(v) => setTab(v as (typeof STATUS_TABS)[number])}
        />
      </div>
      {tab === "history" ? (
        <StatusHistory projectId={projectId} slug={slug} clock={clock} isAdmin={isAdmin} />
      ) : tab === "templates" ? (
        <TemplateRun projectId={projectId} slug={slug} />
      ) : (
        <Live projectId={projectId} slug={slug} />
      )}
    </PageContainer>
  );
}

export default function ProjectStatusPage() {
  const t = useCopy();
  return <ProjectRefGate label={t("status.loading")}>{(p) => <Report projectId={p.ref} slug={p.slug} isAdmin={p.row ? canManageProject(p.row.role) : false} />}</ProjectRefGate>;
}

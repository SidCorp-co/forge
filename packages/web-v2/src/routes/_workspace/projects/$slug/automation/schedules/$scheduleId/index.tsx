import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { ScheduleItemScreen } from "@/features/automation";
import { canManageProject, canWriteProject } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";

function Page() {
  const t = useCopy();
  const params = useParams<{ scheduleId: string }>();
  const id = decodeURIComponent(params?.scheduleId ?? "");
  return (
    <ProjectGate label={t("schedules.loadingAutomation")}>
      {(p) => (
        <ScheduleItemScreen
          access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role), canManage: canManageProject(p.role) }}
          scheduleId={id}
        />
      )}
    </ProjectGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/automation/schedules/$scheduleId/")({ component: Page });

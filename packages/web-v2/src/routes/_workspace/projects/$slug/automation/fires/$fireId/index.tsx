import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { FireItemScreen } from "@/features/automation";
import { canManageProject, canWriteProject } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";

function Page() {
  const t = useCopy();
  const params = useParams<{ fireId: string }>();
  const id = decodeURIComponent(params?.fireId ?? "");
  return (
    <ProjectGate label={t("schedules.loadingAutomation")}>
      {(p) => (
        <FireItemScreen
          access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role), canManage: canManageProject(p.role) }}
          fireId={id}
        />
      )}
    </ProjectGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/automation/fires/$fireId/")({ component: Page });

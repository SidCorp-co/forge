import { createFileRoute } from "@tanstack/react-router";
import { AutomationScreen } from "@/features/automation";
import { canManageProject, canWriteProject } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";

function ProjectAutomationPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("schedules.loadingAutomation")}>
      {(p) => (
        <AutomationScreen
          access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role), canManage: canManageProject(p.role) }}
        />
      )}
    </ProjectGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/automation/")({ component: ProjectAutomationPage });

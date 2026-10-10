import { createFileRoute } from "@tanstack/react-router";
import { MasterItemScreen } from "@/features/agents";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";
import { canWriteProject } from "@/features/projects";

function Page() {
  const t = useCopy();
  return (
    <ProjectGate label={t("agents.master.loading")}>
      {(p) => <MasterItemScreen access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role) }} />}
    </ProjectGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/agents/master/")({ component: Page });

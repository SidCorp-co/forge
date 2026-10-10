import { createFileRoute } from "@tanstack/react-router";
import { ModulesScreen } from "@/features/modules";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";

function ProjectModulesPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("common.gate.modules")}>
      {(p) => <ModulesScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/modules/")({ component: ProjectModulesPage });

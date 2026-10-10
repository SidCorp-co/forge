import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { ModuleScreen } from "@/features/modules";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";

function ProjectModulePage() {
  const t = useCopy();
  const params = useParams<{ slug: string; module: string }>();
  return (
    <ProjectGate label={t("common.gate.module")}>
      {(p) => <ModuleScreen projectId={p.id} slug={p.slug} moduleSlug={decodeURIComponent(params.module)} />}
    </ProjectGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/modules/$module/")({ component: ProjectModulePage });

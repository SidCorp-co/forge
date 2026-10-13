import { createFileRoute } from "@tanstack/react-router";
import { ReleasesScreen } from "@/features/releases";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

function ProjectReleasesPage() {
  const t = useCopy();
  return (
    <ProjectRefGate label={t("releases.loadingList")}>
      {(p) => <ReleasesScreen projectId={p.ref} slug={p.slug} />}
    </ProjectRefGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/releases/")({ component: ProjectReleasesPage });

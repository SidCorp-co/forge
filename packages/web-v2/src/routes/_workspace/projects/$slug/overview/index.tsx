import { createFileRoute } from "@tanstack/react-router";
import { DevelopmentOverviewScreen } from "@/features/development";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";

function DevelopmentOverviewPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("overview.dev.loading")}>
      {(p) => <DevelopmentOverviewScreen scope={{ projectId: p.id, slug: p.slug }} />}
    </ProjectGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/overview/")({ component: DevelopmentOverviewPage });

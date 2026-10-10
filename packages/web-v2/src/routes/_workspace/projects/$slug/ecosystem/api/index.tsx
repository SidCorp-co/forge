import { createFileRoute } from "@tanstack/react-router";
// A project's API page (`/projects/[slug]/ecosystem/api`); built by `ecosystemRoutes.apiPage`.
import { ApiPageScreen } from "@/features/ecosystem/components/api-page-screen";
import { EcosystemPage } from "@/features/ecosystem/components/ecosystem-page";
import { useCopy } from "@/lib/i18n/interface-language";

function ProjectApiPage() {
  const t = useCopy();
  return (
    <EcosystemPage section="api" title={t("ecosystem.page.api")}>
      {(project) => <ApiPageScreen projectId={project.id} slug={project.slug} />}
    </EcosystemPage>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/ecosystem/api/")({ component: ProjectApiPage });

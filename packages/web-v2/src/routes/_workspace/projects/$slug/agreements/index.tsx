import { createFileRoute } from "@tanstack/react-router";
import { AgreementsScreen } from "@/features/agreements";
import { canManageProject, ProjectGate } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";

function ProjectAgreementsPage() {
  const t = useCopy();
  return <ProjectGate label={t("agreements.loading")}>{(p) => <AgreementsScreen projectId={p.id} slug={p.slug} canManage={canManageProject(p.role)} />}</ProjectGate>;
}

export const Route = createFileRoute("/_workspace/projects/$slug/agreements/")({ component: ProjectAgreementsPage });

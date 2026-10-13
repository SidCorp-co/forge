import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { IssueDetailScreen } from "@/features/issues";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectRefGate } from "@/features/projects/components/project-gate";

function ProjectIssueDetailPage() {
  const t = useCopy();
  const params = useParams<{ slug: string; id: string }>();
  return (
    <ProjectRefGate
      label={t("issues.detail.loading")}
      notFound={{ title: t("common.gate.issueNotFound"), message: t("common.gate.issueNotFoundMessage") }}
    >
      {(p) => <IssueDetailScreen projectId={p.ref} slug={p.slug} id={params.id} />}
    </ProjectRefGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/issues/$id/")({ component: ProjectIssueDetailPage });

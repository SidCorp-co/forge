import { createFileRoute } from "@tanstack/react-router";
import { ApprovalsScreen } from "@/features/approvals";
import { useAttention } from "@/features/attention";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

function ProjectApprovalsPage() {
  const t = useCopy();
  // the decisions waiting across your projects, core's figure the Attention tab carries, named beside this page's own (REQ-48 r3 BC-17)
  const attention = useAttention();
  const across = attention.known ? attention.waitingOnYou : null;
  return (
    <ProjectRefGate label={t("approvals.loading")}>
      {(p) => <ApprovalsScreen projectId={p.ref} slug={p.slug} across={across} />}
    </ProjectRefGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/approvals/")({ component: ProjectApprovalsPage });

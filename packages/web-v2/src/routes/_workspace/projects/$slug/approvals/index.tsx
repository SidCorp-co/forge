import { createFileRoute } from "@tanstack/react-router";
import { ApprovalInbox } from "@/features/approvals";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

function ProjectApprovalsPage() {
  const t = useCopy();
  return (
    <ProjectRefGate label={t("approvals.loading")}>
      {(p) => <ApprovalInbox projectId={p.ref} slug={p.slug} />}
    </ProjectRefGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/approvals/")({ component: ProjectApprovalsPage });

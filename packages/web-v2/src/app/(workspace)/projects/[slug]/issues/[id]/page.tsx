"use client";

import { useParams } from "next/navigation";
import { IssueDetailScreen } from "@/features/issues/components/issue-detail-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectIssueDetailPage() {
  const t = useCopy();
  const params = useParams<{ slug: string; id: string }>();
  return (
    <ProjectGate
      label={t("issues.detail.loading")}
      notFound={{ title: t("common.gate.issueNotFound"), message: t("common.gate.issueNotFoundMessage") }}
    >
      {(p) => <IssueDetailScreen projectId={p.id} slug={p.slug} id={params.id} />}
    </ProjectGate>
  );
}

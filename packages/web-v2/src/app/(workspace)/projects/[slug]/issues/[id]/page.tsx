"use client";

import { useParams } from "next/navigation";
import { IssueDetailScreen } from "@/features/issues/components/issue-detail-screen";
import { ProjectRefGate } from "@/features/projects/components/project-gate";

export default function ProjectIssueDetailPage() {
  const params = useParams<{ slug: string; id: string }>();
  return (
    <ProjectRefGate
      label="loading issue…"
      notFound={{ title: "Issue not found", message: "This project or issue doesn't exist or you don't have access to it." }}
    >
      {(p) => <IssueDetailScreen projectId={p.ref} slug={p.slug} id={params.id} />}
    </ProjectRefGate>
  );
}

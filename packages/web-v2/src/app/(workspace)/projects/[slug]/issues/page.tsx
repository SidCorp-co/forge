"use client";

import { IssuesScreen } from "@/features/issues/components/issues-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectIssuesPage() {
  return (
    <ProjectGate label="loading issues…">
      {(p) => <IssuesScreen scope={{ projectId: p.id, slug: p.slug }} />}
    </ProjectGate>
  );
}

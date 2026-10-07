"use client";

import { IssuesScreen } from "@/features/issues/components/issues-screen";
import { ProjectRefGate } from "@/features/projects/components/project-gate";

export default function ProjectIssuesPage() {
  return (
    <ProjectRefGate label="loading issues…">
      {(p) => <IssuesScreen scope={{ projectId: p.ref, slug: p.slug }} />}
    </ProjectRefGate>
  );
}

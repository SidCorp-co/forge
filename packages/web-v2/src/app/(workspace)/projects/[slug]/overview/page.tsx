"use client";

import { DevelopmentOverviewScreen } from "@/features/development/components/development-overview-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function DevelopmentOverviewPage() {
  return (
    <ProjectGate label="loading the overview…">
      {(p) => <DevelopmentOverviewScreen scope={{ projectId: p.id, slug: p.slug }} />}
    </ProjectGate>
  );
}

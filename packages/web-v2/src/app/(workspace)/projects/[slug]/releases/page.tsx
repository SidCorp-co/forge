"use client";

import { ReleasesScreen } from "@/features/releases/components/releases-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectReleasesPage() {
  return (
    <ProjectGate label="loading releases…">
      {(p) => <ReleasesScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}

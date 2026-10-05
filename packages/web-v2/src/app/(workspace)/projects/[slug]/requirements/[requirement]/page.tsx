"use client";

import { useParams } from "next/navigation";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectRequirementPage() {
  const params = useParams<{ slug: string; requirement: string }>();
  return (
    <ProjectGate label="loading requirement…">
      {(p) => <RequirementScreen projectId={p.id} slug={p.slug} reqKey={decodeURIComponent(params.requirement)} />}
    </ProjectGate>
  );
}

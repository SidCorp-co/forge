"use client";

import { useParams } from "next/navigation";
import { ReleaseItemScreen } from "@/features/releases/components/release-item-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectReleasePage() {
  const params = useParams<{ slug: string; release: string }>();
  return (
    <ProjectGate label="loading release…">
      {(p) => <ReleaseItemScreen projectId={p.id} slug={p.slug} version={decodeURIComponent(params.release)} />}
    </ProjectGate>
  );
}

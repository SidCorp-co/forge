"use client";

import { useParams } from "next/navigation";
import { FireItemScreen } from "@/features/automation/components/automation-item-screens";
import { canManageProject, canWriteProject } from "@/features/projects/write-access";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function Page() {
  const params = useParams<{ fireId: string }>();
  const id = decodeURIComponent(params?.fireId ?? "");
  return (
    <ProjectGate label="loading automation…">
      {(p) => (
        <FireItemScreen
          access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role), canManage: canManageProject(p.role) }}
          fireId={id}
        />
      )}
    </ProjectGate>
  );
}

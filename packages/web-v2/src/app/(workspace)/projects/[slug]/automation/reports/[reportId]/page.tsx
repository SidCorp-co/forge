"use client";

import { useParams } from "next/navigation";
import { ReportItemScreen } from "@/features/automation/components/automation-item-screens";
import { canManageProject, canWriteProject } from "@/features/projects/write-access";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function Page() {
  const params = useParams<{ reportId: string }>();
  const id = decodeURIComponent(params?.reportId ?? "");
  return (
    <ProjectGate label="loading automation…">
      {(p) => (
        <ReportItemScreen
          access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role), canManage: canManageProject(p.role) }}
          reportId={id}
        />
      )}
    </ProjectGate>
  );
}

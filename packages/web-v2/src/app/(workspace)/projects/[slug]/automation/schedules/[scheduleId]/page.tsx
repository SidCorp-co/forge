"use client";

import { useParams } from "next/navigation";
import { ScheduleItemScreen } from "@/features/automation/components/automation-item-screens";
import { canManageProject, canWriteProject } from "@/features/projects/write-access";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function Page() {
  const params = useParams<{ scheduleId: string }>();
  const id = decodeURIComponent(params?.scheduleId ?? "");
  return (
    <ProjectGate label="loading automation…">
      {(p) => (
        <ScheduleItemScreen
          access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role), canManage: canManageProject(p.role) }}
          scheduleId={id}
        />
      )}
    </ProjectGate>
  );
}

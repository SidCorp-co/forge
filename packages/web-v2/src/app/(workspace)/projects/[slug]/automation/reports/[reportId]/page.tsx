"use client";

import { useParams } from "next/navigation";
import { ReportItemScreen } from "@/features/automation/components/automation-item-screens";
import { canManageProject, canWriteProject } from "@/features/projects/write-access";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function Page() {
  const t = useCopy();
  const params = useParams<{ reportId: string }>();
  const id = decodeURIComponent(params?.reportId ?? "");
  return (
    <ProjectGate label={t("schedules.loadingAutomation")}>
      {(p) => (
        <ReportItemScreen
          access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role), canManage: canManageProject(p.role) }}
          reportId={id}
        />
      )}
    </ProjectGate>
  );
}

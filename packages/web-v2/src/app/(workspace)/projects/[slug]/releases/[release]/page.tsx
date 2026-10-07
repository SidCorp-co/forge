"use client";

import { useParams } from "next/navigation";
import { ReleaseItemScreen } from "@/features/releases/components/release-item-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

export default function ProjectReleasePage() {
  const t = useCopy();
  const params = useParams<{ slug: string; release: string }>();
  return (
    <ProjectGate label={t("releases.loadingOne")}>
      {(p) => <ReleaseItemScreen projectId={p.id} slug={p.slug} version={decodeURIComponent(params.release)} />}
    </ProjectGate>
  );
}

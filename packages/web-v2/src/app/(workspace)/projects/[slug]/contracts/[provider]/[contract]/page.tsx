"use client";

import { useParams } from "next/navigation";
import { ContractScreen } from "@/features/contracts/components/contract-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectContractPage() {
  const t = useCopy();
  const params = useParams<{ slug: string; provider: string; contract: string }>();
  return (
    <ProjectGate label={t("common.gate.contract")}>
      {(p) => (
        <ContractScreen
          projectId={p.id}
          slug={p.slug}
          contractRef={`${decodeURIComponent(params.provider)}/${decodeURIComponent(params.contract)}`}
        />
      )}
    </ProjectGate>
  );
}

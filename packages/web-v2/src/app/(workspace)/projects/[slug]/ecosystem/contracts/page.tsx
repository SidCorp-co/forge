"use client";

import { useParams } from "next/navigation";
import { ContractsScreen } from "@/features/ecosystem/components/contracts-screen";
import { EcosystemPage } from "@/features/ecosystem/components/ecosystem-page";

export default function ContractsPage() {
  const params = useParams<{ slug: string }>();
  return (
    <EcosystemPage slug={params?.slug} section="contracts" title="Contracts">
      {(project) => <ContractsScreen projectId={project.id} slug={project.slug} />}
    </EcosystemPage>
  );
}

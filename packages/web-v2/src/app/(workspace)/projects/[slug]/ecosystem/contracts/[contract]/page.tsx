"use client";

// One contract's versions and measurements (`/projects/[slug]/ecosystem/contracts/[contract]`),
// the project's own, or with `?provider=` a provider's it consumes; built by `ecosystemRoutes.contract`.
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ContractScreen } from "@/features/ecosystem/components/contracts-screen";
import { EcosystemPage } from "@/features/ecosystem/components/ecosystem-page";

function Contract() {
  const params = useParams<{ slug: string; contract: string }>();
  const provider = useSearchParams()?.get("provider") || undefined;
  const contract = params?.contract ? decodeURIComponent(params.contract) : "";
  return (
    <EcosystemPage slug={params?.slug} section="contracts" title={contract}>
      {(project) => (
        <ContractScreen projectId={project.id} slug={project.slug} contract={contract} provider={provider} />
      )}
    </EcosystemPage>
  );
}

export default function ContractPage() {
  return (
    <Suspense fallback={null}>
      <Contract />
    </Suspense>
  );
}

"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BusScreen } from "@/features/ecosystem/components/bus-screen";
import { EcosystemPage } from "@/features/ecosystem/components/ecosystem-page";

function Ecosystem() {
  const params = useParams<{ slug: string }>();
  const search = useSearchParams();
  return (
    <EcosystemPage slug={params?.slug} section="bus" title="Ecosystem">
      {(project) => <BusScreen project={project} rawEcosystem={search?.get("ecosystem") ?? null} />}
    </EcosystemPage>
  );
}

export default function EcosystemBusPage() {
  return (
    <Suspense fallback={null}>
      <Ecosystem />
    </Suspense>
  );
}

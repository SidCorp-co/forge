"use client";

// One ecosystem's bus (`/ecosystems/[id]`): members across, contracts down, the detail of the pick below; built by `ecosystemRoutes.ecosystem`.
import { useParams } from "next/navigation";
import { EcosystemScreen } from "@/features/ecosystem/components/ecosystem-screen";

export default function EcosystemPage() {
  const params = useParams<{ id: string }>();
  return params?.id ? <EcosystemScreen key={params.id} ecosystemId={decodeURIComponent(params.id)} /> : null;
}

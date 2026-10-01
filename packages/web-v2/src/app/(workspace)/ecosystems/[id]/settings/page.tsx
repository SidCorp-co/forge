"use client";

// The steward's settings for one ecosystem (`/ecosystems/[id]/settings`); built by `ecosystemRoutes.settings`.
import { useParams } from "next/navigation";
import { PageContainer } from "@/design";
import { EcosystemSettingsScreen } from "@/features/ecosystem/components/ecosystem-form";

export default function EcosystemSettingsPage() {
  const params = useParams<{ id: string }>();
  return (
    <PageContainer className="min-w-0">
      {params?.id ? <EcosystemSettingsScreen ecosystemId={decodeURIComponent(params.id)} /> : null}
    </PageContainer>
  );
}

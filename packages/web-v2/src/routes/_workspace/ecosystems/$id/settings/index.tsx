import { createFileRoute } from "@tanstack/react-router";
// The steward's settings for one ecosystem (`/ecosystems/[id]/settings`); built by `ecosystemRoutes.settings`.
import { useParams } from "@/lib/navigation/router";
import { PageContainer } from "@/design";
import { EcosystemSettingsScreen } from "@/features/ecosystem/components/ecosystem-form";

function EcosystemSettingsPage() {
  const params = useParams<{ id: string }>();
  return (
    <PageContainer className="min-w-0">
      {params?.id ? <EcosystemSettingsScreen ecosystemId={decodeURIComponent(params.id)} /> : null}
    </PageContainer>
  );
}

export const Route = createFileRoute("/_workspace/ecosystems/$id/settings/")({ component: EcosystemSettingsPage });
